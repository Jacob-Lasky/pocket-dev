package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// startTestProxy stands up the proxy half without a real tsnet.Server.
// All upstream traffic is dialed to the provided test server, simulating
// "tsnet.Dial succeeded and reached the tailnet peer." The handler
// logic under test (CONNECT branching vs forward-HTTP) is identical to
// the production proxy.
func startTestProxy(t *testing.T, target *httptest.Server) string {
	t.Helper()

	// Dial-via-test-server. Production uses ts.Dial; we substitute a
	// plain net.Dial against the httptest server. handleForward only
	// cares about what's exposed on the http.Client surface.
	dialFn := func(network, _ string) (net.Conn, error) {
		return net.Dial("tcp", target.Listener.Addr().String())
	}
	transport := &http.Transport{Dial: dialFn}
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodConnect {
				upstream, err := net.Dial("tcp", target.Listener.Addr().String())
				if err != nil {
					http.Error(w, err.Error(), http.StatusBadGateway)
					return
				}
				hj, ok := w.(http.Hijacker)
				if !ok {
					http.Error(w, "no hijack", http.StatusInternalServerError)
					return
				}
				clientConn, _, err := hj.Hijack()
				if err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				clientConn.Write([]byte("HTTP/1.1 200 OK\r\n\r\n"))
				done := make(chan struct{}, 2)
				go func() { io.Copy(upstream, clientConn); done <- struct{}{} }()
				go func() { io.Copy(clientConn, upstream); done <- struct{}{} }()
				<-done
				clientConn.Close()
				upstream.Close()
				return
			}
			handleForward(w, r, client)
		}),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return "http://" + ln.Addr().String()
}

func TestProxyForwardsPlainHTTP(t *testing.T) {
	// Regression for the bug Jake hit live on 2026-05-14: the proxy
	// returned 405 on plain-HTTP forward requests (undici.ProxyAgent
	// against http://*.consul:9008), because the original handler
	// only implemented CONNECT. After this fix, absolute-form GET to
	// the proxy must reach the upstream and return its body verbatim.
	hits := int32(0)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		if r.Method != http.MethodGet {
			t.Errorf("upstream got method %q, want GET", r.Method)
		}
		if r.URL.Path != "/rraid/healthcheck" {
			t.Errorf("upstream got path %q, want /rraid/healthcheck", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	proxyURL, err := url.Parse(startTestProxy(t, upstream))
	if err != nil {
		t.Fatal(err)
	}
	transport := &http.Transport{Proxy: http.ProxyURL(proxyURL)}
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}

	resp, err := client.Get("http://request-raid.service.awsw2.consul:9008/rraid/healthcheck")
	if err != nil {
		t.Fatalf("get via proxy: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != `{"ok":true}` {
		t.Errorf("body = %q, want JSON ok", body)
	}
	if atomic.LoadInt32(&hits) != 1 {
		t.Errorf("upstream hits = %d, want 1", hits)
	}
}

func TestProxyStripsHopByHopHeaders(t *testing.T) {
	// RFC 7230 §6.1: hop-by-hop headers MUST NOT be forwarded. Easy to
	// regress when bulk-copying headers between client/upstream.
	leaked := int32(0)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, h := range []string{"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authorization"} {
			if r.Header.Get(h) != "" {
				t.Errorf("upstream saw hop-by-hop %s: %q", h, r.Header.Get(h))
				atomic.StoreInt32(&leaked, 1)
			}
		}
		if r.Header.Get("X-Custom-Forward") != "should-arrive" {
			t.Errorf("end-to-end header X-Custom-Forward was dropped, got %q", r.Header.Get("X-Custom-Forward"))
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	proxyURL, err := url.Parse(startTestProxy(t, upstream))
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("GET", "http://request-raid.service.awsw2.consul:9008/x", nil)
	req.Header.Set("Proxy-Authorization", "Bearer should-not-forward")
	req.Header.Set("X-Custom-Forward", "should-arrive")

	transport := &http.Transport{Proxy: http.ProxyURL(proxyURL)}
	client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if atomic.LoadInt32(&leaked) != 0 {
		t.Fatal("hop-by-hop headers leaked through proxy")
	}
}

// buildDNSResponse synthesizes a raw DNS response containing the given
// answers, in the wire format the parser sees from LocalClient.QueryDNS.
// Used to drive parseFirstAOrAAAA without needing a real tsnet resolver.
func buildDNSResponse(t *testing.T, qname string, answers []dnsmessage.Resource) []byte {
	t.Helper()
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{
		ID:            1,
		Response:      true,
		Authoritative: true,
	})
	if err := b.StartQuestions(); err != nil {
		t.Fatal(err)
	}
	n, err := dnsmessage.NewName(qname)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Question(dnsmessage.Question{Name: n, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}); err != nil {
		t.Fatal(err)
	}
	if err := b.StartAnswers(); err != nil {
		t.Fatal(err)
	}
	for _, ans := range answers {
		switch body := ans.Body.(type) {
		case *dnsmessage.AResource:
			if err := b.AResource(ans.Header, *body); err != nil {
				t.Fatal(err)
			}
		case *dnsmessage.AAAAResource:
			if err := b.AAAAResource(ans.Header, *body); err != nil {
				t.Fatal(err)
			}
		case *dnsmessage.CNAMEResource:
			if err := b.CNAMEResource(ans.Header, *body); err != nil {
				t.Fatal(err)
			}
		default:
			t.Fatalf("unsupported answer body %T", body)
		}
	}
	raw, err := b.Finish()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func mustName(t *testing.T, s string) dnsmessage.Name {
	t.Helper()
	n, err := dnsmessage.NewName(s)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestParseFirstAOrAAAA_ARecord(t *testing.T) {
	// Most common case: Headscale split-DNS resolves a .consul name to a
	// tailnet 100.x.x.x address via an A record.
	raw := buildDNSResponse(t, "request-raid.service.awsw2.consul.", []dnsmessage.Resource{
		{
			Header: dnsmessage.ResourceHeader{Name: mustName(t, "request-raid.service.awsw2.consul."), Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: 60},
			Body:   &dnsmessage.AResource{A: [4]byte{100, 64, 1, 23}},
		},
	})
	ip, err := parseFirstAOrAAAA(raw)
	if err != nil {
		t.Fatalf("parseFirstAOrAAAA: %v", err)
	}
	if want := netip.AddrFrom4([4]byte{100, 64, 1, 23}); ip != want {
		t.Errorf("ip = %s, want %s", ip, want)
	}
}

func TestParseFirstAOrAAAA_AAAARecord(t *testing.T) {
	v6 := [16]byte{0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 0xab, 0x12, 0, 0, 0, 0, 0, 0, 0, 1}
	raw := buildDNSResponse(t, "example.tailnet.ts.net.", []dnsmessage.Resource{
		{
			Header: dnsmessage.ResourceHeader{Name: mustName(t, "example.tailnet.ts.net."), Type: dnsmessage.TypeAAAA, Class: dnsmessage.ClassINET, TTL: 60},
			Body:   &dnsmessage.AAAAResource{AAAA: v6},
		},
	})
	ip, err := parseFirstAOrAAAA(raw)
	if err != nil {
		t.Fatalf("parseFirstAOrAAAA: %v", err)
	}
	if want := netip.AddrFrom16(v6); ip != want {
		t.Errorf("ip = %s, want %s", ip, want)
	}
}

func TestParseFirstAOrAAAA_SkipsCNAME(t *testing.T) {
	// Resolvers commonly chain CNAME -> A in a single response. We
	// should skip the CNAME and pick the A.
	raw := buildDNSResponse(t, "alias.service.awsw2.consul.", []dnsmessage.Resource{
		{
			Header: dnsmessage.ResourceHeader{Name: mustName(t, "alias.service.awsw2.consul."), Type: dnsmessage.TypeCNAME, Class: dnsmessage.ClassINET, TTL: 60},
			Body:   &dnsmessage.CNAMEResource{CNAME: mustName(t, "real.service.awsw2.consul.")},
		},
		{
			Header: dnsmessage.ResourceHeader{Name: mustName(t, "real.service.awsw2.consul."), Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: 60},
			Body:   &dnsmessage.AResource{A: [4]byte{100, 64, 9, 9}},
		},
	})
	ip, err := parseFirstAOrAAAA(raw)
	if err != nil {
		t.Fatalf("parseFirstAOrAAAA: %v", err)
	}
	if want := netip.AddrFrom4([4]byte{100, 64, 9, 9}); ip != want {
		t.Errorf("ip = %s, want %s", ip, want)
	}
}

func TestParseFirstAOrAAAA_NoAnswer(t *testing.T) {
	// NXDOMAIN-ish: response has zero answers. Must surface as
	// errNoTailnetDNSAnswer so the caller can decide (fallback to next
	// query type, or give up).
	raw := buildDNSResponse(t, "missing.service.awsw2.consul.", nil)
	_, err := parseFirstAOrAAAA(raw)
	if !errors.Is(err, errNoTailnetDNSAnswer) {
		t.Errorf("err = %v, want errNoTailnetDNSAnswer", err)
	}
}

func TestParseFirstAOrAAAA_MalformedBytes(t *testing.T) {
	// Garbage in, error out. Must not return a bogus IP. Confirms we
	// don't paper over a resolver bug by silently using the zero IP.
	_, err := parseFirstAOrAAAA([]byte{0x00, 0x01, 0x02})
	if err == nil {
		t.Fatal("expected error on malformed bytes")
	}
	if errors.Is(err, errNoTailnetDNSAnswer) {
		t.Errorf("malformed input should not surface as errNoTailnetDNSAnswer, got %v", err)
	}
}

func TestTailnetDialer_PassesIPLiteralThrough(t *testing.T) {
	// An IP literal in addr means "no DNS work to do", the dialer must
	// hand it straight to the underlying dial without invoking the
	// resolver. Capture the addr that reached the inner dial and
	// confirm the resolver is never touched.
	resolverCalls := int32(0)
	resolve := func(_ context.Context, _ string) (netip.Addr, error) {
		atomic.AddInt32(&resolverCalls, 1)
		return netip.Addr{}, errors.New("resolver should not be called for IP literal")
	}
	var gotAddr string
	innerDial := func(_ context.Context, _, addr string) (net.Conn, error) {
		gotAddr = addr
		return nil, errors.New("inner-dial stub: no real conn")
	}
	dial := tailnetDialer(innerDial, resolve)
	_, _ = dial(context.Background(), "tcp", "100.64.1.23:9008")
	if atomic.LoadInt32(&resolverCalls) != 0 {
		t.Errorf("resolver called %d times for IP literal, want 0", resolverCalls)
	}
	if gotAddr != "100.64.1.23:9008" {
		t.Errorf("inner dial got addr %q, want %q", gotAddr, "100.64.1.23:9008")
	}
}

func TestTailnetDialer_ResolvesHostname(t *testing.T) {
	// Hostname-form must (a) call the resolver with the bare hostname,
	// then (b) hand the resolved IP:port to the inner dial. This is the
	// core regression for #380: without this path, hostnames fall
	// through to Go's system resolver and hit Docker DNS (127.0.0.11).
	resolverCalls := int32(0)
	resolve := func(_ context.Context, host string) (netip.Addr, error) {
		atomic.AddInt32(&resolverCalls, 1)
		if host != "request-raid.service.awsw2.consul" {
			t.Errorf("resolver got host %q, want %q", host, "request-raid.service.awsw2.consul")
		}
		return netip.AddrFrom4([4]byte{100, 64, 1, 23}), nil
	}
	var gotAddr string
	innerDial := func(_ context.Context, _, addr string) (net.Conn, error) {
		gotAddr = addr
		return nil, errors.New("inner-dial stub: no real conn")
	}
	dial := tailnetDialer(innerDial, resolve)
	_, _ = dial(context.Background(), "tcp", "request-raid.service.awsw2.consul:9008")
	if atomic.LoadInt32(&resolverCalls) != 1 {
		t.Errorf("resolver called %d times, want 1", resolverCalls)
	}
	if gotAddr != "100.64.1.23:9008" {
		t.Errorf("inner dial got addr %q, want %q (resolver IP + original port)", gotAddr, "100.64.1.23:9008")
	}
}

func TestCachingResolver_HitDoesNotReQuery(t *testing.T) {
	// First call populates, second call within TTL must be served from
	// cache without calling the inner resolver. Bug shape this catches:
	// someone introducing a per-request closure that defeats the cache.
	calls := int32(0)
	inner := func(_ context.Context, _ string) (netip.Addr, error) {
		atomic.AddInt32(&calls, 1)
		return netip.AddrFrom4([4]byte{100, 64, 1, 23}), nil
	}
	r := cachingResolver(inner, time.Minute)
	for i := 0; i < 5; i++ {
		ip, err := r(context.Background(), "request-raid.service.awsw2.consul")
		if err != nil {
			t.Fatalf("call %d returned error: %v", i, err)
		}
		if got := ip.String(); got != "100.64.1.23" {
			t.Errorf("call %d returned %s, want 100.64.1.23", i, got)
		}
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("inner resolver called %d times, want 1 (cache miss + 4 hits)", got)
	}
}

func TestCachingResolver_CaseInsensitive(t *testing.T) {
	// DNS names are case-insensitive (RFC 1035 §2.3.3). The cache must
	// not store separate entries for "Foo.Bar" and "foo.bar", or the
	// inner resolver would be hit twice for the same logical name.
	calls := int32(0)
	inner := func(_ context.Context, _ string) (netip.Addr, error) {
		atomic.AddInt32(&calls, 1)
		return netip.AddrFrom4([4]byte{100, 64, 5, 5}), nil
	}
	r := cachingResolver(inner, time.Minute)
	_, _ = r(context.Background(), "Foo.SERVICE.awsw2.consul")
	_, _ = r(context.Background(), "foo.service.awsw2.consul")
	_, _ = r(context.Background(), "FOO.SERVICE.AWSW2.CONSUL")
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("inner called %d times across three case variants, want 1", got)
	}
}

func TestCachingResolver_ExpiryReFetches(t *testing.T) {
	// After TTL expiry, the next call must re-fetch. Bug shape: someone
	// caching forever or comparing expiry with wrong sign.
	calls := int32(0)
	inner := func(_ context.Context, _ string) (netip.Addr, error) {
		atomic.AddInt32(&calls, 1)
		return netip.AddrFrom4([4]byte{100, 64, 7, 7}), nil
	}
	r := cachingResolver(inner, 5*time.Millisecond)
	_, _ = r(context.Background(), "h")
	time.Sleep(15 * time.Millisecond)
	_, _ = r(context.Background(), "h")
	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Errorf("inner called %d times, want 2 (one before expiry + one after)", got)
	}
}

func TestCachingResolver_DoesNotCacheErrors(t *testing.T) {
	// Errors (including errNoTailnetDNSAnswer) must NOT be cached: a
	// transient resolver glitch shouldn't pin a hostname to "unreachable"
	// for the full TTL window. Bug shape: caching a zero-value Addr or
	// putting the error in an entry.
	calls := int32(0)
	inner := func(_ context.Context, _ string) (netip.Addr, error) {
		atomic.AddInt32(&calls, 1)
		return netip.Addr{}, errNoTailnetDNSAnswer
	}
	r := cachingResolver(inner, time.Minute)
	for i := 0; i < 3; i++ {
		if _, err := r(context.Background(), "missing.consul"); err == nil {
			t.Errorf("call %d: expected error, got nil", i)
		}
	}
	if got := atomic.LoadInt32(&calls); got != 3 {
		t.Errorf("inner called %d times on errors, want 3 (no negative caching)", got)
	}
}

func TestCachingResolver_ConcurrentReadSafe(t *testing.T) {
	// Race-detector guard: multiple goroutines hitting the same key
	// simultaneously must not trip -race. We don't assert a single
	// inner call (no singleflight); we only assert correctness +
	// race-cleanliness. Bug shape: someone accessing the map without
	// the lock.
	inner := func(_ context.Context, _ string) (netip.Addr, error) {
		return netip.AddrFrom4([4]byte{100, 64, 9, 9}), nil
	}
	r := cachingResolver(inner, time.Minute)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				_, _ = r(context.Background(), "h")
			}
		}()
	}
	wg.Wait()
}

func TestTailnetDialer_ResolverErrorSurfaces(t *testing.T) {
	// When the resolver fails (NXDOMAIN, network error, etc.), the
	// dialer must not silently fall back to anything, must surface the
	// error wrapped with the hostname so debugging is straightforward.
	resolve := func(_ context.Context, _ string) (netip.Addr, error) {
		return netip.Addr{}, errNoTailnetDNSAnswer
	}
	innerCalls := int32(0)
	innerDial := func(_ context.Context, _, _ string) (net.Conn, error) {
		atomic.AddInt32(&innerCalls, 1)
		return nil, nil
	}
	dial := tailnetDialer(innerDial, resolve)
	_, err := dial(context.Background(), "tcp", "missing.service.awsw2.consul:9008")
	if err == nil {
		t.Fatal("expected error when resolver fails, got nil")
	}
	if atomic.LoadInt32(&innerCalls) != 0 {
		t.Errorf("inner dial called %d times after resolver failure, want 0", innerCalls)
	}
	if !errors.Is(err, errNoTailnetDNSAnswer) {
		t.Errorf("err = %v, want it to wrap errNoTailnetDNSAnswer", err)
	}
}

func TestIsHopByHopHeader(t *testing.T) {
	hop := []string{"Connection", "connection", "PROXY-CONNECTION", "keep-alive", "TE", "Transfer-Encoding", "trailer", "Upgrade", "Proxy-Authenticate", "Proxy-Authorization"}
	for _, h := range hop {
		if !isHopByHopHeader(h) {
			t.Errorf("%q should be hop-by-hop", h)
		}
	}
	endToEnd := []string{"Content-Type", "Content-Length", "Authorization", "X-Custom"}
	for _, h := range endToEnd {
		if isHopByHopHeader(h) {
			t.Errorf("%q must be end-to-end (forwardable)", h)
		}
	}
}
