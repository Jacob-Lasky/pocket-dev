package main

import (
	"os"
	"testing"
)

func TestGetenv(t *testing.T) {
	const key = "DGVPN_TEST_GETENV"
	os.Unsetenv(key)
	if got := getenv(key, "fallback"); got != "fallback" {
		t.Errorf("unset: got %q, want fallback", got)
	}
	os.Setenv(key, "set-value")
	defer os.Unsetenv(key)
	if got := getenv(key, "fallback"); got != "set-value" {
		t.Errorf("set: got %q, want set-value", got)
	}
}

func TestAtoiEnv(t *testing.T) {
	const key = "DGVPN_TEST_ATOIENV"
	cases := []struct {
		name string
		set  bool
		val  string
		want int
	}{
		{"unset uses fallback", false, "", 1055},
		{"valid int parsed", true, "2080", 2080},
		{"non-integer falls back", true, "not-a-number", 1055},
		{"blank falls back", true, "", 1055},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			os.Unsetenv(key)
			if c.set {
				os.Setenv(key, c.val)
				defer os.Unsetenv(key)
			}
			if got := atoiEnv(key, 1055); got != c.want {
				t.Errorf("atoiEnv(%q=%q) = %d, want %d", key, c.val, got, c.want)
			}
		})
	}
}
