package proc

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestStartManagedRunsBeforeStartOnEachRetry(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2200*time.Millisecond)
	defer cancel()

	var count atomic.Int32
	var wg sync.WaitGroup

	StartManaged(ctx, &wg, ProcConfig{
		Tag:     TagInfo,
		Dir:     t.TempDir(),
		Restart: true,
		Cmd:     []string{"sh", "-c", "exit 1"},
		BeforeStart: func() error {
			count.Add(1)
			return nil
		},
	})

	wg.Wait()

	if count.Load() < 2 {
		t.Fatalf("expected BeforeStart to run on retries, got %d calls", count.Load())
	}
}

func TestStartManagedSkipsLaunchWhenBeforeStartFails(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sentinel := filepath.Join(t.TempDir(), "started")
	var wg sync.WaitGroup

	StartManaged(ctx, &wg, ProcConfig{
		Tag:     TagInfo,
		Dir:     t.TempDir(),
		Restart: false,
		Cmd:     []string{"sh", "-c", "touch " + sentinel},
		BeforeStart: func() error {
			return context.DeadlineExceeded
		},
	})

	wg.Wait()

	if _, err := os.Stat(sentinel); !os.IsNotExist(err) {
		t.Fatalf("expected process launch to be skipped, stat err=%v", err)
	}
}
