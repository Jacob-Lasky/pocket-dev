package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"tailscale.com/client/local"
	"tailscale.com/tsnet"
)

// defaultDNSCacheTTL is how long a positive A/AAAA result from the tsnet
// LocalAPI dns-query endpoint is reused before re-querying. Set well
// under typical authoritative TTLs (consul defaults to 0 / very low so a
// dropped-and-replaced service IP propagates within this window), and
// short enough that operator-triggered re-registrations are visible.
// Negative results are NOT cached, so NXDOMAIN-state is always re-fetched.
const defaultDNSCacheTTL = 30 * time.Second

// errNoTailnetDNSAnswer is returned when tsnet's internal DNS resolver
// produced a response with no A/AAAA records. Distinct from a transport
// error so callers can distinguish NXDOMAIN-like outcomes from "couldn't
// reach the resolver."
var errNoTailnetDNSAnswer = errors.New("tsnet DNS: no A/AAAA answer")

// resolverFunc resolves a hostname to a single IP via the tailnet's
// internal DNS resolver. Parameterized so tests can substitute a fake
// without standing up a real tsnet.Server + LocalAPI Unix socket.
type resolverFunc func(ctx context.Context, host string) (netip.Addr, error)

// dialFunc matches the signature of tsnet.Server.Dial and Go's stdlib
// DialContext. Parameterizing on this interface (rather than
// *tsnet.Server directly) lets the unit tests fake the actual TCP dial
// without instantiating a tailnet.
type dialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// startProxy stands up an HTTP proxy listening on localhost:port that
// tunnels traffic via the given tsnet.Server's tailnet identity.
//
// Supports two proxy modes the way `undici.ProxyAgent` and curl use them:
//
//  1. CONNECT method ("https://..." targets, raw TCP tunneling). The
//     request line carries `CONNECT host:port HTTP/1.1`, we hijack the
//     conn after a 200 OK and bridge bytes to a tailnet dial of that host.
//  2. Absolute-form forward proxy ("http://..." plaintext targets). The
//     request line carries the full upstream URL, we re-issue the request
//     via an http.Client whose Transport.DialContext is the tailnet
//     dialer. Hop-by-hop headers (RFC 7230 §6.1) are stripped in both
//     directions.
//
// Why this matters: undici picks CONNECT for HTTPS and absolute-form GET
// for plain HTTP. Without (2), a fetch to an internal HTTP service (e.g.
// `http://request-raid.service.awsw2.consul:9008`) returns 405 from the
// proxy. Both modes are needed so any client a `dgvpn`-prefixed command
// spawns (curl, undici, python-requests) works the same way.
//
// Why localhost-only: the proxy binds 127.0.0.1 and is reached only by
// processes inside this container that opt in via HTTP_PROXY (the `dgvpn`
// wrapper). Nothing else can route to it, so the proxy itself carries no
// auth; the security boundary is the tailnet identity behind it.
//
// Why suffix routing (see routeBySuffix): only hosts matching a tailnet
// suffix (`.consul` by default) take the tunnel; everything else dials
// directly on the container's normal network. Two reasons. First, this
// userspace tsnet has no exit node, so routing public traffic through it
// would just fail. Second, it makes `dgvpn` a safe prefix for ANY command:
// public egress is untouched, only internal Deepgram targets tunnel. This
// is the in-proxy equivalent of deephive's url_routes_via_tailscale gate.
//
// Why we wrap ts.Dial with our own dialer instead of using it directly:
// `tsnet.Server.Dial` → `tsdial.UserDial` falls through to Go's
// `net.Resolver` for hostnames not in the in-memory MagicDNS map (peers
// + ExtraRecords). Inside Docker that hits 127.0.0.11 (Docker DNS), which
// has no answer for split-DNS suffixes like `*.service.awsw2.consul`.
// Kernel-mode tailscaled papers over this by editing /etc/resolv.conf;
// userspace tsnet does not, and tailscaled's own userspace outbound proxy
// has the same gap (tailscale#16906, tailscale#4677). So we resolve names
// ourselves via LocalClient.QueryDNS (which calls into *dns.Manager.Resolver,
// the resolver that DOES honor Headscale-pushed split-DNS Routes) and pass
// the resolved IP to ts.Dial. This is the load-bearing reason this is custom
// code and not a stock `tailscale up`. Carried over from deephive issue #380.
func startProxy(ts *tsnet.Server, port int, suffixes []string) (*http.Server, error) {
	lc, err := ts.LocalClient()
	if err != nil {
		return nil, fmt.Errorf("local client: %w", err)
	}
	return startProxyWithResolver(ts, port, resolveViaLocalAPI(lc), suffixes)
}

// startProxyWithResolver is the test seam: production calls startProxy
// which wires resolveViaLocalAPI, tests can inject a deterministic
// resolverFunc.
func startProxyWithResolver(ts *tsnet.Server, port int, resolve resolverFunc, suffixes []string) (*http.Server, error) {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("listen %s: %w", addr, err)
	}

	dialFn := routeBySuffix(tailnetDialer(ts.Dial, resolve), directDial, suffixes)

	transport := &http.Transport{
		DialContext:           dialFn,
		MaxIdleConns:          16,
		IdleConnTimeout:       60 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	}
	// CheckRedirect returns ErrUseLastResponse so redirects pass back to
	// the client rather than being followed at the proxy layer. Lets the
	// calling command decide what to do with 3xx.
	client := &http.Client{
		Transport: transport,
		Timeout:   60 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	srv := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodConnect {
				handleConnect(w, r, dialFn)
				return
			}
			handleForward(w, r, client)
		}),
		// CONNECT tunnels are long-lived, do not let default idle timeouts
		// kill an in-progress streaming response.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       0,
	}
	go func() { _ = srv.Serve(ln) }()
	return srv, nil
}

// tailnetDialer returns a DialContext that resolves hostnames through
// tsnet's internal DNS resolver (which honors Headscale-pushed split-DNS
// Routes) and then forwards to `dial` with the resolved IP. IP literals
// dial directly. See startProxy comment for the reason this is needed.
func tailnetDialer(dial dialFunc, resolve resolverFunc) dialFunc {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		if net.ParseIP(host) != nil {
			return dial(ctx, network, addr)
		}
		ip, err := resolve(ctx, host)
		if err != nil {
			return nil, fmt.Errorf("tailnet resolve %q: %w", host, err)
		}
		return dial(ctx, network, net.JoinHostPort(ip.String(), port))
	}
}

// directDial is the fallback dialer for hosts that do NOT match a tailnet
// suffix: a plain dial on the container's normal network, with the same
// short timeout shape tsnet uses, so public targets behave exactly as they
// would without the proxy in the path.
func directDial(ctx context.Context, network, addr string) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, network, addr)
}

// routeBySuffix returns a dialer that sends hosts matching a tailnet suffix
// through tailnetDial (resolve via Headscale split-DNS, then dial via tsnet)
// and everything else through directDial. IP-literal targets always take
// directDial: a bare IP has no suffix to match, and tunneling an arbitrary
// literal through a no-exit-node tsnet would just fail. This is what makes
// `dgvpn` a safe prefix for any command, see the startProxy comment.
func routeBySuffix(tailnetDial, direct dialFunc, suffixes []string) dialFunc {
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, _, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		if hostHasTailnetSuffix(host, suffixes) {
			return tailnetDial(ctx, network, addr)
		}
		return direct(ctx, network, addr)
	}
}

// hostHasTailnetSuffix reports whether host ends with any configured tailnet
// suffix, case-insensitively. A bare IP literal never matches (it has no DNS
// suffix), so IP targets fall through to the direct dialer.
func hostHasTailnetSuffix(host string, suffixes []string) bool {
	if net.ParseIP(host) != nil {
		return false
	}
	h := strings.ToLower(host)
	for _, s := range suffixes {
		if s != "" && strings.HasSuffix(h, strings.ToLower(s)) {
			return true
		}
	}
	return false
}

// resolveViaLocalAPI builds a resolverFunc that delegates to tsnet's
// LocalAPI dns-query endpoint. The endpoint server-side calls into
// LocalAPI dns-query endpoint. The endpoint server-side calls into
// *dns.Manager.Resolver, the same resolver tsnet's userspace DNS
// listener uses, and it honors Routes pushed via the Headscale netmap
// (DNS.Routes map[FQDN][]*Resolver).
//
// Wraps the raw query in a per-proxy TTL cache (defaultDNSCacheTTL).
// Without it, every TCP dial through the proxy pays one (A) or two
// (A+AAAA) LocalAPI round-trips, and the same hostname can resolve
// many times per second in a chatty MCP. The LocalAPI round-trip is
// in-process but still allocates HTTP request/response objects.
func resolveViaLocalAPI(lc *local.Client) resolverFunc {
	return cachingResolver(rawResolveViaLocalAPI(lc), defaultDNSCacheTTL)
}

// rawResolveViaLocalAPI is the uncached query path. Exported only for
// tests that want to drive the cache layer without a real LocalClient.
func rawResolveViaLocalAPI(lc *local.Client) resolverFunc {
	return func(ctx context.Context, host string) (netip.Addr, error) {
		for _, qt := range []string{"A", "AAAA"} {
			raw, _, err := lc.QueryDNS(ctx, host, qt)
			if err != nil {
				return netip.Addr{}, fmt.Errorf("QueryDNS %s/%s: %w", host, qt, err)
			}
			ip, err := parseFirstAOrAAAA(raw)
			if err == nil {
				return ip, nil
			}
			if !errors.Is(err, errNoTailnetDNSAnswer) {
				return netip.Addr{}, fmt.Errorf("parse %s/%s response: %w", host, qt, err)
			}
		}
		return netip.Addr{}, errNoTailnetDNSAnswer
	}
}

// cachingResolver wraps a resolverFunc with a TTL cache. Successful
// resolutions are cached for `ttl`; errors (including
// errNoTailnetDNSAnswer) are NOT cached, so NXDOMAIN-state always
// triggers a fresh query. Concurrent lookups for the same key are
// allowed to race the inner resolver, the simple-and-correct option
// for an O(small) hostname set, no singleflight needed.
func cachingResolver(inner resolverFunc, ttl time.Duration) resolverFunc {
	type entry struct {
		ip      netip.Addr
		expires time.Time
	}
	var (
		mu      sync.Mutex
		entries = make(map[string]entry)
	)
	return func(ctx context.Context, host string) (netip.Addr, error) {
		key := strings.ToLower(host)
		now := time.Now()
		mu.Lock()
		if e, ok := entries[key]; ok && now.Before(e.expires) {
			mu.Unlock()
			return e.ip, nil
		}
		mu.Unlock()

		ip, err := inner(ctx, host)
		if err != nil {
			return netip.Addr{}, err
		}
		mu.Lock()
		entries[key] = entry{ip: ip, expires: now.Add(ttl)}
		mu.Unlock()
		return ip, nil
	}
}

// parseFirstAOrAAAA scans a raw DNS response and returns the first A or
// AAAA answer. Returns errNoTailnetDNSAnswer if the answer section had no
// such records, which we treat as NXDOMAIN-equivalent for fallback
// purposes.
func parseFirstAOrAAAA(raw []byte) (netip.Addr, error) {
	var p dnsmessage.Parser
	if _, err := p.Start(raw); err != nil {
		return netip.Addr{}, fmt.Errorf("parse header: %w", err)
	}
	if err := p.SkipAllQuestions(); err != nil {
		return netip.Addr{}, fmt.Errorf("skip questions: %w", err)
	}
	for {
		hdr, err := p.AnswerHeader()
		if errors.Is(err, dnsmessage.ErrSectionDone) {
			return netip.Addr{}, errNoTailnetDNSAnswer
		}
		if err != nil {
			return netip.Addr{}, fmt.Errorf("answer header: %w", err)
		}
		switch hdr.Type {
		case dnsmessage.TypeA:
			r, err := p.AResource()
			if err != nil {
				return netip.Addr{}, fmt.Errorf("A resource: %w", err)
			}
			return netip.AddrFrom4(r.A), nil
		case dnsmessage.TypeAAAA:
			r, err := p.AAAAResource()
			if err != nil {
				return netip.Addr{}, fmt.Errorf("AAAA resource: %w", err)
			}
			return netip.AddrFrom16(r.AAAA), nil
		default:
			if err := p.SkipAnswer(); err != nil {
				return netip.Addr{}, fmt.Errorf("skip answer: %w", err)
			}
		}
	}
}

func handleConnect(w http.ResponseWriter, r *http.Request, dial func(context.Context, string, string) (net.Conn, error)) {
	host := r.URL.Host
	if host == "" {
		host = r.Host
	}
	if !strings.Contains(host, ":") {
		http.Error(w, "CONNECT requires host:port", http.StatusBadRequest)
		return
	}

	// Dial the target via the user's tailnet identity. The dialer routes
	// hostname resolution through tsnet's internal resolver before
	// handing the IP to tsnet.Server.Dial, so MagicDNS, subnet routes,
	// and Headscale-pushed split-DNS suffixes all work as if the caller
	// were a real machine on the tailnet under this user's identity.
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	upstream, err := dial(ctx, "tcp", host)
	if err != nil {
		http.Error(w, "tailnet dial: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer upstream.Close()

	// Hijack so we can take over the raw TCP conn and bridge bytes.
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return
	}
	client, _, err := hj.Hijack()
	if err != nil {
		http.Error(w, "hijack: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer client.Close()

	// RFC 7231: 200 with empty body signals tunnel established.
	_, _ = client.Write([]byte("HTTP/1.1 200 OK\r\n\r\n"))

	// Bidirectional copy. Either side closing tears down the tunnel.
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(upstream, client); done <- struct{}{} }()
	go func() { _, _ = io.Copy(client, upstream); done <- struct{}{} }()
	<-done
}

// handleForward proxies plain HTTP requests for clients (like undici on
// HTTP targets, or curl --proxy on http://) that send absolute-form URLs
// to the proxy. The request URL is the full target, we re-issue it via
// the tsnet-routed http.Client.
func handleForward(w http.ResponseWriter, r *http.Request, client *http.Client) {
	if !r.URL.IsAbs() {
		http.Error(w, "absolute-form URL required for forward-proxy mode", http.StatusBadRequest)
		return
	}

	upstream, err := http.NewRequestWithContext(r.Context(), r.Method, r.URL.String(), r.Body)
	if err != nil {
		http.Error(w, "build upstream request: "+err.Error(), http.StatusBadGateway)
		return
	}
	copyHeadersStripHopByHop(upstream.Header, r.Header)

	resp, err := client.Do(upstream)
	if err != nil {
		http.Error(w, "tailnet fetch: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	copyHeadersStripHopByHop(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func copyHeadersStripHopByHop(dst, src http.Header) {
	for k, vv := range src {
		if isHopByHopHeader(k) {
			continue
		}
		for _, v := range vv {
			dst.Add(k, v)
		}
	}
}

// isHopByHopHeader reports whether a header is hop-by-hop per RFC 7230
// §6.1 and must not be forwarded across a proxy. Per-message metadata
// like Connection and Proxy-Authorization belongs to this hop only.
func isHopByHopHeader(name string) bool {
	switch strings.ToLower(name) {
	case "connection",
		"proxy-connection",
		"keep-alive",
		"transfer-encoding",
		"te",
		"trailer",
		"upgrade",
		"proxy-authenticate",
		"proxy-authorization":
		return true
	}
	return false
}
