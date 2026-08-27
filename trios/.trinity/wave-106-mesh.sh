#!/bin/bash
# Волна 106: перемер byte-идентичности меш-артефактов живьём.
# Свежая генерация каждой спеки сравнивается с коммиченным артефактом.
set -u
cd /Users/playra/BrowserOS/trios
T27C=.trinity/t27c-build/release/t27c
D=$(mktemp -d /tmp/tri_mesh_remeasure.XXXXXX)
trap 'rm -rf "$D"' EXIT
N=0; SAME=0
for f in rings/RUST-13/trios-mesh/specs/*.t27; do
  b=$(basename "$f" .t27)
  committed="rings/RUST-13/trios-mesh/gen/rust/$b.rs"
  [ -f "$committed" ] || continue
  N=$((N+1))
  "$T27C" gen-rust "$f" > "$D/$b.rs" 2>/dev/null
  cmp -s "$committed" "$D/$b.rs" && SAME=$((SAME+1))
done
echo "committed=$N byte-identical=$SAME"
