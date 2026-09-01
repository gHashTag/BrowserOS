# Queen Coding Plan Budget Mode

Issue: `gHashTag/trios#1300`

## Evidence boundary

- OBSERVED: production selects provider `zai`, model `glm-5.3`, and exposes two distinct non-empty worker credentials.
- OBSERVED: the latest Queen decision refuses all new work because an estimated token price total of about `$10.23` exceeds the default `$10` daily cap.
- OBSERVED: the current `ModelPricing` table maps every `glm-5.*` model, including `glm-5.3`, to an estimated pay-as-you-go USD rate.
- SOURCE-CLAIM: Z.ai documents GLM Coding Plan as a subscription quota with provider-side reset windows; supported-plan calls do not consume account balance after the quota is exhausted.
- UNKNOWN: the remaining quota of either production account. No local token estimate can establish it.

## Observable contract

1. Billing semantics are explicit. `TRIOS_SWARM_BILLING_MODE` accepts exactly `api_metered` or `coding_plan`.
2. Missing, empty, or unrecognized values resolve conservatively to `api_metered`.
3. In `api_metered` mode, the existing estimated USD daily cap is unchanged and can refuse a new Bee.
4. In `coding_plan` mode, estimated USD remains telemetry but cannot refuse a new Bee. Provider quota and rate-limit responses remain authoritative runtime outcomes.
5. The public Queen status reports the resolved billing mode and whether the estimated USD start gate is enabled. It never exposes credentials, usage bodies, or private provider details.
6. Concurrency, unique-credential assignment, boundary collision, claim, specification quality, review, retry, and eligibility decisions are unchanged.
7. Production may enable `coding_plan` only through an explicit environment setting. The code must not infer subscription status from `glm-5.3`, the Z.ai hostname, or the Coding endpoint.

## Acceptance criteria

- A deterministic pre-implementation test fails because no billing-mode type or parsing contract exists.
- Focused Swift tests prove explicit `coding_plan`, explicit `api_metered`, and conservative fallback behavior.
- A `queend choose` regression proves an over-cap task set is refused in `api_metered` and can proceed to the existing candidate rules in `coding_plan`.
- Public-status route tests prove only the resolved mode and gate state are projected.
- `make queen-core-sync`, `make queen-core`, focused Bun tests, and the exact server build pass.
- Independent review finds no bypass of non-budget gates.
- The reviewed commit is pushed and deployed before `TRIOS_SWARM_BILLING_MODE=coding_plan` is enabled.
- Live status reports `coding_plan`, the synthetic USD refusal disappears, and at least one production dispatch starts. With two eligible tasks and two healthy keys, the target observation is two concurrent dispatches.

## Non-goals

- Do not raise or delete the existing API-metered daily cap.
- Do not fabricate Z.ai plan quota or account balance.
- Do not add, reveal, rotate, or copy credentials.
- Do not change Queen concurrency above four.
- Do not rewrite historical registry tasks, review cards, checkpoints, or provider events.
