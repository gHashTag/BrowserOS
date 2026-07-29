# WAVE-066 - Skills, money, nested traces, and an observer

Domain: Queen capability surface and pre-mortem supervision
Context: WAVE-065 closed the previous three options. This wave adds skills as a
first-class managed resource and closes the three it offered.

## Weak spots (audit)

| ID | Defect | Evidence |
|----|--------|----------|
| W1 | The Queen could reach 4 of 26 skills | `knownSkills` was a hardcoded Set in QueenStatusViewModel; writing a SKILL.md did nothing until someone edited Swift |
| W2 | No way to see or limit what she can run | No tab, no toggle, no list |
| W3 | Cost was in tokens only | "180k tokens" needs a lookup table the user does not have |
| W4 | Worker traces were flat | Every OTLP record was a sibling; a bee's work did not nest under the decision that created it |
| W5 | Supervision was entirely post-mortem | The review loop can only report a wasted turn after it is wasted |

## Plan

P0 (landed)
- W1/W2 `SkillCatalog` + `SkillStore` + `SkillsTabView` at Cmd+4;
  `/skills` lists them, `/<name>` runs any enabled one
- W3 `ModelPricing` longest-prefix table, `estimatedCostUSD` on the task,
  money in the banner and the digest, `SwarmBudget` daily ceiling
- W4 stable `traceId` per issue and `spanId` per worker conversation in the
  OTLP payload
- W5 `QueenObserver` reads the live transcript for looping, spinning,
  out-of-bounds writes and overspending, reported once per kind per task

P1 (next wave)
- Skill arguments and per-skill timeouts in the tab
- Cost per worker aggregated over time, not just per task
- Observer concern -> one-click cancel from the chat

P2 (backlog)
- Skills as worker briefs: hand a bee a skill rather than prose
- OTLP spans (not just logs) so duration shows in a waterfall
