# TriOS build entry point.
#
# `make` is the interface; the shell script is an implementation detail being
# retired. Two things matter here:
#
#   1. The default target builds DEV. Every skill, cron job and agent runs the
#      bare command, and while that rebuilt the release bundle it kept
#      overwriting the app the user was running. Shipping is now `make release`,
#      a deliberate act.
#   2. Targets are declarative, so an agent can ask for `make check` without
#      knowing which script implements it.
#
# Run `make help` for the list.

SHELL := /bin/bash
ROOT  := $(shell cd "$(dir $(lastword $(MAKEFILE_LIST)))" && pwd)

DEV_APP     := $(ROOT)/trios-dev.app
RELEASE_APP := $(ROOT)/trios.app

.DEFAULT_GOAL := dev
.PHONY: help dev release build check test cassettes e2e run run-release stop clean promote doctor chat-probe verify restart xctest delegate-probe drift-guard

help:
	@echo "TriOS targets:"
	@echo "  make            - build the DEV app (safe default; never touches the release)"
	@echo "  make dev        - same as above"
	@echo "  make release    - build the RELEASE app (deliberate; replaces trios.app)"
	@echo "  make check      - build dev and run every logic suite"
	@echo "  make test       - run the Swift logic suites only"
	@echo "  make e2e        - run the chat end-to-end flow"
	@echo "  make run        - launch the dev app"
	@echo "  make run-release- launch the release app"
	@echo "  make stop       - quit both apps"
	@echo "  make promote    - check the gates, then build release"
	@echo "  make doctor     - report the state of both variants"
	@echo "  make chat-probe - send a real message and report whether the agent answered"
	@echo "  make verify     - build, relaunch, and prove the chat answers (use after every change)"
	@echo "  make clean      - remove build products for both variants"
	@echo "  make mutants    - break known guards and require the SSE suite to notice"
	@echo "  make mutants-logic - the same, for guards a clade-e2e logic suite owns"
	@echo "  make drift-guard - run the interface-drift compiling proof (slow; not in the fast suite)"

# --- Building -----------------------------------------------------------

# The app build and the XCTest suite are judged separately on purpose.
# tests/TriOSKitTests currently has a large pre-existing breakage (missing types
# and Swift 6 actor-isolation errors) that makes build.sh exit non-zero even
# when the application compiles and links cleanly. Treating that as a build
# failure blocked every rebuild, so success here means "the app binary was
# produced" and the suite's state is reported rather than hidden.
#
# The build also emits compiler warnings, and until now threw them away. The
# recurring defects here have all been things nobody looked at, and this is a
# signal the toolchain produces correctly, for free, on every build - unlike the
# hand-written greps in this repository, three of which have quietly measured
# the wrong thing this week. A ceiling rather than zero because the debt is real
# and pretending otherwise would mean turning the check off the first time it
# fired. Counted unique so one warning in a header included many times is one
# warning.
#
# Only the app compile, which is why the log is cut at "Copied and signed"
# rather than filtered by path. Everything after that line is a test build, and
# test builds are incremental: they report only what they happened to recompile,
# so counting them made this swing between 17 and 30 on consecutive runs. A gate
# that fires at random is a gate someone switches off.
#
# Filtering by path was the obvious fix and the wrong one. Package.swift
# compiles several BR-OUTPUT files, HotkeyAnalytics among them, so a cache miss
# in swift test emitted warnings whose paths are application paths - which is
# the whole of the unexplained "7" an earlier version of this comment recorded
# as a mystery and used to justify a slack ceiling. Cutting at the end of the
# app build removes the guesswork.
#
# The count was 5 when the gate went in and is 4 now: the discarded runProcess
# result in branch creation became the failure reason the user sees. The four
# that remain are deprecated Text concatenation in RichTextRenderer, and
# replacing them means rebuilding inline markdown on AttributedString - visible
# to the user, and not something to change without looking at the screen.
#
# Uses /usr/bin/grep deliberately: this shell has grep shadowed by a function.
WARNING_CEILING := 4

dev:
	@TRIOS_VARIANT=dev "$(ROOT)/build.sh" > /tmp/trios_build_dev.log 2>&1; \
	if grep -q "Build successful: $(ROOT)/trios_dev_app" /tmp/trios_build_dev.log; then \
		echo "[OK] dev app built"; \
		grep -q "swift test failed" /tmp/trios_build_dev.log && \
			echo "[NOTE] XCTest suite still broken (pre-existing); run 'make xctest' for detail"; \
		warnings=$$(awk '/Copied and signed/{exit} {print}' /tmp/trios_build_dev.log 2>/dev/null \
			| /usr/bin/grep -oE "^/[^:]+\.swift:[0-9]+:[0-9]+: warning: " | sort -u | wc -l | tr -d ' '); \
		if [ "$$warnings" -gt $(WARNING_CEILING) ]; then \
			echo "[FAIL] $$warnings compiler warnings; the ceiling is $(WARNING_CEILING)."; \
			awk '/Copied and signed/{exit} {print}' /tmp/trios_build_dev.log \
				| /usr/bin/grep -oE "^/[^:]+\.swift:[0-9]+:[0-9]+: warning: .*" \
				| sort -u | sed 's|$(ROOT)/||' | head -25; \
			exit 1; \
		elif [ "$$warnings" -lt $(WARNING_CEILING) ]; then \
			echo "[NOTE] $$warnings warnings, under the ceiling of $(WARNING_CEILING)."; \
			echo "       Lower WARNING_CEILING in the Makefile so the gain cannot be given back."; \
		fi; \
		exit 0; \
	else \
		echo "[FAIL] dev app did not build:"; \
		grep -E "error:" /tmp/trios_build_dev.log | head -10; \
		exit 1; \
	fi

release:
	@echo "Building RELEASE. This replaces $(RELEASE_APP)."
	@TRIOS_VARIANT=prod "$(ROOT)/build.sh" > /tmp/trios_build_release.log 2>&1; \
	if grep -q "Build successful: $(ROOT)/trios_app" /tmp/trios_build_release.log; then \
		echo "[OK] release app built"; exit 0; \
	else \
		echo "[FAIL] release app did not build:"; \
		grep -E "error:" /tmp/trios_build_release.log | head -10; exit 1; \
	fi

build: dev

# --- Verifying ----------------------------------------------------------

test:
	@cargo run --quiet --bin clade-e2e

e2e:
	@bash "$(ROOT)/tests/swift/run_chat_sse_e2e.sh"

check: dev test cassettes

# Replay every cassette and assert the expected signal appears in the log.
#
# ~2s per cassette because no provider is involved, so the whole suite fits in
# an ordinary build. Regressions in the swarm now surface before the app is
# opened rather than after a ten-minute live run.
#
# What a cassette cannot test: anything the *server* does. The orphaned-tool-call
# repair lives in the agent server's prompt assembly, so a replay bypasses the
# exact layer holding the bug - a second replayed turn just yields the same
# recorded bytes and proves nothing either way. That one needs a live provider:
#
#   make delegate-probe SECOND_TURN=1 PATHS=docs TASK="..."
#
# then look for queen.selftest.second_turn_passed.
CASSETTE_DIR := $(ROOT)/tests/cassettes

# Only the branches this target creates. A replay delegates issue 1086 with the
# title "Cassette <file>", and QueenBranchPolicy names the branch
# queen/<issue>-<slugified title> - so every branch a cassette makes, and only
# those, match this glob.
#
# It used to be 'queen/*', which cannot tell a replay's throwaway branch from a
# live delegation's committed work. Running the suite after a real probe deleted
# the probe's branch: nothing was lost that time because the commit was still
# reachable and the content was disposable, but a destructive sweep that is
# right by luck is not right.
CASSETTE_BRANCHES := queen/1086-cassette-*

# Planted before the replays and checked after the sweep. Deliberately named so
# it looks exactly like a real delegation's branch and nothing like a cassette's.
SWEEP_CANARY := queen/0-sweep-canary

cassettes:
	@pkill -x trios-dev 2>/dev/null || true
	@pkill -f "trios-dev.app/Contents/MacOS" 2>/dev/null || true
	@sleep 2
	@: "A branch that looks like a delegation's real work, planted so the sweep \
	    below has something it must NOT delete. Widening CASSETTE_BRANCHES back \
	    to queen/* now fails the suite instead of quietly eating a branch."; \
	git -C "$(ROOT)" branch --force $(SWEEP_CANARY) HEAD >/dev/null 2>&1
	@fail=0; covered=""; \
	for spec in \
		"worker-happy-path.sse:queen.branch.committed:commits the file its cassette declares" \
		"worker-looping.sse:queen.observer.looping:notices a bee repeating one call" \
		"worker-out-of-bounds.sse:queen.observer.outOfBounds:notices a write outside the boundary" \
		"worker-orphan-tool-call.sse:queen.worker.orphaned_tool_calls:names a tool call the stream never answered" \
	; do \
		cassette=$${spec%%:*}; rest=$${spec#*:}; \
		covered="$$covered $$cassette"; \
		marker=$${rest%%:*}; label=$${rest#*:}; \
		case "$$marker" in second_turn*|*second_turn*) second=1 ;; *) second= ;; esac; \
		before=$$(wc -l < "$(LOG)" 2>/dev/null || echo 0); \
		rm -f "$(ROOT)/.trinity-dev/state/queen_delegation.json"; \
		: "A cassette effect writes a file; if it survives from the last run the \
		   baseline diff is empty and the commit assertion fails for the wrong \
		   reason. Clean before, not only after."; \
		rm -f "$(ROOT)/docs/replay.md"; \
		git -C "$(ROOT)" branch --list '$(CASSETTE_BRANCHES)' --format='%(refname:short)' \
			| xargs -r -n1 git -C "$(ROOT)" branch -D >/dev/null 2>&1 || true; \
		open --env TRIOS_E2E_DELEGATE="gHashTag/trios\#1086|queen-swift|Cassette $$cassette|docs" \
		     --env TRIOS_REPLAY_CASSETTE="$(CASSETTE_DIR)/$$cassette" \
		     --env TRIOS_E2E_SECOND_TURN="$$second" "$(DEV_APP)"; \
		: "The wait is not a fixed 40-second cliff. The budget is 120 s \
		   (3x the original) so a busy machine is not penalised, but the \
		   loop breaks the moment trios-dev exits — a crashed app should \
		   not burn the full budget. Two failure modes that used to look \
		   identical are now told apart: 'never started' (no trios-dev \
		   process was ever seen) vs 'ran but produced no marker'."; \
		found=0; started=0; \
		for i in $$(seq 1 60); do \
			tail -n "+$$((before + 1))" "$(LOG)" 2>/dev/null | grep -q "$$marker" && { found=1; break; }; \
			if pgrep -f "trios-dev.app/Contents/MacOS" >/dev/null 2>&1; then started=1; \
			elif [ $$started -eq 1 ]; then break; fi; \
			sleep 2; \
		done; \
		if [ $$found -eq 1 ]; then echo "  ok   - $$label"; \
		elif [ $$started -eq 0 ]; then \
			echo "  FAIL - $$label (trios-dev never started; no process was seen)"; fail=1; \
		else \
			echo "  FAIL - $$label (trios-dev ran but $$marker never appeared in the log)"; fail=1; \
		fi; \
		pkill -x trios-dev 2>/dev/null || true; \
		pkill -f "trios-dev.app/Contents/MacOS" 2>/dev/null || true; \
		sleep 2; \
	done; \
	git -C "$(ROOT)" branch --list '$(CASSETTE_BRANCHES)' --format='%(refname:short)' | xargs -r -n1 git -C "$(ROOT)" branch -D >/dev/null 2>&1; \
	if git -C "$(ROOT)" rev-parse --verify --quiet $(SWEEP_CANARY) >/dev/null; then \
		echo "  ok   - the branch sweep spares work it did not create"; \
		git -C "$(ROOT)" branch -D $(SWEEP_CANARY) >/dev/null 2>&1; \
	else \
		echo "  FAIL - the branch sweep deleted $(SWEEP_CANARY), which it did not create"; fail=1; \
	fi; \
	if git -C "$(ROOT)" branch --list '$(CASSETTE_BRANCHES)' --format='%(refname:short)' | grep -q .; then \
		echo "  FAIL - cassette branches survived the sweep; the glob matches nothing"; fail=1; \
	fi; \
	rm -f "$(ROOT)/docs/replay.md"; \
	: "A cassette nothing runs is not coverage. Deleting a spec above leaves \
	   its .sse file on disk and the suite still says passed, which is the \
	   same silence an unwired test file used to sit in."; \
	present=0; \
	for f in "$(CASSETTE_DIR)"/*.sse; do \
		[ -e "$$f" ] || continue; \
		present=$$((present + 1)); base=$$(basename "$$f"); \
		case " $$covered " in \
			*" $$base "*) ;; \
			*) echo "  FAIL - $$base has no spec in this target, so nothing replays it"; fail=1 ;; \
		esac; \
	done; \
	if [ $$present -eq 0 ]; then echo "  FAIL - no cassettes found in $(CASSETTE_DIR)"; fail=1; fi; \
	if [ $$fail -eq 0 ]; then echo "[OK] cassette suite passed ($$present cassettes)"; else echo "[FAIL] cassette suite"; exit 1; fi

# --- Running ------------------------------------------------------------

run: dev
	@open "$(DEV_APP)"

run-release:
	@open "$(RELEASE_APP)"

stop:
	@pkill -x trios 2>/dev/null || true
	@pkill -x trios-dev 2>/dev/null || true
	@echo "stopped"

# --- Release gate -------------------------------------------------------

# Promotion is the one moment the working app is deliberately replaced, so it
# is the one moment worth gating.
promote: check
	@echo "Gates passed. Promoting dev to release."
	@$(MAKE) release

# --- Diagnostics --------------------------------------------------------

doctor:
	@echo "release app : $$([ -d '$(RELEASE_APP)' ] && stat -f '%Sm' '$(RELEASE_APP)' || echo 'absent')"
	@echo "dev app     : $$([ -d '$(DEV_APP)' ] && stat -f '%Sm' '$(DEV_APP)' || echo 'absent')"
	@echo "running     : $$(pgrep -x trios >/dev/null && echo 'release' || echo '-') $$(pgrep -x trios-dev >/dev/null && echo 'dev' || echo '')"
	@echo "server 9105 : $$(curl -s -m 3 http://127.0.0.1:9105/health || echo 'down')"
	@echo "server 9205 : $$(curl -s -m 3 http://127.0.0.1:9205/health || echo 'down')"

clean:
	@rm -rf "$(ROOT)/trios_dev_app" "$(ROOT)/Frameworks-dev" "$(DEV_APP)"
	@echo "dev build products removed (release left intact; use 'make clean-release' deliberately)"

.PHONY: clean-release
clean-release:
	@rm -rf "$(ROOT)/trios_app" "$(ROOT)/Frameworks" "$(RELEASE_APP)"
	@echo "release build products removed"

# --- Self-verification ---------------------------------------------------

# Sends a real chat turn through the running server using the variant's own
# provider, model and key, then reports whether an answer came back. This exists
# so a change can be verified without asking a human to click Send.
VARIANT ?= dev
MSG ?= Reply with exactly: TRIOS OK

chat-probe:
	@swiftc -O -o /tmp/trios_chat_probe "$(ROOT)/tools/ChatProbe.swift" 2>/dev/null
	@/tmp/trios_chat_probe --variant "$(VARIANT)" --message "$(MSG)"

# Rebuild, relaunch, prove. A change that is not rebuilt and relaunched is not
# applied - the running app keeps the old binary - and a rebuild that is not
# probed is not verified. This target is the whole loop, so neither step gets
# skipped.
restart:
	@pkill -x trios-dev 2>/dev/null || true
	@pkill -f "trios-dev.app/Contents/MacOS" 2>/dev/null || true
	@sleep 2
	@open "$(DEV_APP)"
	@echo "relaunched $(DEV_APP); waiting for the server"
	@for i in $$(seq 1 15); do \
		curl -s -m 3 http://127.0.0.1:9205/health >/dev/null 2>&1 && break; \
		sleep 3; \
	done

verify: dev restart chat-probe

# Proves the Queen actually starts a bee: relaunches dev with a delegation
# request, waits for the worker turn, and prints the verdict from the app's own
# log. Existed because delegation only ran from the chat window, so "the worker
# never started" could not be reproduced without a human clicking Send.
# The hash must be escaped or make treats the issue number as a comment.
ISSUE ?= gHashTag/trios\#1086
WORKER ?= queen-swift
TASK ?= Fix LOGS noise profile
# Without a boundary the brief tells the worker to ask before editing, so a
# write task legitimately produces no writes.
SECOND ?=
CRITERIA ?=
PATHS ?=
# Set to accept or reject to exercise the review loop in the same probe.
REVIEW ?=
# Set to 1 to let the Queen close unambiguous work herself.
AUTONOMY ?=
# Point at tests/cassettes/*.sse to run the swarm against a recording instead
# of a live provider. Same bytes, same order, every run.
CASSETTE ?=
# Set to 1 to send a second turn on the same conversation. The orphan
# regression only appears on the send *after* the one that caused it.
SECOND_TURN ?=

LOG := $(ROOT)/.trinity-dev/logs/trios-app.jsonl

delegate-probe:
	@pkill -x trios-dev 2>/dev/null || true
	@pkill -f "trios-dev.app/Contents/MacOS" 2>/dev/null || true
	@sleep 2
	@rm -f "$(ROOT)/.trinity-dev/state/queen_delegation.json"
	@# Remember where the log ends. Without this the wait loop matches the
	@# PREVIOUS run's verdict and reports a stale result as if it were fresh.
	@before=$$(wc -l < "$(LOG)" 2>/dev/null || echo 0); echo $$before > /tmp/trios_delegate_mark
	@# `open` launches through LaunchServices, which does not inherit the shell
	@# environment; --env is the only way the flag reaches the app.
	@open --env TRIOS_E2E_DELEGATE="$(ISSUE)|$(WORKER)|$(TASK)|$(PATHS)|$(CRITERIA)" \
		--env TRIOS_E2E_DELEGATE_SECOND="$(SECOND)" \
		--env TRIOS_E2E_DELEGATE_REVIEW="$(REVIEW)" \
		--env TRIOS_QUEEN_AUTONOMY="$(AUTONOMY)" \
		--env TRIOS_REPLAY_CASSETTE="$(CASSETTE)" \
		--env TRIOS_E2E_SECOND_TURN="$(SECOND_TURN)" "$(DEV_APP)"
	@echo "delegating $(ISSUE) to $(WORKER); waiting up to 16 min"
	@before=$$(cat /tmp/trios_delegate_mark); \
	for i in $$(seq 1 192); do \
		tail -n "+$$((before + 1))" "$(LOG)" 2>/dev/null \
			| grep -q "queen.selftest.passed\|queen.selftest.failed" && break; \
		sleep 5; \
	done; \
	tail -n "+$$((before + 1))" "$(LOG)" 2>/dev/null \
		| grep "queen.selftest\|queen.worker\|queen.delegate\|queen.branch" \
		|| echo "no self-test lines were written"

# The XCTest target, reported honestly rather than folded into the app build.
# Counts distinct errors, not lines mentioning one.
#
# swiftc prints each error with several lines of source context, and every one
# of those contains the word "error:". Counting lines reported 1651 where there
# were 76 - a debt that looks hopeless instead of a fortnight's work, which is a
# decent explanation for why nobody has picked it up. A metric nobody measured
# is worse than no metric: this one was actively arguing against being fixed.
xctest:
	@errors=$$(swift build --build-tests 2>&1 \
		| grep -E "^/.*error:" \
		| sed "s/:[0-9]*:[0-9]*: error: /: /" \
		| sort -u | wc -l | tr -d " "); \
	files=$$(swift build --build-tests 2>&1 \
		| grep -E "^/.*error:" | grep -oE "^/[^:]*\.swift" \
		| sort -u | wc -l | tr -d " "); \
	echo "XCTest: $$errors distinct compile errors across $$files files (pre-existing debt)"

# --- Mutation ------------------------------------------------------------

# Breaks a guard on purpose and requires the suite to notice.
#
# Five nights of doing this by hand found five checks that could not fail: a
# loop asserting headings and not sections, a fixture where the alphabet stood
# in for severity, another where age stood in for salience, a detector whose
# vocabulary was never exercised, and a refusal nothing ever asked for. Green
# said "there is a test", which was true, and said nothing about whether the
# test could tell.
#
# Kept out of `make` and out of `check`: it edits sources, and it is slow. The
# point is that it is now a command anyone can run rather than a habit only I
# had.
#
# Each entry is source@@needle@@replacement@@name. The needle must exist or the
# mutation is reported as stale rather than silently skipped - a mutation that
# matches nothing is the same lie as a check that matches nothing.
#
# Sources are backed up before the first edit and restored on any exit, kill or
# interrupt. This target writes to tracked files, so that trap is the whole
# safety argument for it.
#
# Two proven mutations are deliberately absent: the age cap and the tie-break in
# QueenSalience are caught by a logic suite inside clade-e2e, whose exit code
# also goes non-zero when the app or the server is down. Treating that as "the
# mutation was caught" would be a false pass, and a mutation harness that lies
# is worse than none.
MUTANTS := \
	rings/SR-00/QueenObserver.swift@@lowered.contains("write") || lowered.contains("edit")@@lowered.contains("write")@@the boundary detector forgets edit-shaped tools \
	rings/SR-02/QueenDelegationRegistry.swift@@tasks[index].acceptanceCriteria.contains(criterion) else { return false }@@true else { return false }@@a verdict is accepted for a criterion the task never had \
	rings/SR-00/QueenTaskSpec.swift@@lines.append(QueenBranchPolicy.ownershipRule(branch: branch))@@lines.append("")@@the specification stops telling the worker to leave the branch alone \
	rings/SR-00/QueenObserver.swift@@observedWrites.forEach(consider)@@_ = observedWrites@@the observer ignores what git measured and trusts tool names again \
	rings/SR-02/QueenBranchCommitter.swift@@guard !prefix.isEmpty, normalized.hasPrefix("\(prefix)/") else { return normalized }@@guard !prefix.isEmpty else { return normalized }@@a measured path is stripped whether or not it carries the prefix \
	rings/SR-01/SkillStore.swift@@!disabledIDs.contains(skill.id)@@true@@a switched-off skill reports itself as on \
	rings/SR-00/QueenSystemPrompt.swift@@tools: \(forbidden).@@tools of that kind.@@the Queen is no longer told which tools she may not call, only that some exist

.PHONY: mutants mutants-logic
mutants:
	@backup=$$(mktemp -d); \
	trap 'for f in $$backup/*.bak; do [ -e "$$f" ] || continue; \
	      target=$$(cat "$$f.path"); cp "$$f" "$(ROOT)/$$target"; done; \
	      rm -rf $$backup' EXIT INT TERM; \
	fail=0; n=0; \
	: "Records are separated by ~ and fields by @@. A vertical bar cannot be \
	   the record separator: the first needle contains || and split itself in \
	   half, which the stale check caught rather than letting it pass."; \
	IFS='~'; for entry in $$(echo '$(MUTANTS)' | sed 's/ rings\//~rings\//g'); do \
		unset IFS; \
		src=$$(echo "$$entry" | awk -F'@@' '{print $$1}'); \
		needle=$$(echo "$$entry" | awk -F'@@' '{print $$2}'); \
		repl=$$(echo "$$entry" | awk -F'@@' '{print $$3}'); \
		name=$$(echo "$$entry" | awk -F'@@' '{print $$4}'); \
		n=$$((n + 1)); \
		cp "$(ROOT)/$$src" "$$backup/$$n.bak"; echo "$$src" > "$$backup/$$n.bak.path"; \
		if ! MUT_SRC="$(ROOT)/$$src" MUT_OLD="$$needle" MUT_NEW="$$repl" python3 -c \
			'import os,sys; p=os.environ["MUT_SRC"]; s=open(p).read(); o=os.environ["MUT_OLD"]; sys.exit(1) if o not in s else open(p,"w").write(s.replace(o,os.environ["MUT_NEW"],1))'; then \
			echo "  STALE - $$name (its needle is no longer in $$src)"; fail=1; \
			cp "$$backup/$$n.bak" "$(ROOT)/$$src"; continue; \
		fi; \
		if bash "$(ROOT)/tests/swift/run_chat_sse_e2e.sh" >/dev/null 2>&1; then \
			echo "  SURVIVED - $$name"; fail=1; \
		else \
			echo "  ok   - caught: $$name"; \
		fi; \
		cp "$$backup/$$n.bak" "$(ROOT)/$$src"; \
	done; \
	if [ $$fail -eq 0 ]; then echo "[OK] every mutation was caught ($$n)"; \
	else echo "[FAIL] a mutation survived or went stale"; exit 1; fi

# Mutations a logic suite catches rather than the SSE harness.
#
# These were left out when `make mutants` first shipped, because clade-e2e's
# exit code is also non-zero when the app or the server is down - reading it as
# "the mutation was caught" would be a false pass, and the two proven mutations
# stayed uncovered rather than covered dishonestly.
#
# The fix is to stop reading the exit code and read the verdict for the one
# suite that should have failed. clade-e2e writes a report per run whose path is
# its last line, and a failed suite appears there as
# "- [FAIL] Swift logic tests (<label>)". A suite that fails for its own reason
# is a caught mutation; everything else in that report is somebody else's news.
#
# Fields: source@@needle@@replacement@@suite label@@name.
MUTANTS_LOGIC := \
	rings/SR-00/QueenSalience.swift@@min(hours, ageCeiling) * agePerHourWeight@@hours * agePerHourWeight@@QueenDelegation@@age has no ceiling, so an old quiet task outshouts a fresh failure \
	rings/SR-00/QueenSalience.swift@@return lhs.updatedAt < rhs.updatedAt@@return false@@QueenDelegation@@equally salient tasks stop breaking their tie on age

.PHONY: mutants-logic
mutants-logic:
	@backup=$$(mktemp -d); \
	trap 'for f in $$backup/*.bak; do [ -e "$$f" ] || continue; \
	      target=$$(cat "$$f.path"); cp "$$f" "$(ROOT)/$$target"; done; \
	      rm -rf $$backup' EXIT INT TERM; \
	fail=0; n=0; \
	IFS='~'; for entry in $$(echo '$(MUTANTS_LOGIC)' | sed 's/ rings\//~rings\//g'); do \
		unset IFS; \
		src=$$(echo "$$entry" | awk -F'@@' '{print $$1}'); \
		needle=$$(echo "$$entry" | awk -F'@@' '{print $$2}'); \
		repl=$$(echo "$$entry" | awk -F'@@' '{print $$3}'); \
		suite=$$(echo "$$entry" | awk -F'@@' '{print $$4}'); \
		name=$$(echo "$$entry" | awk -F'@@' '{print $$5}'); \
		n=$$((n + 1)); \
		cp "$(ROOT)/$$src" "$$backup/$$n.bak"; echo "$$src" > "$$backup/$$n.bak.path"; \
		if ! MUT_SRC="$(ROOT)/$$src" MUT_OLD="$$needle" MUT_NEW="$$repl" python3 -c \
			'import os,sys; p=os.environ["MUT_SRC"]; s=open(p).read(); o=os.environ["MUT_OLD"]; sys.exit(1) if o not in s else open(p,"w").write(s.replace(o,os.environ["MUT_NEW"],1))'; then \
			echo "  STALE - $$name (its needle is no longer in $$src)"; fail=1; \
			cp "$$backup/$$n.bak" "$(ROOT)/$$src"; continue; \
		fi; \
		report=$$(cd "$(ROOT)" && cargo run --quiet --bin clade-e2e 2>/dev/null | tail -1); \
		if [ -f "$$report" ] && grep -q "\[FAIL\] Swift logic tests ($$suite)" "$$report"; then \
			echo "  ok   - caught by $$suite: $$name"; \
		elif [ ! -f "$$report" ]; then \
			echo "  ERROR - clade-e2e wrote no report, so nothing was measured"; fail=1; \
		else \
			echo "  SURVIVED - $$name"; fail=1; \
		fi; \
		cp "$$backup/$$n.bak" "$(ROOT)/$$src"; \
	done; \
	if [ $$fail -eq 0 ]; then echo "[OK] every logic-suite mutation was caught ($$n)"; \
	else echo "[FAIL] a logic-suite mutation survived, went stale, or was not measured"; exit 1; fi

# --- Interface-drift compiling proof ------------------------------------
#
# The interface-drift proof builds divergent Swift packages and proves the
# combined-build guard catches a signature mismatch.  It invokes the Swift
# compiler, so it is deliberately separate from the fast SSE suite: the same
# reason make mutants is separate — slow, explicit, never accidental (#1125).
#
# The fast suite asserts, via TRIOS_RUN_DRIFT_GUARD, that this scenario is not
# running inside it; putting the call back unconditionally fails the fast run
# rather than silently slowing it down.
drift-guard:
	@TRIOS_RUN_DRIFT_GUARD=1 bash "$(ROOT)/tests/swift/run_chat_sse_e2e.sh"
