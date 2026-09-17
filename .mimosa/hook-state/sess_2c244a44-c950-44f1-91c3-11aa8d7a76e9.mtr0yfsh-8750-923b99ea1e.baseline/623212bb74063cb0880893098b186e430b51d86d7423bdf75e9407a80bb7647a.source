package engine

import (
	"context"

	"github.com/browseros-ai/BrowserOS/packages/browseros/tools/patch/internal/git"
	"github.com/browseros-ai/BrowserOS/packages/browseros/tools/patch/internal/patch"
	"github.com/browseros-ai/BrowserOS/packages/browseros/tools/patch/internal/repo"
	"github.com/browseros-ai/BrowserOS/packages/browseros/tools/patch/internal/resolve"
	"github.com/browseros-ai/BrowserOS/packages/browseros/tools/patch/internal/workspace"
)

type WorkspaceStatus struct {
	Workspace      workspace.Entry `json:"workspace"`
	RepoHead       string          `json:"repo_head"`
	BaseCommit     string          `json:"base_commit"`
	LastApplyRev   string          `json:"last_apply_rev,omitempty"`
	LastSyncRev    string          `json:"last_sync_rev,omitempty"`
	LastExtractRev string          `json:"last_extract_rev,omitempty"`
	ActiveResolve  bool            `json:"active_resolve"`
	NeedsApply     []string        `json:"needs_apply"`
	NeedsUpdate    []string        `json:"needs_update"`
	Orphaned       []string        `json:"orphaned"`
	UpToDate       []string        `json:"up_to_date"`
	SyncState      string          `json:"sync_state"`
}

type InspectWorkspaceOptions struct {
	Workspace workspace.Entry
	Repo      *repo.Info
	Progress  Progress
}

// InspectWorkspace compares a workspace against the patch repo and classifies drift.
func InspectWorkspace(ctx context.Context, opts InspectWorkspaceOptions) (*WorkspaceStatus, error) {
	reportProgress(opts.Progress, "Inspecting workspace drift")
	head, err := git.HeadRev(ctx, opts.Repo.Root)
	if err != nil {
		return nil, err
	}
	state, err := workspace.LoadState(opts.Workspace.Path)
	if err != nil {
		return nil, err
	}
	reportProgress(opts.Progress, "Loading repo patch set")
	repoSet, err := patch.LoadRepoPatchSet(opts.Repo.PatchesDir, nil)
	if err != nil {
		return nil, err
	}
	reportProgress(opts.Progress, "Building workspace patch set")
	localSet, err := patch.BuildWorkingTreePatchSet(ctx, opts.Workspace.Path, opts.Repo.BaseCommit, nil)
	if err != nil {
		return nil, err
	}
	status := &WorkspaceStatus{
		Workspace:      opts.Workspace,
		RepoHead:       head,
		BaseCommit:     opts.Repo.BaseCommit,
		LastApplyRev:   state.LastApplyRev,
		LastSyncRev:    state.LastSyncRev,
		LastExtractRev: state.LastExtractRev,
		ActiveResolve:  resolve.Exists(opts.Workspace.Path),
	}
	for _, delta := range patch.Compare(repoSet, localSet) {
		switch delta.Kind {
		case patch.NeedsApply:
			status.NeedsApply = append(status.NeedsApply, delta.Path)
		case patch.NeedsUpdate:
			status.NeedsUpdate = append(status.NeedsUpdate, delta.Path)
		case patch.Orphaned:
			status.Orphaned = append(status.Orphaned, delta.Path)
		case patch.UpToDate:
			status.UpToDate = append(status.UpToDate, delta.Path)
		}
	}
	status.SyncState = inferSyncState(status)
	return status, nil
}

func inferSyncState(status *WorkspaceStatus) string {
	switch {
	case status.ActiveResolve:
		return "conflicted"
	case status.LastSyncRev == "":
		return "never-synced"
	case status.LastSyncRev != status.RepoHead:
		return "needs-sync"
	case len(status.NeedsApply) > 0:
		return "drifted"
	case len(status.NeedsUpdate) > 0 || len(status.Orphaned) > 0:
		return "local-changes"
	default:
		return "synced"
	}
}
