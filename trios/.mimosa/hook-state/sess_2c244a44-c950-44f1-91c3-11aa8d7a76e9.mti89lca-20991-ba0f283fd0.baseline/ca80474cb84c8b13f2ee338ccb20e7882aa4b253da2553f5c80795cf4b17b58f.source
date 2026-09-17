package cmd

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"browseros-cli/config"
)

func TestSetVersionUpdatesRootCommand(t *testing.T) {
	originalVersion := version
	originalRootVersion := rootCmd.Version
	t.Cleanup(func() {
		version = originalVersion
		rootCmd.Version = originalRootVersion
	})

	SetVersion("1.2.3")

	if version != "1.2.3" {
		t.Fatalf("version = %q, want %q", version, "1.2.3")
	}
	if rootCmd.Version != "1.2.3" {
		t.Fatalf("rootCmd.Version = %q, want %q", rootCmd.Version, "1.2.3")
	}
}

func TestCommandName(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{"empty args", nil, "unknown"},
		{"known command", []string{"health"}, "browseros-cli health"},
		{"unknown command", []string{"nonexistent"}, "unknown"},
		{"subcommand", []string{"bookmark", "search"}, "browseros-cli bookmark search"},
		{"strata subcommand", []string{"strata", "check"}, "browseros-cli strata check"},
		{"known with extra args", []string{"snap", "--enhanced"}, "browseros-cli snap"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := commandName(tt.args)
			if got != tt.want {
				t.Errorf("commandName(%v) = %q, want %q", tt.args, got, tt.want)
			}
		})
	}
}

func TestPrimaryCommand(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{"empty", nil, ""},
		{"root flag then command", []string{"--json", "update"}, "update"},
		{"subcommand", []string{"bookmark", "update"}, "bookmark"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := primaryCommand(tt.args); got != tt.want {
				t.Fatalf("primaryCommand(%v) = %q, want %q", tt.args, got, tt.want)
			}
		})
	}
}

func TestRequestedBoolFlag(t *testing.T) {
	if !requestedBoolFlag([]string{"--json"}, "--json", false) {
		t.Fatal("requestedBoolFlag() = false, want true")
	}
	if !requestedBoolFlag([]string{"--debug=true"}, "--debug", false) {
		t.Fatal("requestedBoolFlag() with assignment = false, want true")
	}
	if requestedBoolFlag([]string{"--debug=false"}, "--debug", false) {
		t.Fatal("requestedBoolFlag() with false assignment = true, want false")
	}
}

func TestShouldSkipAutomaticUpdates(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want bool
	}{
		{"short help flag", []string{"-h"}, true},
		{"help flag", []string{"--help"}, true},
		{"version flag", []string{"--version"}, true},
		{"update command", []string{"update"}, true},
		{"bookmark update subcommand", []string{"bookmark", "update"}, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldSkipAutomaticUpdates(tt.args); got != tt.want {
				t.Fatalf("shouldSkipAutomaticUpdates(%v) = %t, want %t", tt.args, got, tt.want)
			}
		})
	}
}

func TestDefaultServerURLUsesEnvBeforeConfig(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("BROWSEROS_URL", "http://127.0.0.1:9115/mcp")

	if err := config.Save(&config.Config{ServerURL: "http://127.0.0.1:9000/mcp"}); err != nil {
		t.Fatalf("config.Save() error = %v", err)
	}

	got := defaultServerURL()
	if got != "http://127.0.0.1:9115" {
		t.Fatalf("defaultServerURL() = %q, want %q", got, "http://127.0.0.1:9115")
	}
}

func TestDefaultServerURLUsesSavedConfig(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("BROWSEROS_URL", "")

	if err := config.Save(&config.Config{ServerURL: "http://127.0.0.1:9115/mcp"}); err != nil {
		t.Fatalf("config.Save() error = %v", err)
	}

	got := defaultServerURL()
	if got != "http://127.0.0.1:9115" {
		t.Fatalf("defaultServerURL() = %q, want %q", got, "http://127.0.0.1:9115")
	}
}

func TestDefaultServerURLIgnoresBrowserOSServerJSON(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("BROWSEROS_URL", "")

	serverDir := filepath.Join(home, ".browseros")
	if err := os.MkdirAll(serverDir, 0755); err != nil {
		t.Fatalf("os.MkdirAll() error = %v", err)
	}
	data := []byte(`{"url":"http://127.0.0.1:9999"}`)
	if err := os.WriteFile(filepath.Join(serverDir, "server.json"), data, 0644); err != nil {
		t.Fatalf("os.WriteFile() error = %v", err)
	}

	if got := defaultServerURL(); got != "" {
		t.Fatalf("defaultServerURL() = %q, want empty", got)
	}
}

func TestNormalizeServerURLAcceptsMCPEndpoint(t *testing.T) {
	got := normalizeServerURL(" http://127.0.0.1:9115/mcp ")
	if got != "http://127.0.0.1:9115" {
		t.Fatalf("normalizeServerURL() = %q, want %q", got, "http://127.0.0.1:9115")
	}
}

func TestValidateServerURLExplainsManualInit(t *testing.T) {
	_, err := validateServerURL("")
	if err == nil {
		t.Fatal("validateServerURL() error = nil, want setup instructions")
	}
	msg := err.Error()
	if !strings.Contains(msg, "browseros-cli init <Server URL>") {
		t.Fatalf("validateServerURL() error = %q, want manual init instructions", msg)
	}
	if strings.Contains(msg, "init --auto") {
		t.Fatalf("validateServerURL() error = %q, should not mention init --auto", msg)
	}
}

func TestDrainAutomaticUpdateCheckWithTimeoutWaitsForCompletion(t *testing.T) {
	done := make(chan struct{})
	returned := make(chan struct{})

	go func() {
		drainAutomaticUpdateCheckWithTimeout(done, time.Second)
		close(returned)
	}()

	select {
	case <-returned:
		t.Fatal("drainAutomaticUpdateCheckWithTimeout() returned before check completed")
	case <-time.After(10 * time.Millisecond):
	}

	close(done)

	select {
	case <-returned:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("drainAutomaticUpdateCheckWithTimeout() did not return after check completed")
	}
}

func TestDrainAutomaticUpdateCheckWithTimeoutStopsWaiting(t *testing.T) {
	done := make(chan struct{})
	returned := make(chan struct{})

	go func() {
		drainAutomaticUpdateCheckWithTimeout(done, 20*time.Millisecond)
		close(returned)
	}()

	select {
	case <-returned:
		t.Fatal("drainAutomaticUpdateCheckWithTimeout() returned before timeout elapsed")
	case <-time.After(5 * time.Millisecond):
	}

	select {
	case <-returned:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("drainAutomaticUpdateCheckWithTimeout() did not return after timeout")
	}
}
