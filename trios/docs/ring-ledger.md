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
| T27-00 | 1 | 0 | 0 | 0 | 0 | 0 |
| T27-01 | 1 | 0 | 0 | 0 | 0 | 0 |

One row per `T27-*` directory under `rings/`; a directory is in the table
because it is in the tree. `Generated files` is the sum of the four
backend columns. A backend column counts the files of its extension under
that ring's directory — `gen-rust` is the Rust backend (`.rs`), `gen` the
Zig one (`.zig`), `gen-c` the C one (`.c`), `gen-verilog` the Verilog one
(`.v`), the same pairing `tests/t27/ring00_parity.sh` and
`tests/t27/ring00_verilog.sh` generate with. A zero says no such file was
found under that ring; it says nothing else.

## RING-00 parity script

- `tests/t27/ring00_parity.sh` exists: yes
- lines in `tests/t27/ring00_parity.sh` matching `test ` or `grep -q`, counted: 2
