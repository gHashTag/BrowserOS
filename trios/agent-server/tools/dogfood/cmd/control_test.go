package cmd

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"browseros-dogfood/ipc"
	"browseros-dogfood/runlog"
)

func TestFormatStatusDataUsesHumanReadableSummary(t *testing.T) {
	got := formatStatus(map[string]any{
		"state":         "running",
		"pid":           float64(123),
		"uptime":        "5s",
		"log_path":      "/tmp/browseros-dogfood/daemon.jsonl",
		"browseros_dir": "/tmp/browseros-dogfood",
		"ports": map[string]any{
			"CDP":       float64(9015),
			"Server":    float64(9115),
			"Extension": float64(9315),
		},
	})
	for _, want := range []string{
		"State: running",
		"PID: 123",
		"Uptime: 5s",
		"Ports: CDP=9015 Server=9115 Extension=9315",
		"BrowserOS dir: /tmp/browseros-dogfood",
		"Logs: /tmp/browseros-dogfood/daemon.jsonl",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("formatted status missing %q:\n%s", want, got)
		}
	}
}

func TestLogPathFromStatusDataPrefersDaemonValue(t *testing.T) {
	got := logPathFromStatusData(map[string]any{"log_path": "/tmp/daemon.jsonl"}, "/tmp/local.jsonl")
	if got != "/tmp/daemon.jsonl" {
		t.Fatalf("got %q want daemon log path", got)
	}
}

func TestLogPathFromStatusDataFallsBackToLocalPath(t *testing.T) {
	got := logPathFromStatusData(map[string]any{}, "/tmp/local.jsonl")
	if got != "/tmp/local.jsonl" {
		t.Fatalf("got %q want fallback log path", got)
	}
}

func TestBuildRestartRequestUsesPullAndForceArgs(t *testing.T) {
	got, err := buildRestartRequest(true, true)
	if err != nil {
		t.Fatal(err)
	}
	if got.Command != ipc.CmdRestart {
		t.Fatalf("command got %q want restart", got.Command)
	}
	if got.Args["pull"] != "true" || got.Args["force"] != "true" {
		t.Fatalf("args got %#v", got.Args)
	}
}

func TestBuildRestartRequestRejectsForceWithoutPull(t *testing.T) {
	if _, err := buildRestartRequest(false, true); err == nil {
		t.Fatal("expected force without pull to fail")
	}
}

func TestRootUsageShowsRestartPullAndOmitsUpdate(t *testing.T) {
	usage := stripANSI(rootCmd.UsageString())
	if !strings.Contains(usage, "restart          Rebuild/restart current checkout; --pull updates, --pull --force resets") {
		t.Fatalf("missing restart pull hint in\n%s", usage)
	}
	if strings.Contains(usage, "\n  update") {
		t.Fatalf("update should not appear in root usage:\n%s", usage)
	}
}

func TestMonitorDaemonUntilRunningPrintsEntriesAndStops(t *testing.T) {
	var out bytes.Buffer
	statusCalls := 0
	err := monitorDaemonUntilRunning(context.Background(), daemonMonitor{
		Out:          &out,
		PollInterval: time.Millisecond,
		Status: func() (ipc.Response, error) {
			statusCalls++
			if statusCalls == 1 {
				return ipc.Response{OK: true, Data: map[string]any{"state": "starting"}}, nil
			}
			return ipc.Response{OK: true, Data: map[string]any{"state": "running"}}, nil
		},
		Follow: func(ctx context.Context, onEntry func(runlog.Entry)) error {
			onEntry(runlog.Entry{Tag: "daemon", Line: "building agent"})
			<-ctx.Done()
			return nil
		},
	})
	if err != nil {
		t.Fatalf("monitor: %v", err)
	}
	if !strings.Contains(stripANSI(out.String()), "[daemon] building agent") {
		t.Fatalf("missing log entry in\n%s", out.String())
	}
}

func TestMonitorDaemonUntilRunningReturnsDaemonError(t *testing.T) {
	err := monitorDaemonUntilRunning(context.Background(), daemonMonitor{
		PollInterval: time.Millisecond,
		Status: func() (ipc.Response, error) {
			return ipc.Response{OK: true, Data: map[string]any{
				"state":      "error",
				"last_error": "server health check failed",
			}}, nil
		},
		Follow: func(ctx context.Context, onEntry func(runlog.Entry)) error {
			<-ctx.Done()
			return nil
		},
	})
	if err == nil || !strings.Contains(err.Error(), "server health check failed") {
		t.Fatalf("error got %v", err)
	}
}

func TestMonitorDaemonUntilRunningDetachesOnInterrupt(t *testing.T) {
	var out bytes.Buffer
	detach := make(chan struct{})
	close(detach)
	err := monitorDaemonUntilRunning(context.Background(), daemonMonitor{
		Out:          &out,
		Detach:       detach,
		PollInterval: time.Hour,
		Status: func() (ipc.Response, error) {
			return ipc.Response{OK: true, Data: map[string]any{"state": "starting"}}, nil
		},
		Follow: func(ctx context.Context, onEntry func(runlog.Entry)) error {
			<-ctx.Done()
			return nil
		},
	})
	if err != nil {
		t.Fatalf("monitor: %v", err)
	}
	if !strings.Contains(stripANSI(out.String()), "Detached; daemon still running.") {
		t.Fatalf("missing detach message in\n%s", out.String())
	}
}
