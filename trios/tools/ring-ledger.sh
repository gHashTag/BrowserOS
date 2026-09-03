#!/bin/sh
# ring-ledger.sh — write the ring ledger by counting the tree.
# gHashTag/trios#1279
#
# Walks rings/ and writes docs/ring-ledger.md with one table row per T27-*
# directory found there: the count of .t27 files under it, the total count
# of generated files under it, and, per t27c backend name, the count of
# that backend's output files (gen-rust -> .rs, gen -> .zig, gen-c -> .c,
# gen-verilog -> .v). The ledger also states whether the RING-00 parity
# script tests/t27/ring00_parity.sh exists and counts its assertion lines
# (lines matching "test " or "grep -q"), by counting them.
#
# The ledger records presence only: file counts taken from this tree. The
# script runs nothing (not t27c, not the parity script) and reads and
# writes only inside this repository; it never looks under /Users/playra/t27
# or anywhere else outside the tree it lives in.
#
# Usage: tools/ring-ledger.sh    (works from any directory)
#
# POSIX sh throughout: no arrays, no [[ ]], no local, no bash-only syntax.

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)

RINGS_DIR=$REPO_ROOT/rings
LEDGER=$REPO_ROOT/docs/ring-ledger.md
PARITY=$REPO_ROOT/tests/t27/ring00_parity.sh

# count_files DIR EXT — the number of regular files whose names end in EXT,
# anywhere under DIR, counted by find. 0 when there are none.
count_files() {
    find "$1" -type f -name "*$2" -print 2>/dev/null | wc -l | tr -d ' '
}

# ring_row DIR — one table row for the T27-* directory DIR: its name, the
# count of .t27 files under it, the total count of generated files under
# it, then one count per backend name. Presence, counted; the row says
# nothing about what anything runs or answers.
ring_row() {
    row_dir=$1
    row_name=${row_dir##*/}
    n_t27=$(count_files "$row_dir" .t27)
    n_rust=$(count_files "$row_dir" .rs)
    n_zig=$(count_files "$row_dir" .zig)
    n_c=$(count_files "$row_dir" .c)
    n_v=$(count_files "$row_dir" .v)
    n_gen=$((n_rust + n_zig + n_c + n_v))
    printf '| %s | %d | %d | %d | %d | %d | %d |\n' \
        "$row_name" "$n_t27" "$n_gen" "$n_rust" "$n_zig" "$n_c" "$n_v"
}

# --- collect one row per T27-* directory under rings/ ----------------------

rows=''
for dir in "$RINGS_DIR"/T27-*; do
    [ -d "$dir" ] || continue
    rows="$rows$(ring_row "$dir")
"
done

# --- the RING-00 parity script, stated by counting -------------------------

if [ -f "$PARITY" ]; then
    parity_exists=yes
    parity_count=$(grep -c -e 'test ' -e 'grep -q' "$PARITY" || true)
else
    parity_exists=no
    parity_count=0
fi

# --- write the ledger ------------------------------------------------------

mkdir -p "$(dirname -- "$LEDGER")"

{
    cat <<'HEAD'
# Ring ledger

Generated file: `tools/ring-ledger.sh` writes it by walking `rings/` and
counting. Do not edit it by hand — run the script again. gHashTag/trios#1279.

Presence only. Every number below is a count of files in this tree at the
moment the script ran: which `T27-*` directories exist under `rings/`, how
many `.t27` files and how many generated files sit under each, and, per
backend name, how many of that backend's output files sit under each. The
ledger records no run and no outcome; a row is a count of files, nothing
more.

## Rings

| Ring | `.t27` files | Generated files | `gen-rust` (`.rs`) | `gen` (`.zig`) | `gen-c` (`.c`) | `gen-verilog` (`.v`) |
|---|---:|---:|---:|---:|---:|---:|
HEAD
    printf '%s' "$rows"
    cat <<'MID'

One row per `T27-*` directory under `rings/`; a directory is in the table
because it is in the tree. `Generated files` is the sum of the four
backend columns. A backend column counts the files of its extension under
that ring's directory — `gen-rust` is the Rust backend (`.rs`), `gen` the
Zig one (`.zig`), `gen-c` the C one (`.c`), `gen-verilog` the Verilog one
(`.v`), the same pairing `tests/t27/ring00_parity.sh` and
`tests/t27/ring00_verilog.sh` generate with. A zero says no such file was
found under that ring; it says nothing else.

## RING-00 parity script

MID
    printf '%s\n' "- \`tests/t27/ring00_parity.sh\` exists: $parity_exists"
    printf '%s\n' "- lines in \`tests/t27/ring00_parity.sh\` matching \`test \` or \`grep -q\`, counted: $parity_count"
} >"$LEDGER"
