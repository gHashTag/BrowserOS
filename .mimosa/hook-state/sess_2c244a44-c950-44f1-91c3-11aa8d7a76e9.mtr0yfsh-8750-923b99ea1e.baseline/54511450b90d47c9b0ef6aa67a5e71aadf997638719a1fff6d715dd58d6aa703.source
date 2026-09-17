package engine

import (
	"context"
	"fmt"

	"github.com/browseros-ai/BrowserOS/packages/browseros/tools/patch/internal/git"
	"github.com/browseros-ai/BrowserOS/packages/browseros/tools/patch/internal/repo"
)

type PublishResult struct {
	Remote  string `json:"remote"`
	Branch  string `json:"branch"`
	Message string `json:"message"`
}

type PublishOptions struct {
	Repo     *repo.Info
	Remote   string
	Message  string
	Progress Progress
}

// Publish commits chromium_patches changes and pushes them to the selected remote.
func Publish(ctx context.Context, opts PublishOptions) (*PublishResult, error) {
	if opts.Remote == "" {
		opts.Remote = "origin"
	}
	if opts.Message == "" {
		opts.Message = "chore: update chromium patches"
	}
	reportProgress(opts.Progress, "Checking chromium_patches changes")
	dirty, err := git.IsDirtyPaths(ctx, opts.Repo.Root, []string{"chromium_patches"})
	if err != nil {
		return nil, err
	}
	if !dirty {
		return nil, fmt.Errorf("nothing to publish: chromium_patches has no uncommitted changes")
	}
	reportProgress(opts.Progress, "Staging chromium_patches")
	if err := git.AddPaths(ctx, opts.Repo.Root, []string{"chromium_patches"}); err != nil {
		return nil, err
	}
	reportProgress(opts.Progress, "Committing chromium_patches")
	if err := git.Commit(ctx, opts.Repo.Root, opts.Message); err != nil {
		return nil, err
	}
	branch, err := git.CurrentBranch(ctx, opts.Repo.Root)
	if err != nil {
		return nil, err
	}
	reportProgress(opts.Progress, "Pushing patch repo to %s/%s", opts.Remote, branch)
	if err := git.Push(ctx, opts.Repo.Root, opts.Remote, branch); err != nil {
		return nil, err
	}
	return &PublishResult{Remote: opts.Remote, Branch: branch, Message: opts.Message}, nil
}
