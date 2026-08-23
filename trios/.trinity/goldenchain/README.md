# Golden chain, first link

One rule, two targets, and a check that fails when they disagree.

`rings/T27-00/queen_core.t27` is the Queen's decision core: retry verdicts,
failure kinds, and the review decision. `t27c gen-rust` lowers it to Rust.
`rings/SR-00/QueenRetryPolicy.swift` and `QueenReviewDecision.swift` are the
hand-written Swift the app actually runs.

`make chain` regenerates the Rust from the spec, builds both, runs both over a
fixed grid of 80 inputs, and diffs the two outputs. A single differing line is
the chain breaking: spec and code have drifted, and one of them is wrong.

Measured 2026-08-23: 80 of 80 identical, byte for byte.
