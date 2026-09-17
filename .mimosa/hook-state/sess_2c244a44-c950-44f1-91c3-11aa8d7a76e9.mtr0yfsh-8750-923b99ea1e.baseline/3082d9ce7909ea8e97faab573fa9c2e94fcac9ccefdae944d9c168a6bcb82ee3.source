---
name: document-internal
description: Draft a 1-page internal doc (feature, architecture, or design) for the private browseros-ai/internal-docs repo. Use when wrapping up a feature on a branch, after the PR is open or about to be opened. Skill drafts from the diff, asks four sharp questions, enforces voice rules, and opens a PR to internal-docs.
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
---

# Document Internal

Draft a 1-page internal doc (feature note, architecture note, or design spec) from the current branch's diff and open a PR to `browseros-ai/internal-docs`.

**Announce at start:** "I'm using the document-internal skill to draft a doc for internal-docs."

## When to use

After finishing implementation on a feature branch, when the work is doc-worthy (a major feature, a new subsystem, a setup runbook for something internal, or a design decision that future engineers need to know).

## Hard rules — never do these

- NEVER `git add -A` or `git add .` inside the tmp clone of internal-docs. Always specific paths.
- NEVER write outside the tmp clone (no spillover into the OSS repo's working tree).
- NEVER fabricate filler content for empty template sections. Empty stays empty.
- NEVER touch the OSS repo's `.gitmodules` or submodule pointer — the sync workflow handles that.
- NEVER run this skill if `.internal-docs/` is missing. Stop with the init command.
- NEVER push to `internal-docs/main` directly. Always a feature branch + PR.

## Voice rules — enforced by Step 4

The skill MUST follow these and refuse to draft otherwise. After generation, scan for violations and regenerate offending sentences (max 3 attempts).

- Lead with the point. First sentence answers "what is this?"
- Concrete nouns. Name files, functions, commands. Not "the system" or "the component".
- Short sentences. Average <20 words. No deeply nested clauses.
- Active voice. "X does Y" not "Y is done by X".
- No em dashes. Use commas, periods, or rephrase.
- Banned words: delve, crucial, robust, comprehensive, nuanced, multifaceted, furthermore, moreover, additionally, pivotal, landscape, tapestry, underscore, foster, showcase, intricate, vibrant, fundamental, significant, leverage, utilize.
- "110 IQ" target. Write for a smart engineer who has not seen this code yet.
- No filler intros ("This document describes..."). Start with the substance.
- Empty sections stay empty. Do not write "N/A" or fabricate content.

## Workflow

### Step 0: Pre-flight

Bail with a clear message on any failure.

```bash
# Submodule must be initialized
if git submodule status .internal-docs 2>/dev/null | grep -q '^-'; then
  echo "internal-docs submodule not initialized. Run: git submodule update --init .internal-docs"
  exit 0
fi
[ -d .internal-docs ] || { echo ".internal-docs/ missing. Submodule not configured?"; exit 0; }

# Must be on a feature branch
BRANCH=$(git branch --show-current)
if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "dev" ]; then
  echo "On $BRANCH. Run from a feature branch."
  exit 0
fi

# Determine base branch (default: dev for this repo, fall back to main).
# Suppress rev-parse's SHA output on stdout so it doesn't get captured into BASE.
BASE=$(git rev-parse --verify origin/dev >/dev/null 2>&1 && echo dev || echo main)

# Gather context
git log "$BASE..HEAD" --oneline
git diff "$BASE...HEAD" --stat
gh pr view --json body -q .body 2>/dev/null  # may be empty if no PR yet
```

### Step 1: Identify the doc

Ask the user for three things in one prompt:

1. **Doc type:** `feature` (default for `feat/*` branches), `architecture`, or `design`
2. **Slug:** kebab-case, short (e.g., `cowork-mcp`, `auto-skill-suggest`)
3. **Owner:** GitHub handle (default = `git config user.name` or current `gh api user --jq .login`)

### Step 2: Decision brief — four sharp questions

Ask one question at a time. Each answer constrains the next. These force compression before drafting.

1. "In one sentence: what can someone now DO that they could not before?"
2. "What is the one design decision a future engineer needs to know?"
3. "Which 3-5 files are the heart of this change?" (suggest candidates from the diff)
4. "Any sharp edges or gotchas? (or 'none')"

Skip any question that is N/A for the doc type. Architecture notes don't need question 1; design specs don't need question 4.

### Step 3: Draft from the template

Read the matching template from `.internal-docs/_templates/`:

- `feature` → `feature-note.md`
- `architecture` → `architecture-note.md`
- `design` → `design-spec.md`

If `.internal-docs/_templates/` does not exist (first run, before seeding), fall back to the seeds bundled with this skill at `.claude/skills/document-internal/seeds/_templates/`.

Generate the 1-pager from the template, the four answers, and the diff context.

### Step 4: Voice self-check

Scan the draft for violations:

- Em dash present (`—`).
- Any banned word from the list.
- Average sentence length > 20 words.
- Body line count > 60 (feature notes only — architecture/design have no cap).

If any violation found, regenerate the offending sentences in place. Max 3 attempts. If still failing after 3 attempts, stop and report which rules are violated.

If the body is over 60 lines for a feature note, ask: "This is N lines, target is 60. Trim, or promote to `architecture/` (no length cap)?"

### Step 5: Show + iterate

Print the full draft. Ask:

> Edit needed? Paste any changes, or say "looks good".

Apply user edits with the Edit tool. Re-run Step 4. Loop until the user approves.

### Step 6: Open PR to internal-docs

Use a tmp clone. Never the user's `.internal-docs` checkout — keeps the user's submodule clean.

```bash
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT  # cleans up even if any step below fails
git clone -b main git@github.com:browseros-ai/internal-docs.git "$TMP"
cd "$TMP"
git checkout -b "docs/<slug>"

# Write the doc
mkdir -p "<type>"  # features, architecture, designs, or setup
cat > "<type>/$(date -u +%Y-%m)-<slug>.md" <<'DOC'
<draft content>
DOC

# Update the root README index — insert one line under the matching section
# Use Edit tool to add: "- [<title>](<type>/YYYY-MM-<slug>.md) — <one-line description>"

git add "<type>/$(date -u +%Y-%m)-<slug>.md" README.md
git commit -m "docs(<type>): <slug>"
git push -u origin "docs/<slug>"

PR_URL=$(gh pr create -R browseros-ai/internal-docs --base main \
  --head "docs/<slug>" \
  --title "docs(<type>): <slug>" \
  --body "$(cat <<'BODY'
## Summary
<one-line of what this doc covers>

## Source
- BrowserOS branch: <branch>
- Related PR: <#NNN if any>
BODY
)")

cd -
echo "PR opened: $PR_URL"
# trap above cleans up $TMP on EXIT
```

If the slug contains characters that won't shell-escape cleanly, sanitize before substitution.

### Step 7: Completion status

Report one of:

- **DONE** — file written, branch pushed, PR opened. Print PR URL.
- **DONE_WITH_CONCERNS** — same as DONE but list concerns (e.g., voice check needed multiple regens, user skipped a question).
- **BLOCKED** — submodule missing, auth fail, or template missing. State exactly what's needed.

## Doc type defaults

| Branch pattern | Default doc type | Default location |
|----------------|------------------|------------------|
| `feat/*`       | feature          | `features/`      |
| `arch/*` or refactor branches with >10 files in `packages/` | architecture | `architecture/` |
| `rfc/*` or `design/*` | design          | `designs/`       |
| Otherwise      | ask              | ask              |

## Common Mistakes

**Drafting before asking the four questions**
- **Problem:** Output is generic filler that says nothing concrete.
- **Fix:** Always ask Step 2 first, even if the diff "looks obvious".

**Touching `.internal-docs/` directly**
- **Problem:** User's submodule HEAD moves, parent repo shows dirty state.
- **Fix:** Always use the tmp clone in Step 6.

**Skipping voice check on user edits**
- **Problem:** User pastes prose with em dashes or filler; ships as-is.
- **Fix:** Re-run Step 4 after every user edit.

## Red Flags

**Never:**
- Push to `internal-docs/main`. Always branch + PR.
- Modify the OSS repo's `.gitmodules` or submodule pointer.
- Fabricate content for empty template sections.

**Always:**
- Pre-flight check before doing any work.
- One-pager rule for feature notes (60-line body cap).
- File:line citations when referencing code.
