// Command dgvpn-proxy brings up a single userspace Tailscale identity on the
// Deepgram tailnet and exposes a localhost HTTP proxy that routes only
// tailnet-suffix traffic (`.consul` by default) through it. Everything else
// dials directly, so the proxy is safe to sit in front of any command.
//
// This is the single-user collapse of deephive's services/tsnet sidecar.
// deephive needed one tsnet.Server per user (a map keyed by UUID, a Unix
// socket JSON protocol, hashed per-user proxy ports) because it is multi-
// tenant. pocket-dev has exactly one user, so all of that machinery is gone:
// one identity, one fixed proxy port, no socket protocol. What is preserved
// verbatim is the load-bearing part, proxy.go's split-DNS resolution via the
// tsnet LocalAPI and the RouteAll=true fix below, because those are the only
// things that make `.consul` reachable from userspace tsnet inside Docker
// (see the startProxy comment and tailscale#16906 / #4677).
//
// Auth is interactive Keycloak SSO. On first run (or after the ~24h node-key
// expiry) tsnet reports a login URL; this process prints it and keeps polling
// until a human completes the SSO. Once Running it starts the proxy and blocks
// until SIGTERM. The `dgvpn-up` wrapper launches this and surfaces the URL;
// the `dgvpn` wrapper points HTTP_PROXY at the port.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

const (
	defaultControlURL = "https://controlplane.deepgram.com"
	defaultHostname   = "pocket-dev-jacob-lasky"
	defaultProxyPort  = 1055
	defaultStateDir   = "/home/claude/.dgvpn"
	defaultSuffixes   = ".consul"
)

func main() {
	log.SetFlags(0)
	log.SetPrefix("dgvpn: ")
	// run() owns all setup so its deferred cleanup (ts.Close, cancel) actually
	// runs before exit. Calling log.Fatalf directly from the setup body would
	// os.Exit and skip every defer, leaking the tsnet state-dir handle on a
	// startup failure. Keep the only Fatal here, after run() returns.
	if err := run(); err != nil {
		log.Fatalf("%v", err)
	}
}

func run() error {
	controlURL := getenv("DGVPN_CONTROL_URL", defaultControlURL)
	hostname := getenv("DGVPN_HOSTNAME", defaultHostname)
	stateDir := getenv("DGVPN_DIR", defaultStateDir)
	port := atoiEnv("DGVPN_PROXY_PORT", defaultProxyPort)
	suffixes := parseSuffixes(getenv("DGVPN_TAILNET_SUFFIXES", defaultSuffixes))
	verbose := os.Getenv("DGVPN_VERBOSE") != ""

	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return fmt.Errorf("create state dir %s: %w", stateDir, err)
	}

	ts := &tsnet.Server{
		Hostname:   hostname,
		Dir:        stateDir,
		ControlURL: controlURL,
		Ephemeral:  false,
		Logf: func(format string, args ...any) {
			if verbose {
				log.Printf("tsnet: "+format, args...)
			}
		},
	}
	defer ts.Close()

	if err := ts.Start(); err != nil {
		return fmt.Errorf("tsnet start: %w", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Wire SIGTERM/SIGINT to cancel ctx up front, before the login wait. The
	// container sends SIGTERM on `docker stop`; cancelling ctx unblocks both the
	// login poll and the post-READY block so deferred ts.Close runs and the node
	// shuts down gracefully instead of waiting for SIGKILL. Set up before
	// waitUntilRunning so a stop during a pending SSO also exits cleanly.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigCh
		log.Printf("shutting down")
		cancel()
	}()

	// RouteAll=true so Headscale-pushed subnet routes (the internal .consul
	// DNS resolver and any other advertised subnet) are accepted into tsnet's
	// netstack. Userspace tsnet defaults this false on Linux; without it,
	// anything beyond MagicDNS names is unreachable. Carried from deephive
	// #380. Non-fatal: log and continue so MagicDNS-only targets still work.
	if err := enableRouteAll(ctx, ts); err != nil {
		log.Printf("enable RouteAll (non-fatal): %v", err)
	} else {
		log.Printf("RouteAll=true (accepting subnet routes)")
	}

	if err := waitUntilRunning(ctx, ts); err != nil {
		return err
	}

	srv, err := startProxy(ts, port, suffixes)
	if err != nil {
		return fmt.Errorf("start proxy: %w", err)
	}
	log.Printf("READY proxy=http://127.0.0.1:%d suffixes=%s", port, strings.Join(suffixes, ","))

	// Serve until the signal handler cancels ctx, then tear down the listener.
	<-ctx.Done()
	_ = srv.Close()
	return nil
}

// waitUntilRunning polls the tsnet backend until it reaches Running, printing
// the SSO login URL once if interactive auth is required. It polls until the
// node is Running or ctx is cancelled (SIGTERM); there is no fixed deadline.
//
// A fixed deadline was wrong: the proxy is a long-lived daemon, and a human
// completing SSO out-of-band may take minutes. Giving up would orphan the
// pending registration on the control plane, and re-arming kept reusing the
// same persisted nodekey, which the control plane eventually rejects with
// "could not register machine". Polling until cancelled keeps one live poller
// behind the printed URL for as long as the container runs.
func waitUntilRunning(ctx context.Context, ts *tsnet.Server) error {
	lc, err := ts.LocalClient()
	if err != nil {
		return fmt.Errorf("local client: %w", err)
	}
	urlPrinted := false
	for {
		st, err := lc.StatusWithoutPeers(ctx)
		if err == nil {
			if st.BackendState == "Running" {
				ip := ""
				if len(st.TailscaleIPs) > 0 {
					ip = st.TailscaleIPs[0].String()
				}
				log.Printf("RUNNING ip=%s", ip)
				return nil
			}
			if st.AuthURL != "" && !urlPrinted {
				urlPrinted = true
				// This is the one line a human acts on: open it once per
				// ~24h to complete SSO. `dgvpn-up` greps for "ACTION".
				log.Printf("ACTION REQUIRED: open this URL to authenticate the tailnet:\n  %s", st.AuthURL)
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

// enableRouteAll flips Prefs.RouteAll=true so peer-advertised subnet routes are
// accepted. Idempotent. Extracted shape matches deephive's buildAcceptRoutesPrefs.
func enableRouteAll(ctx context.Context, ts *tsnet.Server) error {
	lc, err := ts.LocalClient()
	if err != nil {
		return fmt.Errorf("local client: %w", err)
	}
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err = lc.EditPrefs(cctx, &ipn.MaskedPrefs{
		Prefs:       ipn.Prefs{RouteAll: true},
		RouteAllSet: true,
	})
	if err != nil {
		return fmt.Errorf("edit prefs: %w", err)
	}
	return nil
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func atoiEnv(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
		log.Printf("ignoring non-integer %s=%q, using %d", key, v, fallback)
	}
	return fallback
}

// parseSuffixes splits a comma-separated suffix list, trimming blanks. Empty
// input falls back to the .consul default rather than an empty list (an empty
// list would route nothing through the tunnel, silently defeating the point).
func parseSuffixes(raw string) []string {
	var out []string
	for _, s := range strings.Split(raw, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return []string{defaultSuffixes}
	}
	return out
}
