package main

import (
	"bufio"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// mockConnectProxy accepts one connection, records the CONNECT request-line
// target (returned via the gotTarget pointer), writes resp, then (if echo)
// mirrors bytes back so the bridge can be asserted end to end. It returns its
// listen address.
func mockConnectProxy(t *testing.T, resp string, echo bool) (addr string, gotTarget *string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	target := new(string)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		br := bufio.NewReader(conn)
		reqLine, err := br.ReadString('\n')
		if err != nil {
			return
		}
		// "CONNECT host:port HTTP/1.1"
		if fields := strings.Fields(reqLine); len(fields) >= 2 {
			*target = fields[1]
		}
		// Drain the remaining request headers up to the blank line.
		for {
			line, err := br.ReadString('\n')
			if err != nil || line == "\r\n" || line == "\n" {
				break
			}
		}
		conn.Write([]byte(resp))
		if echo {
			io.Copy(conn, br) // echo client->... back to client
		}
	}()
	return ln.Addr().String(), target
}

func TestConnectThrough_Success(t *testing.T) {
	addr, gotTarget := mockConnectProxy(t, "HTTP/1.1 200 OK\r\n\r\n", true)

	clientReads, proxyWrites := io.Pipe() // stdout side
	stdinR, stdinW := io.Pipe()           // stdin side

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		if err := connectThrough(addr, "aws-tools.node.aws.consul", "22", stdinR, proxyWrites); err != nil {
			// EOF once the pipes close is expected; only fail on a real error.
			if err != io.ErrClosedPipe && err != io.EOF {
				t.Errorf("connectThrough: %v", err)
			}
		}
		proxyWrites.Close()
	}()

	// Push a payload through stdin; the echo proxy should return it on stdout.
	go func() {
		stdinW.Write([]byte("ssh-handshake-bytes"))
		stdinW.Close()
	}()

	got, _ := io.ReadAll(clientReads)
	if string(got) != "ssh-handshake-bytes" {
		t.Fatalf("bridge round-trip = %q, want %q", got, "ssh-handshake-bytes")
	}
	if *gotTarget != "aws-tools.node.aws.consul:22" {
		t.Fatalf("CONNECT target = %q, want aws-tools.node.aws.consul:22", *gotTarget)
	}
	wg.Wait()
}

func TestConnectThrough_EarlyDataAfterHeaders(t *testing.T) {
	// Server banner coalesced with the 200 in a single write must not be lost.
	addr, _ := mockConnectProxy(t, "HTTP/1.1 200 OK\r\n\r\nSSH-2.0-OpenSSH_9.6\r\n", false)

	clientReads, proxyWrites := io.Pipe()
	stdinR, stdinW := io.Pipe()
	go func() {
		connectThrough(addr, "h", "22", stdinR, proxyWrites)
		proxyWrites.Close()
	}()
	go func() { stdinW.Close() }()

	got, _ := io.ReadAll(clientReads)
	if !strings.Contains(string(got), "SSH-2.0-OpenSSH_9.6") {
		t.Fatalf("early banner dropped: got %q", got)
	}
}

func TestConnectThrough_Refused(t *testing.T) {
	addr, _ := mockConnectProxy(t, "HTTP/1.1 502 Bad Gateway\r\n\r\ntailnet dial: no route\n", false)
	err := connectThrough(addr, "h", "22", strings.NewReader(""), io.Discard)
	if err == nil || !strings.Contains(err.Error(), "502") {
		t.Fatalf("want 502 refusal error, got %v", err)
	}
}

func TestConnectThrough_200OnlyMatchesStatusLine(t *testing.T) {
	// A non-2xx status whose HEADERS merely contain "200" must be treated as a
	// refusal, not a success: the check reads the status line only.
	addr, _ := mockConnectProxy(t, "HTTP/1.1 403 Forbidden\r\nRetry-After: 200\r\n\r\n", false)
	err := connectThrough(addr, "h", "22", strings.NewReader(""), io.Discard)
	if err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("want 403 refusal (status line, not header), got %v", err)
	}
}

func TestParseConnectInvocation(t *testing.T) {
	cases := []struct {
		name     string
		argv     []string
		wantOK   bool
		wantArgs []string
	}{
		{"daemon bare", []string{"dgvpn-proxy"}, false, nil},
		{"daemon other subcmd", []string{"dgvpn-proxy", "up"}, false, nil},
		{"symlink argv0 full path", []string{"/usr/local/bin/dgvpn-connect", "127.0.0.1:1055", "h", "22"}, true, []string{"127.0.0.1:1055", "h", "22"}},
		{"connect subcommand", []string{"dgvpn-proxy", "connect", "p:1", "h", "22"}, true, []string{"p:1", "h", "22"}},
		{"symlink no args", []string{"dgvpn-connect"}, true, []string{}},
		{"empty argv", nil, false, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			args, ok := parseConnectInvocation(tc.argv)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if ok && !equalStrings(args, tc.wantArgs) {
				t.Fatalf("args = %v, want %v", args, tc.wantArgs)
			}
		})
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestConnectThrough_ProxyUnreachable(t *testing.T) {
	// Port 1 on loopback: nothing listens, dial must fail fast (well under the
	// 15s dial timeout) with a wrapped proxy-dial error.
	done := make(chan error, 1)
	go func() { done <- connectThrough("127.0.0.1:1", "h", "22", strings.NewReader(""), io.Discard) }()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "dial proxy") {
			t.Fatalf("want dial-proxy error, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("connectThrough did not fail promptly on an unreachable proxy")
	}
}
