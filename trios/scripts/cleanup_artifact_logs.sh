#!/bin/bash
# Cleanup transient artifact logs in trios .trinity/logs and all git worktrees.
# Usage: bash scripts/cleanup_artifact_logs.sh [--apply] [--days N] [--cap N]
# Default: dry-run preview with 7-day age limit and 5-file cap per family.

set -euo pipefail

APPLY=0
DAYS=7
CAP=5

while [ $# -gt 0 ]; do
    case "$1" in
        --apply) APPLY=1 ;;
        --days) DAYS="$2"; shift ;;
        --cap) CAP="$2"; shift ;;
        -h|--help)
            echo "Usage: $0 [--apply] [--days N] [--cap N]"
            echo "  --apply  actually delete files (default is dry-run)"
            echo "  --days   age threshold in days (default: 7)"
            echo "  --cap    max files to keep per family (default: 5)"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
    shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NOW=$(date +%s)
AGE_SECONDS=$((DAYS * 86400))

# Families are glob patterns relative to a logs directory.
FAMILIES=(
    "build_*.log"
    "clade-build*.log"
    "clade-build_*.log"
    "chat_sse_e2e_build_*.log"
    "queen_autonomous_test_*.log"
    "*.stdout.log"
    "*.stderr.log"
    "clade_audit_cycle*.log"
    "clade_build_cycle*.log"
    "clade_seal_cycle*.log"
    "mesh_cycle*.log"
)

is_artifact() {
    local name="$1"
    local lower
    lower=$(echo "$name" | tr '[:upper:]' '[:lower:]')
    for pattern in "${FAMILIES[@]}"; do
        case "$lower" in
            ${pattern}) return 0 ;;
        esac
    done
    return 1
}

process_dir() {
    local dir="$1"
    local label="$2"
    [ -d "$dir" ] || return 0

    local deleted_count=0
    local deleted_bytes=0
    local family_groups=""

    # Age-based eviction across all artifact logs.
    for file in "$dir"/*.log; do
        [ -f "$file" ] || continue
        local name
        name=$(basename "$file")
        is_artifact "$name" || continue

        local mtime
        mtime=$(stat -f %m "$file" 2>/dev/null || stat -c %Y "$file" 2>/dev/null)
        if [ $((NOW - mtime)) -gt $AGE_SECONDS ]; then
            local size
            size=$(stat -f %z "$file" 2>/dev/null || stat -c %s "$file" 2>/dev/null)
            deleted_bytes=$((deleted_bytes + size))
            deleted_count=$((deleted_count + 1))
            if [ "$APPLY" -eq 1 ]; then
                rm -f "$file"
            else
                echo "[DRY-RUN $label] age-delete: $file"
            fi
        fi
    done

    # Count-based eviction per family.
    for pattern in "${FAMILIES[@]}"; do
        local files=()
        # Intentionally unquoted glob so the pattern expands.
        # shellcheck disable=SC2086
        for file in $dir/$pattern; do
            [ -f "$file" ] || continue
            files+=("$file")
        done
        [ ${#files[@]} -gt 0 ] || continue

        # Sort by mtime descending, keep the newest CAP.
        local sorted
        sorted=$(printf '%s\n' "${files[@]}" | xargs -I {} sh -c 'echo "$(stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null) $1"' _ {} | sort -rn | cut -d' ' -f2-)
        local kept=0
        local to_delete=()
        while IFS= read -r f; do
            [ -z "$f" ] && continue
            if [ "$kept" -lt "$CAP" ]; then
                kept=$((kept + 1))
            else
                to_delete+=("$f")
            fi
        done <<< "$sorted"

        if [ ${#to_delete[@]} -gt 0 ]; then
            for f in "${to_delete[@]}"; do
                local size
                size=$(stat -f %z "$f" 2>/dev/null || stat -c %s "$f" 2>/dev/null)
                deleted_bytes=$((deleted_bytes + size))
                deleted_count=$((deleted_count + 1))
                if [ "$APPLY" -eq 1 ]; then
                    rm -f "$f"
                else
                    echo "[DRY-RUN $label] cap-delete: $f"
                fi
            done
        fi
    done

    if [ "$APPLY" -eq 1 ] && [ "$deleted_count" -gt 0 ]; then
        local freed
        freed=$(echo "$deleted_bytes" | awk '{split("B KB MB GB TB PB",u); s=1; while($1>=1024 && s<6){$1/=1024; s++} printf "%.1f %s", $1, u[s]}')
        echo "[$label] Deleted $deleted_count artifact log(s), freed $freed"
    fi
}

# Main repo.
process_dir "$REPO_ROOT/.trinity/logs" "main"

# Git worktrees under .worktrees/.
if [ -d "$REPO_ROOT/.worktrees" ]; then
    for wt in "$REPO_ROOT/.worktrees"/*; do
        [ -d "$wt" ] || continue
        logs="$wt/trios/.trinity/logs"
        if [ -d "$logs" ]; then
            process_dir "$logs" "worktree:$(basename "$wt")"
        fi
    done
fi

if [ "$APPLY" -eq 0 ]; then
    echo "Run with --apply to execute the deletions."
fi
