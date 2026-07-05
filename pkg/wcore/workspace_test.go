package wcore

import (
	"testing"
)

func TestShortHostname(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"server.example.com", "server"},
		{"server.example.com:2222", "server"},
		{"db.prod.example.com", "db"},
		{"localhost", "localhost"},
		{"192.168.1.50", "192.168.1.50"},
		{"192.168.1.50:2222", "192.168.1.50"},
		{"[2001:db8::1]", "2001:db8::1"},
		{"[2001:db8::1]:2222", "2001:db8::1"},
		{"DESKTOP-ABCDEF", "desktop-abcdef"},
		{"Jeremys-MacBook-Pro.local", "jeremys-macbook-pro"},
		{"barehost", "barehost"},
		{":2222", ""},
	}
	for _, tc := range tests {
		t.Run(tc.input, func(t *testing.T) {
			got := shortHostname(tc.input)
			if got != tc.expected {
				t.Errorf("shortHostname(%q) = %q, want %q", tc.input, got, tc.expected)
			}
		})
	}
}

func TestMakeUniqueTabName(t *testing.T) {
	t.Run("no collision", func(t *testing.T) {
		got := makeUniqueTabName("server", []string{"T1", "devbox"})
		if got != "server" {
			t.Errorf("got %q, want %q", got, "server")
		}
	})
	t.Run("single collision", func(t *testing.T) {
		got := makeUniqueTabName("server", []string{"T1", "server"})
		if got != "server (2)" {
			t.Errorf("got %q, want %q", got, "server (2)")
		}
	})
	t.Run("double collision", func(t *testing.T) {
		got := makeUniqueTabName("server", []string{"T1", "server", "server (2)"})
		if got != "server (3)" {
			t.Errorf("got %q, want %q", got, "server (3)")
		}
	})
	t.Run("user-renamed collision", func(t *testing.T) {
		got := makeUniqueTabName("server", []string{"T1", "prod-server", "server"})
		if got != "server (2)" {
			t.Errorf("got %q, want %q", got, "server (2)")
		}
	})
}

func TestGetTabNameFromConn(t *testing.T) {
	tests := []struct {
		connName      string
		existingNames []string
		expected      string
	}{
		{"user@server.example.com", nil, "server"},
		{"user@server.example.com:2222", nil, "server"},
		{"user@db.prod.example.com", nil, "db"},
		{"user@192.168.1.50", nil, "192.168.1.50"},
		{"user@192.168.1.50:2222", nil, "192.168.1.50"},
		{"user@[2001:db8::1]", nil, "2001:db8::1"},
		{"user@[2001:db8::1]:2222", nil, "2001:db8::1"},
		{"user@myalias", nil, "myalias"},
		{"justhost", nil, "justhost"},
		{"user@DESKTOP-ABCDEF", nil, "desktop-abcdef"},
		{"user@localhost", nil, "localhost"},
		{"user@", nil, ""},
		{"user@server.example.com", []string{"server"}, "server (2)"},
	}
	for _, tc := range tests {
		t.Run(tc.connName, func(t *testing.T) {
			got := getTabNameFromConn(tc.connName, tc.existingNames)
			if got != tc.expected {
				t.Errorf("getTabNameFromConn(%q) = %q, want %q", tc.connName, got, tc.expected)
			}
		})
	}
}
