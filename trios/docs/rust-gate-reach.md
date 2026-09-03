# Rust gate reach: dotted extension predicates

Issue: gHashTag/trios#1371 — *The tmp-zero gate reports OK on a tree with 90 /tmp
references, because its extension list carries a leading dot.*

Audit tool: `trios/tools/rust-gate-extension-audit.mjs` (Node standard library
only; `cargo` is never invoked; no Rust file is read for anything but text and
no Rust file is edited).

## The defect class

Rust's `std::path::Path::extension()` returns the extension **without** its
leading dot — `Path::new("main.rs").extension()` is `Some("rs")`, not
`Some(".rs")`. A predicate that compares that value against a literal carrying
a leading dot can never match. The guarded arm is dead code; a gate built on it
visits zero files, finds zero violations, prints OK, and exits 0. A gate that
reports green while checking nothing is the most expensive kind of green.

The triggering instance, `trios/rings/RUST-99/tmp-zero-gate/src/main.rs`:

```rust
21 | const SOURCE_EXTS: &[&str] = &[".rs", ".swift"];
...
61 |         let ext = match path.extension().and_then(|s| s.to_str()) {
62 |             Some(e) if SOURCE_EXTS.contains(&e) => e,   // never true
63 |             _ => continue,
64 |         };
```

Every file hits `continue`, the violations list stays empty, and the gate prints
`[tmp-zero-gate] OK: no /tmp paths in workspace source.` on a tree where
`grep -rn '/tmp' rings/*/*/src/*.rs | wc -l` returns **90** (verified on this
worktree, branch `queen-1371`).

The crate's own unit test does not catch it, because it tests the constant, not
the comparison:

```rust
120 |         assert!(SOURCE_EXTS.contains(&".rs"));
121 |         assert!(SOURCE_EXTS.contains(&".swift"));
```

## Classification rule (printed by the audit on every run)

- **dotted** — at least one compared literal begins with `.`. That arm can
  never match; this is the finding class from trios#1371.
- **sound** — every compared literal is bare (no leading dot); the comparison
  works as written.
- **undetermined** — the compared literal set could not be extracted (the value
  is compared against a variable, or a membership receiver that does not
  resolve to a literal array). Reported with a reason and its own count.
  Undetermined is a distinct outcome from sound and is never counted as sound.

## Findings: one dotted predicate

### `trios/rings/RUST-99/tmp-zero-gate/src/main.rs:61` — DOTTED

- List: `SOURCE_EXTS` declared at `src/main.rs:21` = `[".rs", ".swift"]`,
  compared against `path.extension()` at line 61–62 via
  `SOURCE_EXTS.contains(&e)`.
- **One-line repair** (drop the leading dots):

  ```rust
  const SOURCE_EXTS: &[&str] = &["rs", "swift"];
  ```

- The unit test at `src/main.rs:119–122` asserts the constant itself and must
  change with it, or it will fail after the repair:

  ```rust
  assert!(SOURCE_EXTS.contains(&"rs"));
  assert!(SOURCE_EXTS.contains(&"swift"));
  ```

  Better still, a test that exercises `Path::extension()` against the constant
  would have caught the original defect; the current test cannot fail on the
  bug it guards.

**Why the repair was not applied here:** the worker image has no Rust toolchain
— there is no `rustc` and no `cargo` on PATH (verified: `which cargo rustc`
finds nothing). An unverifiable edit to a gate is worse than the broken gate,
because it looks fixed (issue FR-001). The change above is written where the
operator can apply and compile it.

## Full inventory (18 predicates, 27 files scanned)

Every constant list of extension strings used against `path.extension()` under
`trios/rings/RUST-*`, with file:line and classification. Line is the
`path.extension()` site; evidence literals are shown as compared.

| # | File:line | Compared literals | Outcome |
|---|-----------|-------------------|---------|
| 1 | trios/rings/RUST-99/tmp-zero-gate/src/main.rs:61 | `SOURCE_EXTS = [".rs", ".swift"]` (list at :21) | **dotted** |
| 2 | trios/rings/RUST-01/clade-build/src/main.rs:364 | `"swift"` | sound |
| 3 | trios/rings/RUST-04/clade-improve/src/pipeline.rs:330 | `"swift" \| "rs" \| "md"` | sound |
| 4 | trios/rings/RUST-05/clade-monitor/src/main.rs:345 | `"json"` | sound |
| 5 | trios/rings/RUST-07/clade-experience/src/main.rs:69 | `"json"` | sound |
| 6 | trios/rings/RUST-12/clade-audit/src/main.rs:230 | `"swift" \| "rs" \| "sh"` | sound |
| 7 | trios/rings/RUST-12/clade-audit/src/main.rs:298 | `"swift"` | sound |
| 8 | trios/rings/RUST-12/clade-audit/src/main.rs:366 | `"swift" \| "rs"` | sound |
| 9 | trios/rings/RUST-12/clade-audit/src/main.rs:434 | `"swift"` | sound |
| 10 | trios/rings/RUST-12/clade-audit/src/main.rs:533 | `"swift" \| "rs" \| "md"` | sound |
| 11 | trios/rings/RUST-12/clade-audit/src/main.rs:550 | `"md" \| "swift" \| "rs"` (match arms) | sound |
| 12 | trios/rings/RUST-12/clade-audit/src/main.rs:607 | `"swift" \| "rs"` | sound |
| 13 | trios/rings/RUST-12/clade-audit/src/main.rs:620 | `"swift" \| "rs"` | sound |
| 14 | trios/rings/RUST-12/clade-audit/src/main.rs:711 | `Some("json")` | sound |
| 15 | trios/rings/RUST-12/clade-audit/src/main.rs:742 | `Some("swift")` | sound |
| 16 | trios/rings/RUST-12/clade-audit/src/main.rs:850 | `"swift"` | sound |
| 17 | trios/rings/RUST-12/clade-audit/src/main.rs:1192 | `"md"` | sound |
| 18 | trios/rings/RUST-12/clade-audit/src/main.rs:1221 | `Some("json")` | sound |

Counts: **dotted=1 sound=17 undetermined=0**.

Note: `RUST-04/clade-improve/src/sandbox.rs:75` declares
`let ignore_extensions = [".key", ".pem"]`, but it is used with
`name.ends_with(ext)` on the file **name**, where the leading dot is required
and correct. It is not an `extension()` predicate and is not flagged. Dots are
only wrong on the `Path::extension()` side.

## Running the audit

```
$ node trios/tools/rust-gate-extension-audit.mjs
... (classification rule, inventory, counts) ...
counts: dotted=1 sound=17 undetermined=0
exit code: 1 while any dotted predicate exists (red is a FINDING), 0 otherwise.
$ echo $?
1

$ node trios/tools/rust-gate-extension-audit.mjs --selftest
  PASS  fixture walks exactly 3 files (trios-mesh excluded)
  ... (10 assertions) ...
selftest OK: one dotted, one sound, one undetermined; trios-mesh excluded.
$ echo $?
0
```

Scope: Rust sources under `trios/rings/RUST-*`, excluding the
`RUST-13/trios-mesh` git submodule, which cannot be reached from this
repository (issue FR-002; the exclusion is also asserted by the selftest).
