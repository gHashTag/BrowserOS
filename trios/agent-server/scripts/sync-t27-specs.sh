#!/usr/bin/env bash
# Refresh trios/agent-server/specs from a checkout of gHashTag/t27 (the cards
# and the scheduler contract) and gHashTag/trinity (the compiler wasm the site
# serves), then rewrite specs/PIN with what was copied. Nothing here edits a
# card: the source of truth stays in t27, this directory is a vendored copy.
#
#   T27_ROOT=~/t27 TRINITY_ROOT=~/trinity scripts/sync-t27-specs.sh
#   cd apps/server && bun test tests/api/queen-inngest.test.ts
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
t27="${T27_ROOT:?set T27_ROOT to a gHashTag/t27 checkout}"
trinity="${TRINITY_ROOT:?set TRINITY_ROOT to a gHashTag/trinity checkout}"
dst="$here/specs"

mkdir -p "$dst/crons" "$dst/skills" "$dst/automation"
rm -f "$dst"/crons/*.t27 "$dst"/skills/*.t27
cp "$t27"/specs/crons/*.t27 "$dst/crons/"
cp "$t27"/specs/skills/*.t27 "$dst/skills/"
cp "$t27"/specs/automation/inngest-queen-scheduler.t27 "$dst/automation/"
cp "$trinity"/apps/website/public/t27/t27_compiler.wasm "$dst/t27_compiler.wasm"

t27_sha="$(git -C "$t27" rev-parse --short=8 HEAD)"
t27_ref="$(git -C "$t27" rev-parse --abbrev-ref HEAD)"
trinity_sha="$(git -C "$trinity" rev-parse --short=8 HEAD)"
wasm_sha="$(sha256sum "$dst/t27_compiler.wasm" | cut -d' ' -f1)"

cat >"$dst/PIN" <<EOF
source: gHashTag/t27 $t27_ref @ $t27_sha (specs/crons, specs/skills, specs/automation/inngest-queen-scheduler.t27), byte-identical
wasm: gHashTag/trinity @ $trinity_sha apps/website/public/t27/t27_compiler.wasm sha256 $wasm_sha
refresh: scripts/sync-t27-specs.sh (T27_ROOT, TRINITY_ROOT), then bun test tests/api/queen-inngest.test.ts
EOF

echo "crons:  $(ls "$dst"/crons/*.t27 | wc -l)"
echo "skills: $(ls "$dst"/skills/*.t27 | wc -l)"
cat "$dst/PIN"
