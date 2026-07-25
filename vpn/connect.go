package main

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// parseConnectInvocation decides, from a full argv, whether dgvpn-proxy was
// invoked as the ssh ProxyCommand CONNECT client rather than as the daemon,
// returning the client's args. Split out from connectMode (which reads the
// os.Args global) so this string match is unit-testable: a rename of the
// "dgvpn-connect" symlink (see Dockerfile) or the "connect" subcommand would
// otherwise break dispatch silently. The literal "dgvpn-connect" MUST stay in
// sync with the Dockerfile symlink name and the dgssh ProxyCommand.
func parseConnectInvocation(argv []string) ([]string, bool) {
	if len(argv) == 0 {
		return nil, false
	}
	if filepath.Base(argv[0]) == "dgvpn-connect" {
		return argv[1:], true
	}
	if len(argv) > 1 && argv[1] == "connect" {
		return argv[2:], true
	}
	return nil, false
}

// connectMain implements an HTTP CONNECT client for use as an ssh
// ProxyCommand (see the `dgssh` wrapper). It opens a CONNECT tunnel through
// the local dgvpn proxy to host:port and bridges that tunnel to stdin/stdout,
// so ssh — and `rsync -e dgssh` — can reach `.consul` tailnet hosts through
// the SAME userspace tsnet proxy that `dgvpn` uses for HTTP.
//
// Why this exists as a MODE of dgvpn-proxy and not a separate netcat/python
// helper: ssh ignores HTTP_PROXY, so the env-var trick `dgvpn` uses does not
// work for it. The proxy already speaks CONNECT (proxy.go handleConnect) and
// resolves `.consul` via the tsnet LocalAPI split-DNS resolver, so all that is
// missing is a client that speaks CONNECT and hands ssh a raw byte stream.
// Shipping it as a second mode of the existing static, CGO-free binary keeps
// the image dependency-free (no netcat, no python) — the property the
// Dockerfile header is explicit about. This is also why it does NOT reach for
// kernel `tailscaled`: see the DO-NOT in the Dockerfile and CLAUDE.md.
//
// Args: <proxy host:port> <target host> <target port>.
func connectMain(args []string) error {
	if len(args) != 3 {
		return fmt.Errorf("usage: dgvpn-connect <proxy-host:port> <host> <port>")
	}
	return connectThrough(args[0], args[1], args[2], os.Stdin, os.Stdout)
}

// connectThrough dials the CONNECT proxy at proxyAddr, tunnels to host:port,
// and bridges the tunnel to in/out. Split out from connectMain (which wires
// os.Stdin/os.Stdout) so tests can drive it with pipes against a mock proxy.
func connectThrough(proxyAddr, host, port string, in io.Reader, out io.Writer) error {
	conn, err := net.DialTimeout("tcp", proxyAddr, 15*time.Second)
	if err != nil {
		return fmt.Errorf("dial proxy %s: %w", proxyAddr, err)
	}
	defer conn.Close()

	target := net.JoinHostPort(host, port)
	// CONNECT request line + Host header, no body (RFC 7231 §4.3.6). The proxy
	// replies 200 once the tailnet dial to `target` succeeds.
	if _, err := fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target, target); err != nil {
		return fmt.Errorf("send CONNECT: %w", err)
	}

	head, extra, err := readConnectResponse(conn)
	if err != nil {
		return err
	}
	// Match " 200" on the STATUS LINE only, not the whole header block: a later
	// header value that happens to contain "200" (e.g. "Retry-After: 200") on a
	// non-2xx response must not read as success. The proxy emits exactly
	// "HTTP/1.1 200 OK" on success (proxy.go handleConnect); on failure it
	// surfaces the tailnet dial error as the status/body, which we relay so it
	// reaches the ssh user.
	statusLine := head
	if i := strings.IndexByte(head, '\n'); i >= 0 {
		statusLine = head[:i]
	}
	if !strings.Contains(statusLine, " 200") {
		return fmt.Errorf("CONNECT refused by proxy: %s", strings.TrimSpace(statusLine))
	}
	// sshd speaks first (its banner), which can arrive coalesced with the 200
	// in the same read. Those bytes were buffered past the header terminator;
	// forward them before bridging or the session wedges waiting for a banner
	// that already came and went.
	if len(extra) > 0 {
		if _, err := out.Write(extra); err != nil {
			return fmt.Errorf("write early tunnel data: %w", err)
		}
	}

	// Bridge both directions. stdin->tunnel forwards client bytes and, on EOF,
	// half-closes the write side so the remote sees end-of-input WITHOUT
	// tearing down the whole tunnel. Tearing down here would truncate a reply
	// already in flight — notably sshd's banner, which it sends right after the
	// client's first burst — which is exactly what an earlier
	// first-finisher-wins version dropped.
	go func() {
		_, _ = io.Copy(conn, in)
		if cw, ok := conn.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		}
	}()
	// tunnel->stdout is the authoritative direction: when the remote closes,
	// the session is done, so this copy returning ends the process. The stdin
	// goroutine (possibly parked on an idle Read) is reaped on process exit;
	// the deferred conn.Close unblocks it if it is instead mid-write.
	_, err = io.Copy(out, conn)
	return err
}

// readConnectResponse reads the CONNECT status line and headers up to the
// blank-line terminator, returning the raw header block and any bytes the
// buffered reader prefetched past it (early tunnel data — see connectThrough).
func readConnectResponse(conn net.Conn) (headers string, extra []byte, err error) {
	br := bufio.NewReader(conn)
	var sb strings.Builder
	for {
		line, err := br.ReadString('\n')
		if err != nil {
			return "", nil, fmt.Errorf("read CONNECT response: %w", err)
		}
		sb.WriteString(line)
		if line == "\r\n" || line == "\n" {
			break
		}
	}
	if n := br.Buffered(); n > 0 {
		extra = make([]byte, n)
		if _, err := io.ReadFull(br, extra); err != nil {
			return "", nil, fmt.Errorf("read buffered tunnel data: %w", err)
		}
	}
	return sb.String(), extra, nil
}
