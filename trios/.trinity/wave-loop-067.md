# WAVE-067 - Skills in context, skill briefs, one-click stop, skill editor

Domain: Queen capability awareness and control
Context: WAVE-066 gave the Queen a skills tab. This wave found she still could
not see the skills, and closed the three options it offered.

## Weak spots (audit)

| ID | Defect | Evidence |
|----|--------|----------|
| W1 | Skills were not in the Queen's context at all | `SkillStore.summaryLines` had zero call sites; the model driving her chat had no idea any skill existed |
| W2 | A brief paraphrased a procedure instead of carrying it | `--skill` did not exist; briefs drifted from the SKILL.md they described |
| W3 | Nothing could stop a running bee | The observer could say a worker was looping and the only response was to wait |
| W4 | Skills could only be edited outside the app | Reveal in Finder was the whole story |
| W5 | The Queen invented a skill's on/off state | Given only a roster, she told the user a switched-on skill was off |
| W6 | A `/skills` listing became a permanent fact | An undated snapshot in the transcript outranked the live roster |

## Plan

P0 (landed)
- W1 `QueenSystemPrompt` composed into `userSystemPrompt` for the Queen's
  conversation, with a payload probe logging `system_chars` / `system_skills`
- W5 the roster is labelled as the enabled set, with the disabled list stated
- W6 `/skills` output is stamped `As of HH:MM` and the charter declares itself
  authoritative over scrollback

P1 (landed)
- W2 `/delegate ... --skill /name` hands the SKILL.md body to the worker
  verbatim, refusing rather than briefing without it
- W3 `/cancel <issue> [why]` plus a Stop button in the swarm strip and the task
  banner
- W4 in-tab editing with frontmatter validation on save

P2 (next wave)
- Skill arguments and per-skill timeouts
- Worker-side skill roster, so a bee can pick a procedure too
- Diff view before saving an edited skill
