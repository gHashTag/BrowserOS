# RING-04 — where floating point lives in the supervisor, and what TNF replaces

Part of #1279. This document states what would be replaced and where. **It does
not claim TNF is applied**: no `.t27` module in this repository uses it, and
until a multiplier-free datapath agrees with the software answer the format is
not accepted here.

## The format

Ternary Network Floats: a sign bit, an exponent of `E_t` balanced-ternary
trits, and an `M`-bit mantissa, with `1 + E_t + M = N`.

The exponent budget follows the golden-section rule
`E = round((N - 1) / φ²)`, with `φ² = 2.618034`:

| N | E | M | Reach of the exponent |
|---|---|---|---|
| 8 | 3 | 4 | `3^3 = 27` steps |
| 16 | 6 | 9 | `3^6 = 729` steps |

The property that matters for silicon belongs to the **network**, not to the
format: a ternary network is multiplier-free because a weight is a code and
applying it is a choice of sign. TNF is the format the accumulator spends its
range on. Those are different claims and only the first is about hardware.

The article is `~/Downloads/TNF_статья_ru.md` (12 August 2026). The agent who
owns the t27 repository reports it measured at gate G8 — 19/19 tracts routed,
14/15 within seed noise, bin16 exactly 1.00×, LNS16 an honest 1.46× outlier.
Those are their numbers on their hardware and are not restated here as ours.

## Where `f64` actually is

Measured, not assumed. Counts are occurrences of `Double` in `rings/SR-00` and
`rings/SR-02`:

| File | Count | What the number is |
|---|---|---|
| `ModelReliabilityService.swift` | 30 | EMA of success, `alpha = 0.3`, values in `[0, 1]` |
| `StreamingContextWatchdog.swift` | 18 | ratios of a context window, `[0, 1]` |
| `TriosVisualTheme.swift` | 16 | opacities and corner radii — interface, not scoring |
| `ModelPricing.swift` | 12 | money, `0.00`–`1.25` per million tokens |
| `ChatViewModel.swift` | 11 | mixed: delays in seconds, ratios |
| `StreamingContextLimitLearner.swift` | 10 | EMA, `alpha = 0.3` |
| `WarmupVolatilityTracker.swift` | 9 | volatility, `[0, 1]` |
| `ProviderCircuitBreaker.swift` | 9 | failure rate, `[0, 1]` |
| `ChatRequestSizer.swift` | 9 | ratios of a budget, `[0, 1]` |

## Three answers, not one

The interesting result of measuring is that **most of this should not become
TNF at all.**

### Salience does not need a fraction

`QueenSalience` is the supervisor's ranking function and the natural first
candidate. Its weights are `40, 25, 20, 15`, age is `1.0` per hour to a ceiling
of `24.0`, and the learned ceiling is `40.0`. Every quantity is an integer with
a dynamic range under 64.

It is a weighted integer sum wearing a float. Converting it to TNF would be
replacing one unnecessary format with a more interesting unnecessary format;
converting it to `i32` removes a class of bug — ordering that depends on the
last bit of a sum — and costs nothing.

**Verdict: integers, not TNF.**

### Money must not be a float, and must not be TNF either

`ModelPricing` carries dollars. Both binary floats and ternary floats represent
`0.10` approximately, and a supervisor that accumulates approximate money and
then compares against a budget threshold has a defect that appears only after
enough additions.

The fix for money is integer minor units — micro-dollars in `i64` — which is
the same answer the rest of the industry reached and has nothing to do with
which float you were going to use.

**Verdict: integer micro-dollars, not TNF.**

### Bounded ratios are where TNF belongs

What is left is the honest candidate set, and it has one shape: quantities in
`[0, 1]` that are combined by exponential moving averages.

- reliability EMA, `alpha = 0.3`
- context-limit learner EMA, `alpha = 0.3`
- warm-up volatility
- circuit-breaker failure rate
- request-size and watchdog ratios

These need fractions, need no range to speak of, and are combined by repeated
`new = alpha * x + (1 - alpha) * old`. A short mantissa is sufficient and the
exponent buys nothing above `N = 8`, which is exactly the regime the ladder is
for.

**Verdict: the candidate set for ring 04 is the EMA family and nothing else.**

## How the substitution would be checked

Not by reading the generated code.

1. The ring is written in `.t27` and generated to both Rust and Verilog from
   one source, as ring 00 already is.
2. A shared table of inputs runs through the Swift that runs today, the
   generated Rust, and the simulated Verilog. The three must agree.
3. Agreement is stated as a tolerance, because that is the whole subject: an
   EMA in a 4-bit mantissa will not equal an `f64` EMA bit for bit. The
   tolerance is the claim being made, and it must be written down before the
   comparison rather than chosen after seeing the disagreement.
4. The multiplier-free datapath must produce the same ordering. Ranking is what
   these numbers are for, and two scores that differ by less than the format
   can represent must not swap places — an ordering inversion is the failure
   that matters, not the absolute error.

Until step 4 passes on hardware, this document describes an intention.

## What is deliberately not decided here

Which rung. `N = 8` with `E = 3` is the obvious starting point for `[0, 1]`
quantities, but choosing it belongs to the measurement in step 3, not to a
document written before it.
