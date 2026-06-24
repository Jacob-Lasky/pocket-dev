package main

import (
	"context"
	"net"
	"testing"
)

func TestHostHasTailnetSuffix(t *testing.T) {
	suffixes := []string{".consul", ".ts.net"}
	cases := []struct {
		host string
		want bool
	}{
		{"request-raid.service.awsw2.consul", true},
		{"REQUEST-RAID.SERVICE.AWSW2.CONSUL", true}, // case-insensitive
		{"foo.ts.net", true},
		{"github.com", false},
		{"example.consul.com", false}, // suffix must be at the end
		{"100.64.1.42", false},        // bare IPv4 literal never matches
		{"::1", false},                // bare IPv6 literal never matches
	}
	for _, c := range cases {
		if got := hostHasTailnetSuffix(c.host, suffixes); got != c.want {
			t.Errorf("hostHasTailnetSuffix(%q) = %v, want %v", c.host, got, c.want)
		}
	}
}

func TestHostHasTailnetSuffixSkipsBlankSuffix(t *testing.T) {
	// A blank suffix in the list must not match everything via HasSuffix("").
	if hostHasTailnetSuffix("github.com", []string{""}) {
		t.Fatal("blank suffix must not match any host")
	}
}

// TestRouteBySuffix asserts the routing decision: tailnet-suffix hosts take the
// tunnel dialer, everything else (including bare IPs) takes the direct dialer.
func TestRouteBySuffix(t *testing.T) {
	cases := []struct {
		addr       string
		wantTunnel bool
	}{
		{"request-raid.service.awsw2.consul:9008", true},
		{"github.com:443", false},
		{"100.64.1.42:8080", false}, // IP literal -> direct
	}
	for _, c := range cases {
		var tunnelCalled, directCalled bool
		tunnel := func(ctx context.Context, network, addr string) (net.Conn, error) {
			tunnelCalled = true
			return nil, nil
		}
		direct := func(ctx context.Context, network, addr string) (net.Conn, error) {
			directCalled = true
			return nil, nil
		}
		dial := routeBySuffix(tunnel, direct, []string{".consul"})
		if _, err := dial(context.Background(), "tcp", c.addr); err != nil {
			t.Fatalf("dial(%q): unexpected error %v", c.addr, err)
		}
		if tunnelCalled != c.wantTunnel || directCalled == c.wantTunnel {
			t.Errorf("dial(%q): tunnel=%v direct=%v, want tunnel=%v", c.addr, tunnelCalled, directCalled, c.wantTunnel)
		}
	}
}

func TestRouteBySuffixRejectsBadAddr(t *testing.T) {
	dial := routeBySuffix(nil, nil, []string{".consul"})
	if _, err := dial(context.Background(), "tcp", "no-port-here"); err == nil {
		t.Fatal("expected error for addr without host:port")
	}
}

func TestParseSuffixes(t *testing.T) {
	cases := []struct {
		raw  string
		want []string
	}{
		{".consul", []string{".consul"}},
		{".consul, .ts.net ", []string{".consul", ".ts.net"}},
		{"", []string{".consul"}},      // empty falls back to default
		{"  ,  ", []string{".consul"}}, // all-blank falls back to default
	}
	for _, c := range cases {
		got := parseSuffixes(c.raw)
		if len(got) != len(c.want) {
			t.Errorf("parseSuffixes(%q) = %v, want %v", c.raw, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("parseSuffixes(%q) = %v, want %v", c.raw, got, c.want)
				break
			}
		}
	}
}
