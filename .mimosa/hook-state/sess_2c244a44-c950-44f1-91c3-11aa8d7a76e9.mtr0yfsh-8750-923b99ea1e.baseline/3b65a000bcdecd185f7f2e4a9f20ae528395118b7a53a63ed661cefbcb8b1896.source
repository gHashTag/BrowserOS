package engine

import "fmt"

// Progress receives concise updates for operations that can take noticeable time.
type Progress interface {
	Step(message string)
}

type ProgressFunc func(message string)

// Step sends one progress message through f.
func (f ProgressFunc) Step(message string) {
	f(message)
}

func reportProgress(progress Progress, format string, args ...any) {
	if progress == nil {
		return
	}
	progress.Step(fmt.Sprintf(format, args...))
}
