package cmd

import (
	"reflect"
	"strings"
	"testing"

	"browseros-dogfood/config"
)

func TestServerCommandDoesNotWatchFiles(t *testing.T) {
	got := serverCommand()
	want := []string{"bun", "--env-file=.env.development", "src/index.ts"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("server command got %#v want %#v", got, want)
	}
}

func TestReportProgressInvokesConfiguredProgress(t *testing.T) {
	var got []string
	reportProgress(environmentOptions{
		Progress: func(message string) {
			got = append(got, message)
		},
	}, "checking repo")

	want := []string{"checking repo"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("progress got %#v want %#v", got, want)
	}
}

func TestServerRuntimeEnvSetsBrowserOSDir(t *testing.T) {
	got := serverRuntimeEnv([]string{"PATH=/bin"}, config.Config{
		BrowserOSDir: "/tmp/browseros-dogfood",
		Ports:        config.Ports{CDP: 9015, Server: 9115, Extension: 9315},
	})

	assertEnvContains(t, got, "BROWSEROS_DIR=/tmp/browseros-dogfood")
}

func TestServerRuntimeEnvOverridesInheritedBrowserOSDir(t *testing.T) {
	got := serverRuntimeEnv([]string{
		"BROWSEROS_DIR=/tmp/wrong",
		"PATH=/bin",
	}, config.Config{
		BrowserOSDir: "/tmp/browseros-dogfood",
		Ports:        config.Ports{CDP: 9015, Server: 9115, Extension: 9315},
	})

	if strings.Contains(strings.Join(got, "\n"), "BROWSEROS_DIR=/tmp/wrong") {
		t.Fatalf("inherited BrowserOS dir was not overridden: %#v", got)
	}
	assertEnvContains(t, got, "BROWSEROS_DIR=/tmp/browseros-dogfood")
}

func assertEnvContains(t *testing.T, env []string, want string) {
	t.Helper()
	for _, entry := range env {
		if entry == want {
			return
		}
	}
	t.Fatalf("env missing %q: %#v", want, env)
}
