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

# The harness bundle. Dev was doing two incompatible jobs: scratch space an
# agent restarts and wipes at will, and the workspace where the Queen keeps
# live delegated tasks. `make cassettes` treated it as the first - pkill, then
# `rm -f .trinity-dev/state/queen_delegation.json` before each of four replays -
# and on 2026-08-17 that deleted a real registry of four tasks mid-cycle. The
# harness now runs as its own variant: bundle com.browseros.trios.test, data
# root .trinity-test, port 9305. It can be killed and wiped freely because
# nothing else lives there.
T27_ROOT    ?= $(HOME)/t27
TEST_APP    := $(ROOT)/trios-test.app
TEST_PROC   := trios-test\.app/Contents/MacOS/trios
# The pattern the cassette recipe kills by. It carries THIS checkout's path
# on purpose: the bare `trios-test.app/Contents/MacOS` matched a bee's harness
# too, because a worktree is a full checkout that builds its own test bundle
# at .worktrees/<variant>/queen-<n>/trios/trios-test.app. Measured on
# 2026-08-22, when a gate run killed the dev bee's harness in another lane.
# A harness that can reach outside its own tree is not isolated, whatever
# variant it claims.
TEST_PROC_HERE := $(TEST_APP)/Contents/MacOS
DEV_PROC_HERE  := $(DEV_APP)/Contents/MacOS
TEST_BIN    := $(TEST_APP)/Contents/MacOS/trios
TEST_LOG    := $(ROOT)/.trinity-test/logs/trios-app.jsonl

# Both bundles ship an executable literally named `trios`
# (trios-dev.app/Contents/MacOS/trios), so a *name* is not an identity here:
# 'pgrep -x trios-dev' can never match anything, and 'pgrep -x trios' matches
# either variant. Only the path tells them apart, which is how `restart` and
# `delegate-probe` already do it. The dot is escaped because these are regular
# expressions, and the release pattern keeps its leading slash so it cannot
# match .../trios-dev.app/... .
DEV_PROC     := trios-dev\.app/Contents/MacOS/trios
RELEASE_PROC := /trios\.app/Contents/MacOS/trios

# The bundle DIRECTORY's mtime is set when the bundle is created, not when the
# binary inside it is replaced, so it reads as weeks stale after a rebuild.
# Report the mtime of the thing that actually gets rebuilt.
DEV_BIN     := $(DEV_APP)/Contents/MacOS/trios
RELEASE_BIN := $(RELEASE_APP)/Contents/MacOS/trios

# The harness lock records its owner's PID.  An interrupted run leaves a
# lock behind; the next run reads the PID, checks whether the owner is
# still alive, and reclaims a dead owner's lock with a word about it.
HARNESS_LOCK := /tmp/trios_harness.lock
# How long `cassettes` waits for a lock another run holds before giving up.
# Long enough for a full cassette suite (four replays, each with a 600s
# backstop) to finish ahead of it, short enough that a wedged owner is not
# waited on all afternoon.
HARNESS_LOCK_WAIT := 1800
# A hard total budget for the cassettes recipe itself, watchdog-enforced.
# The per-cassette poll loop is bounded (600s each, idle 120s), so on paper
# the whole target is bounded too - but 2026-08-24 measured a cassettes
# recipe alive for TEN HOURS with a nested `make check` as its child,
# outside every bound the poll loop owns. A wedged recipe does not just sit
# there: every other agent then queues on the harness lock it holds, and
# the whole machine's gates stack behind one hang. The watchdog kills the
# recipe shell when the budget is spent; the failure is loud (Terminated)
# instead of silent, and the lock's pid file points at the make parent,
# which dies with the target, so the next waiter reclaims it honestly.
CASSETTE_TOTAL_BUDGET := 1800
# Recursion guard. 2026-08-24 measured a self-spawning cassettes<->check
# recursion: a subshell inside the cassettes lock-line grew a bare `make
# check`, which requires cassettes again, whose lock-line grows another
# `make check` - three generations observed live, new generations still
# spawning after one link was killed. Legitimate recursion here goes two,
# at most three levels (dev -> warning-gate, release, mutants); anything
# at four or deeper is the bomb, not a build, and dies by name instead of
# eating the machine. If a legitimate path ever needs four levels, this
# error will name it loudly - raise the number, do not remove the guard.
ifeq ($(shell test $(MAKELEVEL) -lt 4; echo $$?),0)
else
$(error recursive make detected at MAKELEVEL=$(MAKELEVEL), target '$(MAKECMDGOALS)' - the 2026-08-24 cassettes/check self-spawn class; refusing)
endif

.DEFAULT_GOAL := dev
.PHONY: help dev release build keychain-doors make-dollars empty-sources watch-empties check test cassettes e2e shake run run-release stop clean promote doctor chat-probe verify restart xctest delegate-probe drift-guard finish-mark-order guard-shapes parse-tests vendor-step warnings warning-gate

help:
	@echo "TriOS targets:"
	@echo "  make            - build the DEV app (safe default; never touches the release)"
	@echo "  make dev        - same as above"
	@echo "  make release    - build the RELEASE app (deliberate; replaces trios.app)"
	@echo "  make check      - build dev and run every logic suite, including mutants-changed"
	@echo "  make test       - run the Swift logic suites only"
	@echo "  make e2e        - run the chat end-to-end flow"
	@echo "  make shake      - run the e2e flow under CPU/IO load until a 10% per-run flake rate is"
	@echo "                    ruled out at 95% confidence: 29 loaded runs, ~20 min. Tells flaky from"
	@echo "                    broken. Deliberate, not part of 'make check'."
	@echo "                    make shake SHAKE_BOUND=20 for a looser bound in ~10 min; =5 for ~40 min"
	@echo "  make run        - launch the dev app"
	@echo "  make run-release- launch the release app"
	@echo "  make stop       - quit both apps"
	@echo "  make promote    - check the gates, then build release"
	@echo "  make doctor     - REPORT: the state of both variants (never fails)"
	@echo "  make dashboard  - regenerate .trinity/dashboard/index.html from measured state"
	@echo "  make forensics  - REPORT: binary drift + event histogram + board (VARIANT=release|dev|test)"
	@echo "  make signals    - REPORT: named signal counts since the last server.launch"
	@echo "  make board      - REPORT: delegation registry bucketed by state"
	@echo "  make binary-drift - REPORT: one-line binary-vs-commit verdict per variant"
	@echo "  make spend      - REPORT: per-day tasks, tool calls, tokens and estimable dollars"
	@echo "  make xctest     - count the XCTest compile errors against XCTEST_ERROR_CEILING"
	@echo "  make sources-drift - fail if build.sh and the root Package.swift disagree"
	@echo "                    on which Swift files make up the app (part of make check)"
	@echo "  make backlog-audit - REPORT: open sub-issues of #1090 that look already done"
	@echo "  make chat-probe - send a real message and report whether the agent answered"
	@echo "  make verify     - build, relaunch, and prove the chat answers (use after every change)"
	@echo "  make clean      - remove build products for both variants"
	@echo "  make mutants    - break known guards and require the SSE suite to notice"
	@echo "  make mutants-logic - the same, for guards a clade-e2e logic suite owns"
	@echo "  make mutants-guard - the same, for guards whose oracle is the check itself"
	@echo "                    (needs one 'make dev' first: it typechecks each mutant"
	@echo "                     inside the app module the build leaves behind)"
	@echo "  make mutants-changed - run mutations for guarded files dirty in the working tree"
	@echo "  make drift-guard - run the interface-drift compiling proof (slow; not in the fast suite)"
	@echo "  make finish-mark-order - check the completed-turn mark stays in the finish callback"
	@echo "  make guard-shapes - check the load-bearing guards are still in their files"
	@echo "  make vendor-step - check build.sh still vendors both halves of QueenUILib (runs before every dev build)"
	@echo "  make warnings   - full compiler-warning count for the whole tree (own build dir; first run is cold)"

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
#
# --- The number has to describe the TREE, not the last delta (#1264) ---------
#
# Everything above was written when every build recompiled every file, so "what
# this build printed" and "what the tree contains" were the same number. They
# stopped being the same the day the dev build became incremental, and the gate
# did not notice. Driven, on one unchanged revision:
#
#   make dev, nothing touched                        -> 0 warnings
#   touch BR-OUTPUT/RichTextRenderer.swift; make dev -> 4 warnings
#
# The compiler only warns about what it compiled. The false zero was worse than
# useless, because the recipe went on to advise lowering WARNING_CEILING - which
# would have made the next cold build fail on debt nobody added.
#
# Three designs were on the table:
#   (a) a 'make warnings' target that compiles clean into a scratch tree and
#       counts there, with check using that instead of the side effect of dev;
#   (b) a per-file cache of each file's last known warnings, refreshed only for
#       the files a build actually compiled, reported as a tree total;
#   (c) print no number at all when the build was incremental.
#
# (b), with (c) as its fallback and (a) as its repair. (a) alone puts a cold
# build inside every check - measured at the bottom of this comment, and nobody
# pays that per run. (c) alone is honest but surrenders: since almost every
# build here is now incremental, the ceiling would essentially never be
# enforced again, and a gate that never fires is the gate being removed with
# extra steps. (b) costs milliseconds, and its one weak spot - a cache that has
# not yet seen every file - is exactly where (c)'s refusal is correct and where
# (a)'s full recompile is the cure.
#
# How the cache knows which files this build compiled: the Makefile sets
# TRIOS_BUILD_SHOW_INCREMENTAL, so the driver prints one
# "Incremental compilation: Skipping input: {compile: X.o <= X.swift}" per file
# it reused. Compiled = every file in the build's own output-file-map minus
# those. That is better than comparing object mtimes, which a concurrent build
# would have disturbed and which would have silently *lowered* the count.
#
# It used to be wide open to a concurrent build. Three adversaries refuted the
# claim of immunity by driving it: `dev` wrote the driver's output to the fixed
# global path /tmp/trios_build_dev.log via a shell redirect that truncates
# before build.sh is even exec'd, so build.sh's per-variant lock - taken later,
# inside a different process - could not protect a file the next run's shell
# had already opened. Two `make dev` runs overlapping that way read each
# other's log, and nothing correlated a log with the build that wrote it -
# no nonce, no build id. Every build now writes its own log and the gate is
# handed that log plus a build id it verifies; see WARN_LOG_DIR below for the
# measurement that closed it.
#
# What is still shared between two concurrent gates is the per-file cache
# itself: both read warnings.list / warnings.seen and both rewrite them, so the
# loser's contribution to the tree total can be lost. That is a stale total, no
# longer a total computed from somebody else's build, and `make warnings` is
# still the repair when in doubt.
#
# The other refuted overstatement: a warning in a file that has NOT been
# recompiled since the cache was created is invisible to this number. The
# partial-count branch below says so out loud whenever measured < total, but on
# a 185/185 count the figure is only as good as the compiles that filled it.
#
# The cache lives inside the object directory it describes, so deleting the
# build directory throws it away with the objects, and the cold build that
# follows refills it completely. If a build reports no incremental remarks at
# all (a toolchain that drops the flag), attribution is impossible: the seen
# list is emptied and the count reported as partial rather than guessed.
#
# A partial count is a lower bound, so it can still FAIL the ceiling - what it
# must never do is claim the tree is clean, and it must never print the
# lower-the-ceiling advice. That advice is now reachable only from a count that
# has seen every file.
#
# Cost of the full count: it used to force TRIOS_BUILD_CLEAN=1 on the dev
# directory, i.e. one cold build of all 185 files, measured here twice at 108s
# and 96s against 48-56s for the incremental build it replaced. A check that
# slow is a check nobody runs, which is how this gate rotted the first time. See
# WARN_FULL_ROOT below for what replaced it; the target still prints its own
# [warnings] timing line, so the figure stays honest either way.
# WHY FOUR, ASKED HONESTLY. This number is a READING, not a requirement. It is
# exactly the count of `'+' was deprecated in macOS 26.0` warnings in
# BR-OUTPUT/RichTextRenderer.swift lines 73/75/77/79, and it was set to that
# count. The requirement is zero. The same shape sat in XCTEST_ERROR_CEILING for
# months at 2, where 2 was the number of errors a broken source list happened to
# produce; asking "why is it green at this number" is what found it.
#
# It is not lowered to zero today because the fix is not a one-liner: the four
# calls concatenate Text values that carry DIFFERENT styling (bold, italic,
# monospaced), so the modern replacement is an AttributedString rewrite of
# styledText, not a substitution. That changes rendering, and rendering is not
# verifiable from a build log. Tracked rather than pretended away.
# Zero, and derived from the requirement rather than from a reading. It was 4
# for as long as BR-OUTPUT/RichTextRenderer.swift concatenated Text values with
# the deprecated +; that rewrite landed on AttributedString and the count is
# genuinely 0 (verified by touching the file and recompiling, not from cache).
WARNING_CEILING := 0

# Where the per-file warning cache lives. Inside the dev object directory on
# purpose: its lifetime is the objects' lifetime.
#
# WARN_VARIANT names the build these gates borrow from, in ONE place. It picks
# the object directory here and is also what `mutants-guard` passes to
# build.sh's flag print, so the source list and the include set can never come
# from different variants.
WARN_VARIANT := dev
WARN_BUILD_DIR := $(ROOT)/.trinity/build/$(WARN_VARIANT)
WARN_OFM := $(WARN_BUILD_DIR)/output-file-map.json
WARN_LIST := $(WARN_BUILD_DIR)/warnings.list
WARN_SEEN := $(WARN_BUILD_DIR)/warnings.seen

# One log per build, not one log per machine.
#
# The old arrangement pointed every `make dev` at /tmp/trios_build_dev.log. The
# shell truncates a `>` target when it opens it - in the *next* run's shell,
# before that run's build.sh is exec'd - so build.sh's per-variant build lock
# cannot protect the log no matter when it is taken: below, run B emptied run
# A's log while run A held the lock and was compiling. Both gates then read
# whatever the one file happened to hold. Driven here on 2026-08-12, two
# `make dev` runs started 5s apart:
#
#   /tmp/trios_build_dev.log  13940846 -> 46 bytes at 01:03:18  (run A opens it)
#                                46754 -> 46 bytes at 01:03:23  (run B opens it)
#
# Run A was 6s into a 85s build when its log was emptied under it. The
# incremental remarks this gate counts sit in bytes 24172-46350 of a dev log,
# so run A's entire remark block was inside the 46754 bytes run B destroyed:
# the 185 remarks run A's gate went on to count were written by run B. Both
# runs printed the same verdict, and neither log said whose build it was -
# a corrupted log is byte-indistinguishable from a clean one here.
#
# Now: mktemp gives each invocation its own path (unique even for two builds
# started in the same second by the same pid), the first line of that file is a
# build id, and `dev` hands the gate both. The gate refuses a log that does not
# carry the id it was told to expect, and refuses one carrying more than one id
# - which is exactly what a clobbered log looks like.
#
# $(WARN_LOG_LAST) is kept as a convenience copy of the last finished build for
# anyone who greps it by hand; it is written by an atomic rename so it is always
# one whole build, and nothing on the `dev` path reads it. Per-build logs are
# ~14 MB, so ones older than an hour are swept at the start of the next build -
# an hour is ~40x the length of a build, so a live log is never in range. The
# sweep says $(WARN_LOG_DIR)/ with the slash on purpose: /tmp is a symlink to
# /private/tmp, and find does not follow a symlink named on the command line,
# so the slashless form silently matched nothing and swept nothing.
WARN_LOG_DIR  := /tmp
WARN_LOG_LAST := $(WARN_LOG_DIR)/trios_build_dev.log
# Both are set by `dev` on the command line when it calls the gate. Empty here
# on purpose: a hand-run gate has no build of its own and must say so.
WARN_LOG :=
WARN_BUILD_ID :=

dev: vendor-step
	@# The per-file warning cache does not survive a build (#1264, second round).
	@# An entry outlives the truth it recorded. Driven, both directions: warnings
	@# planted and then removed left the cache reporting 8 on a tree holding 4,
	@# three builds running and never healing, with the ceiling enforced against
	@# a fiction; and when a build fails after some files compiled, their
	@# incremental state advances, they are Skipped ever after, their warnings
	@# were never folded in, and the gate still claims "185/185 measured" over an
	@# under-count. Neither drift is detectable from inside the cache.
	@# So `dev` reports only what this build actually compiled, labelled partial,
	@# and never enforces the ceiling. `make warnings` compiles everything and is
	@# where the ceiling is enforced; `check` runs it.
	@rm -f "$(WARN_LIST)" "$(WARN_SEEN)"
	@find $(WARN_LOG_DIR)/ -maxdepth 1 -type f -name 'trios_build_dev.*.log' \
		-mmin +60 -delete 2>/dev/null || true; \
	log=$$(mktemp $(WARN_LOG_DIR)/trios_build_dev.$$$$.XXXXXX) || exit 1; \
	mv "$$log" "$$log.log" || exit 1; log="$$log.log"; \
	id="dev.$$$$.$$(date +%s).$$RANDOM"; \
	printf '[trios-build-id] %s\n' "$$id" > "$$log"; \
	echo "[dev] build log $$log (id $$id)"; \
	TRIOS_VARIANT=dev TRIOS_BUILD_SHOW_INCREMENTAL=1 "$(ROOT)/build.sh" >> "$$log" 2>&1; \
	cp "$$log" "$(WARN_LOG_LAST).new.$$$$" 2>/dev/null && \
		mv "$(WARN_LOG_LAST).new.$$$$" "$(WARN_LOG_LAST)" 2>/dev/null; \
	rm -f "$(WARN_LOG_LAST).new.$$$$"; \
	if grep -q "Build successful: $(ROOT)/trios_dev_app" "$$log"; then \
		echo "[OK] dev app built"; \
		grep -q "swift test failed" "$$log" && \
			echo "[NOTE] XCTest suite still broken (pre-existing); run 'make xctest' for detail"; \
		$(MAKE) --no-print-directory warning-gate WARN_LOG="$$log" WARN_BUILD_ID="$$id" || exit 1; \
		exit 0; \
	else \
		echo "[FAIL] dev app did not build (log: $$log):"; \
		grep -E "error:" "$$log" | head -10; \
		exit 1; \
	fi

# Fold this build's warnings into the per-file cache and judge the tree total.
# Reads the log it is given - `dev` passes WARN_LOG and WARN_BUILD_ID for the
# build it just ran, and the id is checked before a line of the log is believed.
# Run by hand with no arguments it falls back to the last build's copy and says
# so; pass WARN_LOG=<path> to judge a particular build.
.PHONY: warning-gate
warning-gate:
	@log="$(WARN_LOG)"; id="$(WARN_BUILD_ID)"; \
	if [ -z "$$log" ]; then \
		log="$(WARN_LOG_LAST)"; \
		echo "[NOTE] warning-gate: no WARN_LOG given, so this reads $(WARN_LOG_LAST),"; \
		echo "       a copy of whichever build finished last - not necessarily yours."; \
		echo "       'make dev' passes its own log and never comes through here."; \
	fi; \
	if [ ! -f "$$log" ]; then \
		echo "[NOTE] compiler warnings: no build log at $$log, so nothing is counted."; \
		echo "       Run 'make dev'."; \
		exit 0; \
	fi; \
	ids=$$(/usr/bin/grep -ac '^\[trios-build-id\] ' "$$log" || true); \
	if [ -n "$$id" ]; then \
		if [ "$${ids:-0}" != "1" ]; then \
			echo "[FAIL] warning-gate: $$log carries $${ids:-0} build ids."; \
			echo "       A log holds exactly one build; this one was written by more"; \
			echo "       than one, so nothing in it can be attributed. Rebuild."; \
			exit 1; \
		fi; \
		if ! /usr/bin/grep -qaxF "[trios-build-id] $$id" "$$log"; then \
			echo "[FAIL] warning-gate: $$log was not written by build $$id."; \
			exit 1; \
		fi; \
		echo "[gate] judging build $$id from $$log"; \
	fi; \
	if [ ! -f "$(WARN_OFM)" ]; then \
		echo "[NOTE] compiler warnings: no output file map at $(WARN_OFM), so the file"; \
		echo "       list is unknown and no count is reported. Run 'make warnings'."; \
		exit 0; \
	fi; \
	tmp=$$(mktemp -d /tmp/trios_warn.XXXXXX) || exit 1; \
	trap 'rm -rf "$$tmp"' EXIT INT TERM; \
	awk '/^  "\//{src=$$0;sub(/^  "/,"",src);sub(/": \{$$/,"",src);next} \
	     /^    "object": /{o=$$0;sub(/^    "object": "/,"",o);sub(/",$$/,"",o); \
	       if(src!=""){n=split(o,p,"/");print p[n] "\t" src;src=""}}' \
		"$(WARN_OFM)" | sort > "$$tmp/all"; \
	cut -f2 "$$tmp/all" | sort -u > "$$tmp/sources"; \
	total=$$(wc -l < "$$tmp/sources" | tr -d ' '); \
	remarks=$$(/usr/bin/grep -c "Incremental compilation:" "$$log" 2>/dev/null || true); \
	unknown=0; \
	if [ -n "$${TRIOS_BUILD_CLEAN:-}" ]; then \
		: > "$$tmp/skipped"; \
	elif [ "$${remarks:-0}" -gt 0 ]; then \
		sed -n 's/.*Incremental compilation: Skipping input:.*{compile: \([^ ]*\.o\) .*/\1/p' \
			"$$log" | sort -u > "$$tmp/skipped"; \
	else \
		unknown=1; cut -f1 "$$tmp/all" | sort -u > "$$tmp/skipped"; \
	fi; \
	awk -v first="$$tmp/skipped" \
		'FILENAME==first{skip[$$1]=1;next} !($$1 in skip){print $$2}' \
		"$$tmp/skipped" "$$tmp/all" | sort -u > "$$tmp/compiled"; \
	compiled=$$(wc -l < "$$tmp/compiled" | tr -d ' '); \
	awk '/Copied and signed/{exit} {print}' "$$log" 2>/dev/null \
		| /usr/bin/grep -E "^$(ROOT)/[^:]+\.swift:[0-9]+:[0-9]+: warning: " \
		| sort -u > "$$tmp/fresh" || true; \
	touch "$(WARN_LIST)" "$(WARN_SEEN)"; \
	awk -v first="$$tmp/compiled" \
		'FILENAME==first{c[$$0]=1;next}{p=$$1;sub(/:[0-9]+:[0-9]+:$$/,"",p);if(!(p in c))print}' \
		"$$tmp/compiled" "$(WARN_LIST)" > "$$tmp/kept"; \
	cat "$$tmp/kept" "$$tmp/fresh" | sort -u > "$$tmp/merged"; \
	awk -v first="$$tmp/sources" \
		'FILENAME==first{s[$$0]=1;next}{p=$$1;sub(/:[0-9]+:[0-9]+:$$/,"",p);if(p in s)print}' \
		"$$tmp/sources" "$$tmp/merged" > "$$tmp/list"; \
	if [ "$$unknown" -eq 1 ]; then \
		: > "$$tmp/seen"; \
	else \
		cat "$(WARN_SEEN)" "$$tmp/compiled" | sort -u \
			| comm -12 - "$$tmp/sources" > "$$tmp/seen"; \
	fi; \
	cp "$$tmp/list" "$(WARN_LIST)"; cp "$$tmp/seen" "$(WARN_SEEN)"; \
	measured=$$(wc -l < "$$tmp/seen" | tr -d ' '); \
	count=$$(awk '{print $$1}' "$$tmp/list" | sort -u | wc -l | tr -d ' '); \
	if [ "$$measured" -ge "$$total" ]; then \
		echo "[OK] $$count compiler warnings in the tree ($$measured/$$total files measured, $$compiled recompiled this build)"; \
	elif [ "$$unknown" -eq 1 ]; then \
		echo "[NOTE] this build did not report which files it compiled, so the tree total"; \
		echo "       is unknown; $$count warning(s) seen in its own output. Partial count:"; \
		echo "       the ceiling of $(WARNING_CEILING) is not being enforced against the tree."; \
		echo "       Run 'make warnings' for a full count."; \
	else \
		echo "[NOTE] partial count: $$count warning(s) across the $$measured of $$total files"; \
		echo "       measured so far ($$compiled recompiled this build). The other"; \
		echo "       $$((total - measured)) file(s) have not been compiled since the cache was"; \
		echo "       created, so a warning in them is not in this number, and the ceiling"; \
		echo "       of $(WARNING_CEILING) is not being enforced against the tree."; \
		echo "       Run 'make warnings' for a full count."; \
	fi; \
	if [ "$$count" -gt $(WARNING_CEILING) ]; then \
		echo "[FAIL] $$count compiler warnings; the ceiling is $(WARNING_CEILING)."; \
		sed 's|$(ROOT)/||' "$$tmp/list" | sort -u | head -25; \
		exit 1; \
	fi; \
	if [ "$$measured" -ge "$$total" ] && [ "$$count" -lt $(WARNING_CEILING) ]; then \
		echo "[NOTE] $$count warnings, under the ceiling of $(WARNING_CEILING)."; \
		echo "       Lower WARNING_CEILING in the Makefile so the gain cannot be given back."; \
	fi

# --- The full count, without the cold build ------------------------------
#
# The full count is a build directory that has compiled every file, plus a cache
# of what each compile said. The old target got that by throwing the dev
# directory away and building it back - correct, and 96-108s, which is how a
# check gets skipped and how this gate rotted in the first place.
#
# Nothing about the count needs the directory to be *new*; it needs it to be
# *complete*. So the count gets its own directory, .trinity/build/warn/dev, and
# keeps it. First run compiles all 185 files and fills the cache. Later runs
# recompile only what changed and refresh those entries, and every other file's
# entry is still the one its own compile produced. That is a full count from an
# incremental build - measurements at the bottom.
#
# Why a second directory rather than reusing .trinity/build/dev:
#   - the dev directory's cache is whatever the day's dev builds happened to
#     touch, and the thing being asked for here is completeness;
#   - a cold repair of the dev directory makes the NEXT `make dev` slow too;
#   - `make dev` and this target can then be measured against each other
#     without one deleting the other's objects.
# The cost is a second copy of the objects, ~55 MB, inside .trinity/build/ so
# .gitignore already covers it (a sibling .trinity/build-warn/ would not be
# ignored, and 55 MB of untracked object files is its own kind of bug).
#
# The number still has to describe the TREE. Two things could make it not:
#
#   1. A file the warn directory has never compiled - a new source file, an
#      interrupted first run, or a build whose compiles could not be attributed
#      at all (see the `unknown` branch in the gate: it empties `seen`, which a
#      toolchain change that disables incrementality can do). The gate already
#      handles this: `seen` is the set of files this directory has measured, and
#      when it is smaller than the file list the gate prints the partial-count
#      paragraph, refuses to claim the tree is clean, and refuses the
#      lower-the-ceiling advice. So the failure mode of a persistent directory
#      is a count that says it is incomplete, not one that is quietly wrong.
#      Driven: deleting one line from warnings.seen and re-running printed
#      "partial count: 4 warning(s) across the 184 of 185 files".
#      One thing does change, though. The gate's repair advice is "Run 'make
#      warnings' for a full count", which is right when `make dev` prints it and
#      circular when this target does - and an emptied `seen` is not something a
#      reuse build can refill, since the files it describes do not need
#      recompiling. So a partial result here is not advised away: the target
#      deletes the directory and counts again from scratch, once. If even that
#      is partial it says so and stops, rather than looping.
#   2. A first run whose compiles cannot be attributed. On an empty directory
#      there is no build record, the driver prints no "Incremental compilation:"
#      remarks, and the gate's attribution branch would empty `seen` and report
#      partial - a false partial on the one run that really did compile
#      everything. So when the directory has no objects and no build record this
#      target sets TRIOS_BUILD_CLEAN=1, which is true by construction and tells
#      the gate to count every file in the map as compiled. Setting it on an
#      already-empty directory costs nothing (build.sh rm -rf's a path that is
#      not there).
#
# What this target does NOT do: repair the dev directory's cache. It used to, as
# a side effect of rebuilding it. `make dev` reports from its own cache and gets
# it complete by compiling; this target answers the question directly instead.
#
# It skips the chat e2e, swift test and the vendored-interface probe. None of
# them can emit a compiler warning that this count reads - the gate cuts the log
# at "Copied and signed" - and they are most of what a build costs once the
# compile is incremental. `make dev` still runs all three; this is a measuring
# instrument, not a substitute for a build.
#
# Measured, one revision, this machine, each run printing
# "[OK] 4 compiler warnings in the tree (185/185 files measured, N recompiled)":
#
#   rm -rf .trinity/build/warn; make warnings   57s   (N=185)
#   make warnings, nothing touched               3s   (N=0)
#   touch one file; make warnings                4s   (N=1)
#
# against 96-108s for the old target on every one of those. Two honest notes on
# that first number. It is 57s rather than ~100s partly because of the skips
# above, not only because of the directory: the directory is what turns the
# SECOND run into 3s. And "touch one file" recompiles exactly that file, because
# touching does not change what the file exports; a real edit that changes a
# type or a signature also recompiles its dependents, so 4s is the floor of that
# row and 57s is its ceiling.
#
# The lock. The warn build compiles into its own directory, but build.sh derives
# the OUTPUT binary from the variant, so a dev-variant build links
# $(ROOT)/trios_dev_app and signs $(DEV_APP) wherever its objects live. Two
# linkers on one output path is a corrupt binary, and until now build.sh's dev
# lock serialized them because the full count WAS a dev build. A private
# directory silently gives that up, so this target takes the dev build lock
# itself, with build.sh's protocol: mkdir, owner pid inside, reclaim when the
# owner is gone. What stays exposed is the same thing two concurrent `make dev`
# runs expose - build.sh releases the lock after the compile and copies and
# signs the bundle outside it.
WARN_FULL_ROOT  := $(ROOT)/.trinity/build/warn
WARN_FULL_CACHE := $(WARN_FULL_ROOT)/dev
DEV_BUILD_LOCK  := $(ROOT)/.trinity/build/dev.lock

.PHONY: warnings
warnings:
	@start=$$(date +%s); \
	clean=""; \
	if [ ! -d "$(WARN_FULL_CACHE)/obj" ] || [ ! -f "$(WARN_FULL_CACHE)/master.priors" ]; then \
		clean=1; \
		echo "[warnings] full count: $(WARN_FULL_CACHE) holds no usable build,"; \
		echo "           so this run compiles every file. Later runs reuse it."; \
	else \
		echo "[warnings] full count: reusing $(WARN_FULL_CACHE); only changed files recompile."; \
	fi; \
	mkdir -p "$(ROOT)/.trinity/build"; \
	waited=0; reclaims=0; \
	while ! mkdir "$(DEV_BUILD_LOCK)" 2>/dev/null; do \
		owner=$$(cat "$(DEV_BUILD_LOCK)/pid" 2>/dev/null || true); \
		if [ -z "$$owner" ] || ! kill -0 "$$owner" 2>/dev/null; then \
			reclaims=$$((reclaims + 1)); \
			if [ "$$reclaims" -gt 3 ]; then \
				echo "[FAIL] cannot create $(DEV_BUILD_LOCK) and it has no live owner."; \
				echo "       Three reclaims in a row means mkdir is failing for some other"; \
				echo "       reason; stopping rather than spinning on it."; \
				exit 1; \
			fi; \
			echo "[warnings] reclaiming stale dev build lock (owner $${owner:-unknown} is gone)"; \
			rm -rf "$(DEV_BUILD_LOCK)"; \
			mkdir -p "$(ROOT)/.trinity/build"; \
			continue; \
		fi; \
		if [ "$$waited" -ge 900 ]; then \
			echo "[FAIL] a dev build (pid $$owner) still holds $(DEV_BUILD_LOCK) after $${waited}s;"; \
			echo "       not starting a second build against $(ROOT)/trios_dev_app."; \
			exit 1; \
		fi; \
		if [ "$$waited" = "0" ]; then \
			echo "[warnings] waiting for the dev build lock held by pid $$owner..."; \
		fi; \
		sleep 2; waited=$$((waited + 2)); \
	done; \
	echo $$$$ > "$(DEV_BUILD_LOCK)/pid"; \
	trap 'rm -rf "$(DEV_BUILD_LOCK)"' EXIT INT TERM; \
	find $(WARN_LOG_DIR)/ -maxdepth 1 -type f -name 'trios_build_warn.*.log' \
		-mmin +60 -delete 2>/dev/null || true; \
	status=0; \
	for attempt in 1 2; do \
		log=$$(mktemp $(WARN_LOG_DIR)/trios_build_warn.$$$$.XXXXXX) || exit 1; \
		mv "$$log" "$$log.log" || exit 1; log="$$log.log"; \
		id="warn.$$$$.$$(date +%s).$$RANDOM"; \
		printf '[trios-build-id] %s\n' "$$id" > "$$log"; \
		echo "[warnings] build log $$log (id $$id)"; \
		bstart=$$(date +%s); \
		TRIOS_VARIANT=dev \
		TRIOS_BUILD_DIR="$(WARN_FULL_ROOT)" \
		TRIOS_BUILD_CLEAN="$$clean" \
		TRIOS_BUILD_SHOW_INCREMENTAL=1 \
		TRIOS_SKIP_CHAT_E2E=1 \
		TRIOS_SKIP_SWIFT_TEST=1 \
		TRIOS_SKIP_VENDOR_CHECK=1 \
			"$(ROOT)/build.sh" >> "$$log" 2>&1; \
		bend=$$(date +%s); \
		if ! /usr/bin/grep -q "Build successful: $(ROOT)/trios_dev_app" "$$log"; then \
			echo "[FAIL] the warning build did not compile, so there is no count (log: $$log):"; \
			/usr/bin/grep -E "error:" "$$log" | head -10; \
			echo "[warnings] gave up after $$((bend - start))s"; \
			exit 1; \
		fi; \
		echo "[warnings] build took $$((bend - bstart))s"; \
		status=0; \
		out=$$(TRIOS_BUILD_CLEAN="$$clean" $(MAKE) --no-print-directory warning-gate \
			WARN_LOG="$$log" WARN_BUILD_ID="$$id" \
			WARN_BUILD_DIR="$(WARN_FULL_CACHE)" 2>&1) || status=1; \
		printf '%s\n' "$$out"; \
		case "$$out" in *"compiler warnings in the tree"*) break ;; esac; \
		if [ "$$status" != "0" ]; then break; fi; \
		if [ -n "$$clean" ]; then \
			echo "[warnings] a from-scratch build still could not account for every file,"; \
			echo "           so the count above is a lower bound. Treat it as one."; \
			break; \
		fi; \
		echo "[warnings] the reused directory cannot account for every file, so the count"; \
		echo "           above is partial and running this target again would repeat it."; \
		echo "           Rebuilding $(WARN_FULL_ROOT) from scratch - the expensive path,"; \
		echo "           taken here rather than advised, because a full count was asked for."; \
		rm -rf "$(WARN_FULL_ROOT)"; \
		clean=1; \
	done; \
	echo "[warnings] full count took $$(($$(date +%s) - start))s"; \
	exit $$status

release:
	@: "The mid-flight check belongs HERE, not only in relaunch. Measured on"; \
	: "2026-08-22: a release build ran while a worker was mid-flight, the"; \
	: "build replaced the bundle under the running app, the app died at"; \
	: "13:24:52 - and `make relaunch` then REFUSED, because the registry"; \
	: "still showed a worker running. The guard meant to protect that bee"; \
	: "held the app down after the build had already orphaned it: no"; \
	: "menu-bar logo, no supervisor, and the bee orphaned anyway. Refusing"; \
	: "before the build is the only order in which the guard protects"; \
	: "anything."; \
	running=$$(python3 -c "import json,sys; \
	    d=json.load(open('$(ROOT)/.trinity/state/queen_delegation.json')); \
	    t=d if isinstance(d,list) else d.get('tasks',d); \
	    t=list(t.values()) if isinstance(t,dict) else t; \
	    print(sum(1 for x in t if x.get('state')=='running'))" 2>/dev/null || echo 0); \
	if [ "$$running" != "0" ] && [ -z "$(FORCE)" ]; then \
		echo "[HOLD] $$running worker(s) are mid-flight; a release build replaces"; \
		echo "       the bundle under the running app and kills it, orphaning them."; \
		echo "       Wait, or override with: make release FORCE=1"; \
		exit 1; \
	fi
	@echo "Building RELEASE. This replaces $(RELEASE_APP)."
	@TRIOS_VARIANT=prod "$(ROOT)/build.sh" > /tmp/trios_build_release.log 2>&1; \
	if grep -q "Build successful: $(ROOT)/trios_app" /tmp/trios_build_release.log; then \
		echo "[OK] release app built"; exit 0; \
	else \
		echo "[FAIL] release app did not build:"; \
		grep -E "error:" /tmp/trios_build_release.log | head -10; exit 1; \
	fi

# --- Golden chain -------------------------------------------------------
#
# The spec and the hand-written code must agree, or the spec is decoration.
# This regenerates the Queen's decision core from rings/T27-00/queen_core.t27,
# builds the generated Rust and the hand-written Swift, runs both over the same
# grid of inputs, and diffs. Any difference is the chain broken.
#
# t27c is built once into .trinity/t27c-build (never into the shared t27
# checkout, which belongs to another agent).
T27C := $(ROOT)/.trinity/t27c-build/release/t27c
CHAIN_DIR := $(ROOT)/.trinity/goldenchain

chain:
	@test -x "$(T27C)" || { \
		echo "[chain] building t27c (artifacts stay in .trinity/t27c-build)"; \
		CARGO_TARGET_DIR="$(ROOT)/.trinity/t27c-build" cargo build --release \
			--manifest-path "$(T27_ROOT)/bootstrap/Cargo.toml" > /tmp/t27c_build.log 2>&1 \
			|| { echo "[FAIL] t27c did not build:"; tail -5 /tmp/t27c_build.log; exit 1; }; \
	}
	@mkdir -p "$(CHAIN_DIR)/twinsrc"
	@"$(T27C)" gen-rust "$(ROOT)/rings/T27-00/queen_core.t27" > "$(CHAIN_DIR)/core.rs" \
		|| { echo "[FAIL] the spec did not generate"; exit 1; }
	@cd "$(CHAIN_DIR)" && rustc --edition 2021 -O main.rs -o ring 2>/dev/null \
		|| { echo "[FAIL] the generated ring did not compile"; exit 1; }
	@DEVELOPER_DIR=$(DEVELOPER_DIR) xcrun swiftc "$(CHAIN_DIR)/twinsrc/main.swift" \
		"$(ROOT)/rings/SR-00/QueenRetryPolicy.swift" \
		"$(ROOT)/rings/SR-00/QueenReviewDecision.swift" \
		-o "$(CHAIN_DIR)/twin" 2>/dev/null \
		|| { echo "[FAIL] the hand-written twin did not compile"; exit 1; }
	@"$(CHAIN_DIR)/ring" > "$(CHAIN_DIR)/ring.out"
	@"$(CHAIN_DIR)/twin" > "$(CHAIN_DIR)/twin.out"
	@if diff -q "$(CHAIN_DIR)/ring.out" "$(CHAIN_DIR)/twin.out" > /dev/null; then \
		echo "[OK] golden chain intact: $$(wc -l < "$(CHAIN_DIR)/ring.out" | tr -d ' ') verdicts, spec and code agree"; \
	else \
		echo "[FAIL] the spec and the hand-written code disagree:"; \
		diff "$(CHAIN_DIR)/ring.out" "$(CHAIN_DIR)/twin.out" | head -10; \
		exit 1; \
	fi

build: dev

# --- Verifying ----------------------------------------------------------

test:
	@cargo run --quiet --bin clade-e2e

e2e:
	@bash "$(ROOT)/tests/swift/run_chat_sse_e2e.sh"; e2e_status=$$?; \
	E2E_DIR="$(ROOT)/.trinity/e2e"; \
	if [ -d "$$E2E_DIR" ]; then \
		before_count=$$(find "$$E2E_DIR" -maxdepth 1 -type f | wc -l | tr -d ' '); \
		before_kb=$$(du -sk "$$E2E_DIR" 2>/dev/null | cut -f1); \
		find "$$E2E_DIR" -maxdepth 1 -type f \( -name 'report_*' -o -name 'screenshot_*' \) \
			| sed -E 's/.*_([0-9]+)\.[a-z]+$$/\1/' \
			| grep -E '^[0-9]+$$' \
			| sort -rn \
			| uniq \
			| tail -n +6 \
			| while IFS= read -r ts; do \
				rm -f "$$E2E_DIR"/*_"$$ts".md "$$E2E_DIR"/*_"$$ts".png; \
			done; \
		after_count=$$(find "$$E2E_DIR" -maxdepth 1 -type f | wc -l | tr -d ' '); \
		after_kb=$$(du -sk "$$E2E_DIR" 2>/dev/null | cut -f1); \
		echo "[prune] e2e: removed $$((before_count - after_count)) file(s), freed $$((before_kb - after_kb)) KB"; \
	fi; \
	exit $$e2e_status

# --- Shaking (resource-affected flakiness) ------------------------------
#
# `make e2e` answers "does the suite pass right now, on this machine, as busy
# as it happens to be". That is a different question from "does the suite
# pass", and the two came apart here: nine agents shared this Mac, the suite
# went red, and hours went into deciding whether the failure was real.
#
# Silva et al. (Shaker, ICSME 2020) measured that 46.5% of flaky tests are
# resource-affected - their failure rate moves with machine load - and that
# the way to find them is to add the load on purpose rather than wait for it.
# `make shake` does that: one unloaded baseline run, then as many loaded runs
# as the requested confidence bound needs - one busy loop per core and an I/O
# writer alongside each of them - and a verdict that
# separates "failed every single time" (broken) from "failed some of the
# time" (flaky) from "only fails when the machine is busy".
#
# HOW MANY RUNS, AND WHY THAT MANY
# n all-passing runs reject "the per-run failure rate is >= p0" at 95%
# confidence exactly when (1-p0)^n <= 0.05, so n = ceil(log(0.05)/log(1-p0)).
# The old default of 5 runs therefore announced a 45% bound - free, and
# meaningless: a suite failing 45% of the time is broken, not flaky, and one
# run tells you. The flakes that cost days here are the single-digit ones.
#
# So the caller now names the BOUND and the script buys the runs:
#   SHAKE_BOUND=45 ->   6 runs,  ~4 min      (what this target used to be)
#   SHAKE_BOUND=20 ->  14 runs, ~10 min
#   SHAKE_BOUND=10 ->  29 runs, ~20 min      DEFAULT
#   SHAKE_BOUND=5  ->  59 runs, ~40 min
#   SHAKE_BOUND=1  -> 299 runs, ~3h20m
# at ~40s per loaded run plus a ~25s unloaded baseline, measured on this 8-core
# machine. 10% is the knee: the tightest bound that still fits in a coffee
# break, and the loosest one that says something about a real flake rate.
#
# NOT IN `make check`, deliberately. Two reasons, either sufficient. First,
# check does not run the e2e flow even once (that is `make e2e`), so adding 29
# loaded repeats of it would not tighten check - it would replace it with a
# different, twenty-minute target. Second, shake answers "is this machine
# making my suite lie?", a question about the machine and the calendar, not
# about the diff in front of you; the answer does not change per commit, so
# paying for it per commit buys nothing. Run it when a red run smells like
# noise, when the e2e suite grows a new wait, or on a nightly.
#
# Knobs: SHAKE_BOUND, SHAKE_RUNS, SHAKE_LOAD, SHAKE_IO, SHAKE_BASELINE, SHAKE_SUITE.
#   make shake SHAKE_BOUND=20         looser bound, ~10 min
#   make shake SHAKE_RUNS=10          exactly 10 runs, whatever bound that earns
#                                     (25.9%); the budget Shaker itself used
#   make shake SHAKE_LOAD=0           no CPU load - reruns only
# Exit status: 0 stable, 1 broken (the unloaded baseline failed), 2 flaky or
# load-induced, 3 the load generator never spun up so nothing was measured.
.PHONY: shake
shake:
	@bash "$(ROOT)/tests/swift/shake_e2e.sh"

# --- Keychain door guard ------------------------------------------------
#
# SecItemCopyMatching, SecItemAdd, SecItemUpdate and SecItemDelete are the
# four doors into the system keychain.  Three times running I closed every
# entrance I knew about and a fourth was left open.  This check replaces
# vigilance with a gate: it fails if any of those calls appears in a Swift
# file outside the allowlist below.
#
# Allowlist — each file is the sole place permitted to call keychain
# functions, for the reason given:
#   rings/SR-00/KeychainSecrets.swift           – canonical keychain abstraction
#   rings/SR-00/KeychainSymmetricKeyStore.swift – symmetric-key storage
#   rings/SR-00/ModelConfigurationStore.swift   – persists model secrets
#   BR-OUTPUT/ProjectPaths.swift                – build-generated keychain identifiers
#   tools/keychain_floor.swift                  - measures what the API itself costs
#
# keychain_floor is on the list ON PURPOSE and is the one entry that is not app
# code. Its whole job is to time SecItemCopyMatching against the real Keychain,
# so routing it through KeychainSecrets would measure KeychainSecrets - the
# deadlines, the cooldown, the single-flight - instead of the call underneath
# them. That is exactly the confusion it exists to end: for weeks the stall was
# attributed to the Keychain by code that could not see the two apart. It never
# ships in the app: it is compiled to a temp path by `make keychain-floor` and
# deleted after the run.
KEYCHAIN_ALLOWLIST := rings/SR-00/KeychainSecrets.swift rings/SR-00/KeychainSymmetricKeyStore.swift rings/SR-00/ModelConfigurationStore.swift BR-OUTPUT/ProjectPaths.swift tools/keychain_floor.swift
KEYCHAIN_ALLOW_PATTERNS := $(addprefix -e ,$(KEYCHAIN_ALLOWLIST))

.PHONY: keychain-doors
keychain-doors:
	@: "Matched on CODE lines only. A line whose first non-blank characters are"; \
	: "// or * is prose, and prose cannot open a keychain door - the rule fired"; \
	: "on a comment that merely NAMED SecItemCopyMatching while explaining why"; \
	: "the suite must not touch the keychain, which is the opposite of a"; \
	: "violation. This filter cannot hide a real call: a call on a line that"; \
	: "starts with // is not a call."; \
	offending=$$(/usr/bin/grep -rnE 'SecItem(CopyMatching|Add|Update|Delete)' \
		--include='*.swift' --exclude-dir='.build' --exclude-dir='.git' \
		--exclude-dir='.worktrees' --exclude-dir='trios_dev_app' --exclude-dir='trios_app' \
		"$(ROOT)" \
		| /usr/bin/grep -vE '^[^:]*:[0-9]+:[[:space:]]*(//|\*)' \
		| cut -d: -f1 \
		| sed "s|$(ROOT)/||" | sort -u \
		| grep -vxF $(KEYCHAIN_ALLOW_PATTERNS) || true); \
	if [ -n "$$offending" ]; then \
		echo "[FAIL] direct keychain API calls outside the allowlist:"; \
		echo "$$offending" | sed 's/^/  /'; \
		echo "Route keychain access through KeychainSecrets, or add the file to KEYCHAIN_ALLOWLIST on purpose."; \
		exit 1; \
	else \
		echo "[OK] keychain doors are routed through the allowlist"; \
	fi

# --- Dollar-sign guard -------------------------------------------------
#
# A shell variable in a recipe needs $; a single $ is eaten by Make and
# the recipe silently does the wrong thing ($E2E_DIR became 2E_DIR in
# #1237).  This check walks every recipe line and flags a lone $ that is
# neither $ nor a Make variable in the allowlist below.
#
# The allowlist has to carry variables Make provides and variables the caller
# passes on the command line, not only the ones defined above it.  `$(HOME)` in
# t27-rings and `$(FORCE)` in relaunch are both correct, and their absence here
# made this gate fail on the real Makefile - which failed check-selftest's
# clean-fixture half, which failed `make check` outright.  A gate that is red on
# the tree it guards teaches everyone to run something other than `make check`.
MAKE_DOLLAR_VARS := ROOT DEV_APP RELEASE_APP DEV_BIN RELEASE_BIN DEV_PROC \
	TEST_APP TEST_PROC TEST_BIN TEST_LOG TEST_PROC_HERE DEV_PROC_HERE \
	T27C T27_ROOT CHAIN_DIR DEVELOPER_DIR T27_LOWERING_EXCEPT T27_NOCOMPILE_CEILING \
	RELEASE_PROC WARNING_CEILING XCTEST_ERROR_CEILING CASSETTE_DIR \
	WARN_VARIANT WARN_BUILD_DIR WARN_OFM WARN_LIST WARN_SEEN WARN_LOG WARN_LOG_DIR \
	WARN_LOG_LAST WARN_BUILD_ID WARN_FULL_ROOT WARN_FULL_CACHE DEV_BUILD_LOCK \
	CASSETTE_BRANCHES SWEEP_CANARY LOG KEYCHAIN_ALLOW_PATTERNS MAKE VARIANT \
	CASSETTE_TOTAL_BUDGET \
	LOG_VARIANT \
	MSG ISSUE WORKER TASK PATHS CRITERIA SECOND REVIEW AUTONOMY CASSETTE \
	SECOND_TURN QUEEN_COMMAND MUTANTS MUTANTS_LOGIC MUTANTS_GUARD MAKE_DOLLAR_VARS HARNESS_LOCK HARNESS_LOCK_WAIT GUARDS \
	TYPE_STATE VARIANT_FENCE_SRC VARIANT_FENCE_DIR \
	VENDOR_SRC VENDOR_BEGIN VENDOR_END VENDOR_ANCHOR VENDOR_HALVES \
	SOURCES_MANIFEST SOURCES_APP_ONLY SOURCES_TEST_ONLY \
	HOME FORCE

.PHONY: make-dollars
# The decision core must answer the same in Swift, in generated Rust, and in
# simulated Verilog.
#
# Ring 00 exists to be one rule rather than four that agree until someone edits
# one. That claim is only worth making if it is checked, and it is checkable
# cheaply: both harnesses generate from the same `.t27`, run a shared table of
# inputs, and compare against the answers Swift gives.
#
# Skipped rather than failed when the toolchain is absent - t27c lives in a
# sibling repository and iverilog is a brew install. A machine without them
# should not be told the ring is broken.
#
# That skip is also how this gate spent months asleep. It looked for t27c at
# exactly one path, `~/t27/target/release/t27c`, which is a build product
# inside the sibling repository - a directory this repository may not write
# to, and which nobody here had any reason to populate. It has never existed
# on this machine. So the gate printed [SKIP], exited 0, and `make check`
# counted it as passed. Both rings were unchecked the whole time. (Measured
# 2026-08-23: given a compiler, both pass - 14 rows and 21 constants in ring
# 00, the full rule table in ring 01. Nothing was broken. Nothing was known
# either, and a gate that cannot tell those apart is not a gate.)
#
# The compiler's SOURCES, however, are readable, and building them is
# allowed as long as the build products land here rather than there. So the
# three cases are now distinguished:
#
#   binary present            -> run
#   sources present, no binary -> build it, then run
#   no sources                -> skip, and say NOT MEASURED in those words
#
# A failed build is a failure, not a skip: if the compiler is here and will
# not build, that is exactly the news this gate exists to carry.
# How many generated Rust files may still fail to compile. A ratchet, not a
# target: it may fall, and raising it needs a reason in the commit message.
#
# Measured 2026-08-23: 20 of 70. Lowered to 11 on 2026-08-28 after eight spec
# faults were repaired and eighteen stale artifacts regenerated (tri-net
# 2257dea): most of the remaining eleven are backend faults, chiefly gen-rust
# never emitting `mut` on a function parameter, so this number will not fall
# much further from the spec side.
# Counting functions proved necessary and not
# sufficient - four specs (lite_crypto, packet_queue, hardware_validation,
# multipath_router) keep every function and lose whole `return` statements
# inside them, so the count stays right while the code stops meaning anything.
# rustc is the cheapest independent reader available, so it reads them.
T27_NOCOMPILE_CEILING := 11

# Declared backend limitations, in the form <spec>:<backend>:<shortfall>.
#
# A limitation that is DECLARED is reviewed; one that is silent is a defect.
# The whole point of t27-lowering is to move drops from the second category
# into the first, so the list must stay short and every entry must say why.
#
#   auto_config.t27:c:2 - create_default_config and create_backup both return
#   [u32; MAX_PARAMS] by value. C cannot return an array by value, so the C
#   backend omits them. Rust and Zig emit all 19. This is the only spec in the
#   corpus with array-returning functions, and the right repair is a declared
#   capability in the backend descriptor (architecture document, section 7.2),
#   not a rewrite of the spec to suit one target.
T27_LOWERING_EXCEPT := auto_config.t27:c:2

# Every function a spec declares must survive into the generated code.
#
# t27c's parser silently discards any statement it cannot parse:
# `Parser::parse_fn_body` does `Err(_) => self.recover_to_stmt_boundary()`, and
# the recovery skips to the next `;` at brace depth 0. Exit code 0. Empty
# stderr. Reported upstream as gHashTag/t27#2508, in a repository this one may
# not edit.
#
# So every gate here that trusted the compiler's exit status was failing open.
# `t27-rings` and `chain` compile and RUN what they generate, which catches a
# broken function - but not a DELETED one, because code nobody calls cannot
# fail. This target catches the deletion directly, by counting.
#
# Measured when it was written: `trust_manager.t27` declares 21 functions and
# emits 12. Nine had been silently gone, in this repository, undetected by
# anything, for as long as the spec has existed.
#
# `unimplemented!()` is counted too. It is the compiler's EMPTY-BODY fallback,
# not a per-construct stub, so it means the body was emptied rather than that
# a function was left deliberately unwritten.
.PHONY: t27-lowering
t27-lowering:
	@if [ ! -x "$(T27C)" ]; then \
		if [ -f "$(T27_ROOT)/bootstrap/Cargo.toml" ]; then \
			echo "[FAIL] t27-lowering: no t27c binary, but its sources are at"; \
			echo "       $(T27_ROOT)/bootstrap. Run 'make t27-rings' once - it builds one."; \
			echo "       Skipping here would be the failing-open this target exists to stop."; \
			exit 1; \
		fi; \
		echo "[SKIP] t27-lowering: NOT MEASURED - no t27c and no sources at"; \
		echo "       $(T27_ROOT)/bootstrap. Nothing was checked by this run."; \
		exit 0; \
	fi; \
	bad=0; tot=0; declared=0; nocompile=0; \
	tmpd=$$(mktemp -d); trap 'rm -rf "$$tmpd"' EXIT; \
	: "Worktrees excluded. A subagent left a checkout at"; \
	: "rings/RUST-13/trios-mesh/.claude/worktrees/<name>/specs, and the"; \
	: "first version of this gate scanned it - 138 specs instead of 70,"; \
	: "reporting a defect that had already been fixed in the real tree."; \
	: "A gate must measure the tree that ships, not a copy of it."; \
	for f in $$(find "$(ROOT)/rings" -name '*.t27' \
			-not -path '*/.worktrees/*' -not -path '*/.claude/*' | sort); do \
		tot=$$((tot + 1)); \
		spec_fns=$$(grep -cE '^[[:space:]]*(pub )?fn ' "$$f"); \
		out=$$("$(T27C)" gen-rust "$$f" 2>/dev/null) || { \
			echo "  [FAIL] $$f: gen-rust exited nonzero"; bad=$$((bad + 1)); continue; }; \
		emitted=$$(printf '%s' "$$out" | grep -c '^pub fn '); \
		stubs=$$(printf '%s' "$$out" | grep -c 'unimplemented!'); \
		: "Every backend is counted, not only Rust. Each rule below was"; \
		: "validated against all 70 specs before being trusted: Zig matches"; \
		: "the spec exactly (0 of 70 disagreed), and C and Verilog are held"; \
		: "to 'at least', because both emit extra functions - Verilog a"; \
		: "wrapper, C the spec's test blocks - and a rule that pinned those"; \
		: "counts would be pinning behaviour I do not understand."; \
		: "The looser rule still caught a real one: auto_config declares 19"; \
		: "functions, Rust and Zig emit 19, and C emits 17. create_backup"; \
		: "and create_default_config reach two backends and not the third."; \
		zig=$$("$(T27C)" gen "$$f" 2>/dev/null | grep -cE '^(pub )?fn '); \
		cnt=$$("$(T27C)" gen-c "$$f" 2>/dev/null | grep -cE '^[a-zA-Z_].*\(.*\) *\{'); \
		vlg=$$("$(T27C)" gen-verilog "$$f" 2>/dev/null | grep -cE '^[[:space:]]*function '); \
		: "Measured with a FULL --crate-type lib build, not --emit=metadata."; \
		: "A metadata-only build does not run the MIR const-prop lint, so it"; \
		: "hides every arithmetic_overflow: olsr_routing reports 13 errors"; \
		: "under metadata and 26 under a full build. It does not change WHICH"; \
		: "specs fail today - no spec fails on overflow alone - but a number"; \
		: "taken from a metadata build can still fail cargo build."; \
		: "Counting is necessary and not sufficient. A body can lose a return"; \
		: "statement without losing its function, and the count stays right"; \
		: "while the code stops meaning anything. rustc is the cheapest"; \
		: "independent reader we have, so the output is compiled too."; \
		printf '%s' "$$out" > "$$tmpd/$$(basename $$f .t27).rs"; \
		if ! rustc --edition 2021 --crate-type lib -A unused_parens \
			--out-dir "$$tmpd" "$$tmpd/$$(basename $$f .t27).rs" 2>/dev/null; then \
			nocompile=$$((nocompile + 1)); \
			echo "  [nocompile] $$(basename $$f .t27)"; \
		fi; \
		if [ "$$spec_fns" != "$$emitted" ]; then \
			echo "  [FAIL] $$(basename $$f): rust emitted $$emitted of $$spec_fns declared"; \
			echo "         $$((spec_fns - emitted)) dropped before any backend ran."; \
			bad=$$((bad + 1)); \
		elif [ "$$stubs" != "0" ]; then \
			echo "  [FAIL] $$(basename $$f): $$stubs function body/bodies emptied (unimplemented!)"; \
			bad=$$((bad + 1)); \
		elif [ "$$spec_fns" != "$$zig" ]; then \
			echo "  [FAIL] $$(basename $$f): zig emitted $$zig of $$spec_fns declared"; \
			bad=$$((bad + 1)); \
		elif [ "$$cnt" -lt "$$spec_fns" ]; then \
			short=$$((spec_fns - cnt)); \
			if echo " $(T27_LOWERING_EXCEPT) " | grep -q " $$(basename $$f):c:$$short "; then \
				echo "  [declared] $$(basename $$f): c omits $$short of $$spec_fns - see T27_LOWERING_EXCEPT"; \
				declared=$$((declared + 1)); \
			else \
				echo "  [FAIL] $$(basename $$f): c emitted $$cnt, fewer than the $$spec_fns declared"; \
				echo "         Undeclared. If it is a real backend limitation, add"; \
				echo "         $$(basename $$f):c:$$short to T27_LOWERING_EXCEPT with a reason."; \
				bad=$$((bad + 1)); \
			fi; \
		elif [ "$$vlg" -lt "$$spec_fns" ]; then \
			echo "  [FAIL] $$(basename $$f): verilog emitted $$vlg, fewer than the $$spec_fns declared"; \
			bad=$$((bad + 1)); \
		fi; \
	done; \
	if [ $$nocompile -gt $(T27_NOCOMPILE_CEILING) ]; then \
		echo "[FAIL] $$nocompile of $$tot generated Rust files do not compile,"; \
		echo "       above the recorded ceiling of $(T27_NOCOMPILE_CEILING). A count that"; \
		echo "       only goes down is the point; raise the ceiling only with a reason."; \
		bad=$$((bad + 1)); \
	fi; \
	if [ $$bad -eq 0 ]; then \
		echo "[OK] every function survives lowering into all four backends ($$tot specs, $$declared declared limitation(s))"; \
		echo "     $$nocompile of $$tot generated Rust files still do not compile (ceiling $(T27_NOCOMPILE_CEILING))"; \
	else \
		echo "[FAIL] $$bad of $$tot specs lose code between spec and generated code."; \
		echo "       This is gHashTag/t27#2508. Rewrite the spec into the subset the"; \
		echo "       parser accepts: parenthesised conditions, explicit returns, no match."; \
		exit 1; \
	fi

t27-rings:
	@T27C_USE=""; \
	if [ -x "$(T27C)" ]; then \
		T27C_USE="$(T27C)"; \
	elif [ -x "$(HOME)/t27/target/release/t27c" ]; then \
		T27C_USE="$(HOME)/t27/target/release/t27c"; \
	elif [ -f "$(T27_ROOT)/bootstrap/Cargo.toml" ]; then \
		echo "[t27-rings] no t27c binary yet; building it from $(T27_ROOT)/bootstrap"; \
		echo "            (products go to .trinity/t27c-build, never into that checkout)"; \
		CARGO_TARGET_DIR="$(ROOT)/.trinity/t27c-build" cargo build --release \
			--manifest-path "$(T27_ROOT)/bootstrap/Cargo.toml" > /tmp/t27c_build.log 2>&1 \
			|| { echo "[FAIL] t27-rings: t27c did not build, so the rings could not be checked:"; \
			     tail -5 /tmp/t27c_build.log; exit 1; }; \
		T27C_USE="$(T27C)"; \
	else \
		echo "[SKIP] t27-rings: NOT MEASURED - no t27c binary and no sources at"; \
		echo "       $(T27_ROOT)/bootstrap. The rings were not checked by this run."; \
		exit 0; \
	fi; \
	echo "[t27-rings] using $$T27C_USE"; \
	T27C="$$T27C_USE" bash "$(ROOT)/tests/t27/ring00_parity.sh" || exit 1; \
	T27C="$$T27C_USE" bash "$(ROOT)/tests/t27/ring01_rules.sh" || exit 1; \
	if command -v iverilog >/dev/null 2>&1; then \
		T27C="$$T27C_USE" bash "$(ROOT)/tests/t27/ring00_verilog.sh" || exit 1; \
	else \
		echo "[SKIP] t27-rings: NOT MEASURED - iverilog is not installed, so the"; \
		echo "       Verilog half of ring 00 was not simulated by this run."; \
	fi

# Relaunch the app without killing bees that are mid-flight.
#
# 22 of the 40 failures in the dev registry tonight are `interrupted` - workers
# orphaned by my own `pkill && open`. Every rebuild-and-relaunch during a
# working swarm costs whatever those bees had in hand: the stream dies, the
# task is reaped, and the branch keeps a half-written change nobody asked for.
#
# The reaper records them as interruptions and does not count them against the
# issue, so the bookkeeping survives - but the work does not, and the cost was
# invisible because nothing ever said "you are about to kill three workers".
#
# `FORCE=1` overrides, because sometimes the running app is the thing that is
# broken.
relaunch:
	@running=$$(python3 -c "import json,sys; \
	    d=json.load(open('$(ROOT)/.trinity/state/queen_delegation.json')); \
	    t=d if isinstance(d,list) else d.get('tasks',d); \
	    t=list(t.values()) if isinstance(t,dict) else t; \
	    print(sum(1 for x in t if x.get('state')=='running'))" 2>/dev/null || echo 0); \
	if [ "$$running" != "0" ] && [ -z "$(FORCE)" ]; then \
		echo "[HOLD] $$running worker(s) are mid-flight; relaunching would orphan them."; \
		echo "       Wait, or override with: make relaunch FORCE=1"; \
		exit 1; \
	fi; \
	pkill -f "BrowserOS/trios/trios.app" 2>/dev/null || true; \
	sleep 2; \
	open "$(ROOT)/trios.app"; \
	echo "[OK] relaunched (workers in flight at the time: $$running)"

# Fail if any view sets a font size directly instead of through TriosType.
#
# The app had 618 hard-coded sizes and 317 of them were 10pt or smaller, down
# to 8pt monospaced, because nothing held a floor and every view picked its own
# number. They are all routed through `TriosType.font` now, which raises
# anything below 11pt and applies the operator's scale. This gate is what stops
# the drift from starting again: one new `.system(size: 9)` is invisible in
# review and indistinguishable from the other 617 once it lands.
#
# TriosTheme.swift is exempt because that is where the real call lives.
type-floor:
	@offenders=$$(grep -rn '\.system(size: [0-9]' \
		--include='*.swift' "$(ROOT)/BR-OUTPUT" "$(ROOT)/rings" 2>/dev/null \
		| grep -v 'BR-OUTPUT/TriosTheme.swift' || true); \
	if [ -n "$$offenders" ]; then \
		echo "[FAIL] font sizes set outside TriosType (no legibility floor applies):"; \
		echo "$$offenders" | head -20 | sed 's/^/  /'; \
		echo "       use TriosType.font(<size>, weight:, design:) instead"; \
		exit 1; \
	fi; \
	floor=$$(grep -c 'legibilityFloor: CGFloat = 11' "$(ROOT)/BR-OUTPUT/TriosTheme.swift"); \
	if [ "$$floor" != "1" ]; then \
		echo "[FAIL] TriosType.legibilityFloor is no longer 11pt"; \
		exit 1; \
	fi; \
	echo "[OK] every font size goes through TriosType, floor is 11pt"

make-dollars:
	@af=$$(mktemp /tmp/trios_md.XXXXXX); \
	printf '%s\n' \
		'BEGIN{n=split(allowed,a,/[ \t]+/);for(i=1;i<=n;i++)if(a[i]!="")vars[a[i]]=1}' \
		'!/^\t/&&!/^#/&&/:/&&!/:=/{target=$$0;sub(/:.*/,"",target);gsub(/[ \t]+$$/,"",target)}' \
		'/^\t/{s=$$0;while(s~/\$$\$$/)sub(/\$$\$$/,"",s);for(v in vars){gsub("\\$$\\("v"\\)","",s);gsub("\\$$\\{"v"\\}","",s)}if(s~/\$$[A-Za-z0-9_(]/)printf "  %s: line %d\n",target,NR}' \
	> $$af; \
	violations=$$(awk -v allowed='$(MAKE_DOLLAR_VARS)' -f $$af "$(ROOT)/Makefile"); \
	rm -f $$af; \
	if [ -n "$$violations" ]; then \
		echo "[FAIL] single-dollar shell variables in Makefile recipes:"; \
		echo "$$violations"; \
		exit 1; \
	else \
		echo "[OK] no single-dollar shell variables in recipes"; \
	fi

# --- Empty-source guard ------------------------------------------------
#
# Mid-run on #1238, rings/SR-00/QueenObserver.swift turned up at zero bytes
# with no known cause; the build died on "cannot find QueenObserver in scope"
# while the worker boundary was the Makefile.  Until the cause is found, make
# the loss loud: any tracked Swift file under rings/ or BR-OUTPUT/ that is
# zero bytes fails the build by name.
.PHONY: empty-sources
empty-sources:
	@empty=$$(git -C "$(ROOT)" ls-files -- 'rings/' 'BR-OUTPUT/' \
		| grep '\.swift$$' \
		| while IFS= read -r f; do \
			[ ! -s "$(ROOT)/$$f" ] && echo "$$f"; \
		done); \
	if [ -n "$$empty" ]; then \
		echo "[FAIL] zero-byte Swift source files:"; \
		echo "$$empty" | sed 's/^/  /'; \
		exit 1; \
	else \
		echo "[OK] no empty Swift source files under rings or BR-OUTPUT"; \
	fi

# --- Watch for empty sources --------------------------------------------
#
# Samples the byte size of every tracked Swift file under rings/ and BR-OUTPUT/
# once a second.  When a file drops to zero, prints the timestamp, the path,
# the previous size, and processes holding the file or repository open (lsof).
# Read-only: never writes to the tree, so Ctrl+C leaves nothing behind.
.PHONY: watch-empties
watch-empties:
	@files=$$(git -C "$(ROOT)" ls-files -- 'rings/' 'BR-OUTPUT/' \
		| grep '\.swift$$'); \
	i=0; \
	while IFS= read -r f; do \
		names[$$i]=$$f; \
		i=$$((i+1)); \
	done <<< "$$files"; \
	count=$$i; \
	while true; do \
		for ((i=0; i<$$count; i++)); do \
			now=$$(stat -f%z "$(ROOT)/$${names[$$i]}" 2>/dev/null || echo 0); \
			if [ -n "$${sizes[$$i]}" ] && [ "$$now" = "0" ] \
			   && [ "$${sizes[$$i]}" != "0" ]; then \
				procs=$$( lsof "$(ROOT)/$${names[$$i]}" "$(ROOT)" 2>/dev/null | awk 'NR>1{print $$1}' | sort -u | tr '\n' ' ' ); \
				if [ -z "$$procs" ]; then \
					procs=$$( lsof -a -d cwd 2>/dev/null | grep -F "$(ROOT)/" | awk '{print $$1}' | sort -u | tr '\n' ' ' ); \
				fi; \
				echo "$$(date '+%Y-%m-%d %H:%M:%S') $${names[$$i]} was $${sizes[$$i]} bytes; processes: $$procs"; \
			fi; \
			sizes[$$i]=$$now; \
		done; \
		sleep 1; \
	done

# --- Finish-mark order guard ---------------------------------------------
#
# #1248 moved recordCompletedTurn into the onFinish callback synchronously,
# before the deferred Task.  If the call drifts back inside the Task block,
# the completed-turn count is invisible to reapStalledWorkers until the
# async work finishes — the race #1248 fixed.  This check asserts the
# ordering holds and proves it can fail by running the same logic against
# a fixture where the call is in the wrong place.
.PHONY: finish-mark-order
finish-mark-order:
	@fail=0; \
	if awk '/runner\.onFinish[[:space:]]*=/{f=1} f&&/recordCompletedTurn/{rc=NR} f&&/Task[[:space:]]*\{/{tk=NR;f=0} END{exit !(rc>0&&tk>0&&rc<tk)}' "$(ROOT)/rings/SR-02/ChatViewModel.swift"; then \
		echo "  ok   - real source: recordCompletedTurn precedes Task in onFinish"; \
	else \
		echo "  FAIL - real source: recordCompletedTurn does not precede Task in onFinish"; \
		fail=1; \
	fi; \
	if [ ! -f "$(ROOT)/tests/fixtures/finish-mark-wrong.swift" ]; then \
		echo "  FAIL - missing fixture: $(ROOT)/tests/fixtures/finish-mark-wrong.swift"; \
		fail=1; \
	elif awk '/runner\.onFinish[[:space:]]*=/{f=1} f&&/recordCompletedTurn/{rc=NR} f&&/Task[[:space:]]*\{/{tk=NR;f=0} END{exit !(rc>0&&tk>0&&rc<tk)}' "$(ROOT)/tests/fixtures/finish-mark-wrong.swift"; then \
		echo "  FAIL - bad fixture passed (the check cannot detect the regression)"; \
		fail=1; \
	else \
		echo "  ok   - bad fixture correctly rejected"; \
	fi; \
	: "The bracketed summary is the verdict a machine reads: mutants-guard \
	   scores a row on positive evidence, not on the exit status alone, \
	   because a target that dies before it checks anything also exits \
	   non-zero.  Both lines, or this target cannot be an oracle."; \
	if [ $$fail -ne 0 ]; then \
		echo "[FAIL] the finish-mark order is broken"; \
		exit 1; \
	fi; \
	echo "[OK] the completed-turn mark precedes the deferred Task in onFinish"

# --- Load-bearing guard shapes -----------------------------------------
#
# Tonight `if ProjectPaths.isDevVariant {` and its closing brace vanished
# from ChatViewModel.swift around the Queen inbox poller.  Nothing failed:
# the body of an `if` is perfectly legal code on its own, so the build was
# green with zero warnings and the release app would have started reading
# the dev inbox.  A compiler cannot see a missing guard; only something
# that greps for the guard's shape can.
#
# GUARDS is that list.  One row per guard, fields separated by `@@`, rows
# by `~`:
#
#   source@@anchor@@needle@@window@@fixture@@consequence
#
# The check finds the first line containing `anchor` and looks up to
# `window` lines above it for `needle`.  Both arms run on every invocation:
# the real source must be GUARDED, and the deliberately broken fixture must
# come back UNGUARDED -- not merely "fail".  A fixture that lost its anchor
# would fail for the wrong reason and the negative arm would pass while
# proving nothing, so NOANCHOR is reported separately from UNGUARDED.
#
# It also refuses to pass quietly when it has stopped being a check: an
# empty table, a row that does not have six fields, a window outside
# 1..40 (a wide enough window matches anything), a missing fixture, and a
# fixture in tests/fixtures/guards/ that no row refers to are all failures.
#
# What this cannot do: a grep sees shape, not meaning.  A guard inverted to
# `if !ProjectPaths.isDevVariant {`, or moved to wrap the wrong statement,
# still contains the needle and still passes.  This catches deletion, which
# is the failure that actually happened.
#
# Guard 1 is also asserted from Swift, in ChatSSEEndToEndTest.swift's
# runInboxPollerIsDevVariantOnly, with a 5-line window against the 8 here.
# The two are deliberate redundancy at different prices -- that one needs
# the whole SSE harness, this one costs 0.1s and still runs when the
# harness cannot -- so the differing windows are not a bug in either.
#
# One row per guard, not one row per file.  ChatViewModel.swift carries
# three dev-variant guards -- the poller startup site, the read inside
# pollQueenInbox, and the write inside enqueueQueenInboxEntry -- and rows
# 1-3 anchor on each one separately.  Anchoring all three on the startup
# site would leave the other two, 80-200 lines away, deletable in silence:
# an anchor only proves the guard sitting within `window` lines above it.
# Only row 1 has a Swift counterpart; rows 2 and 3 live here alone.
#
# Do not put a `#` in the table: inside a Make variable it starts a
# comment and would silently truncate the row.
GUARDS := \
	rings/SR-02/ChatViewModel.swift@@queenInboxPollTask = Task@@if ProjectPaths.hasSupervisorInbox {@@8@@guards/inbox-poller-unguarded.swift@@a release build polls the dev Queen inbox (1150)~ \
	rings/SR-02/ChatViewModel.swift@@let path = Self.queenInboxPath@@guard ProjectPaths.hasSupervisorInbox else { return }@@3@@guards/inbox-read-unguarded.swift@@a release build reads the dev Queen inbox from any caller (1090)~ \
	rings/SR-02/ChatViewModel.swift@@let entry = QueenInboxEntry(@@guard ProjectPaths.hasSupervisorInbox else {@@10@@guards/inbox-enqueue-unguarded.swift@@a release build queues delegations into the dev Queen inbox (1090)~ \
	rings/SR-00/KeychainSecrets.swift@@DevSecretStore.read(service: service, account: account)@@if ProjectPaths.usesFileSecretStore {@@4@@guards/dev-secret-store-unguarded.swift@@a release build reads secrets from the plaintext dev store~ \
	rings/SR-00/TriOSEncryption.swift@@return try loadOrCreateTestKey()@@if ProcessInfo.processInfo.environment["TRIOS_E2E_DISABLE_KEYCHAIN"] == "1" {@@4@@guards/test-key-unguarded.swift@@every build derives its data key from a volatile test file~ \
	rings/SR-02/ChatViewModel.swift@@if connectivityFailedTasks.contains(task.id), let runner = workerRunner {@@guard !QueenDelegationPolicy.isStreamAlive(current, now: now) else { continue }@@8@@guards/reaper-unguarded.swift@@the reaper stops consulting the liveness predicate and either takes live workers mid-answer or never takes a mute one~ \
	main.swift@@NSApplication.shared.run()@@guard RecursionGuard.shared.ensureSingleInstance() else {@@12@@guards/single-instance-unguarded.swift@@a second trios instance starts alongside the first~

.PHONY: guard-shapes
guard-shapes:
	@fail=0; n=0; total=0; seen=""; \
	af=$$(mktemp /tmp/trios_gs.XXXXXX); \
	trap 'rm -f $$af' EXIT INT TERM; \
	printf '%s\n' \
		'{ L[NR] = $$0 }' \
		'a == 0 && index($$0, anchor) { a = NR }' \
		'END {' \
		'  if (a == 0) { print "NOANCHOR"; exit 3 }' \
		'  for (i = a - 1; i >= a - win && i >= 1; i--)' \
		'    if (index(L[i], needle)) { print "GUARDED"; exit 0 }' \
		'  print "UNGUARDED"; exit 4' \
		'}' \
	> $$af; \
	while IFS= read -r raw; do \
		entry=$$(printf '%s' "$$raw" | sed 's/^[[:space:]]*//; s/[[:space:]]*$$//'); \
		[ -n "$$entry" ] || continue; \
		total=$$((total + 1)); \
		src=$${entry%%@@*};      rest=$${entry#*@@}; \
		anchor=$${rest%%@@*};    rest=$${rest#*@@}; \
		needle=$${rest%%@@*};    rest=$${rest#*@@}; \
		win=$${rest%%@@*};       rest=$${rest#*@@}; \
		fixture=$${rest%%@@*};   label=$${rest#*@@}; \
		fields=$$(printf '%s' "$$entry" | awk -F'@@' '{print NF}'); \
		if [ "$$fields" != "6" ]; then \
			echo "  FAIL - malformed guard row ($$fields fields, want 6): $$entry"; fail=1; continue; \
		fi; \
		case "$$win" in \
		''|*[!0-9]*) echo "  FAIL - window is not a number in row for $$src: '$$win'"; fail=1; continue ;; \
		esac; \
		if [ "$$win" -lt 1 ] || [ "$$win" -gt 40 ]; then \
			echo "  FAIL - window $$win out of range 1..40 for $$src; a wide window makes the check vacuous"; fail=1; continue; \
		fi; \
		n=$$((n + 1)); seen="$$seen $$fixture"; \
		if [ ! -f "$(ROOT)/$$src" ]; then \
			echo "  FAIL - missing source: $$src"; fail=1; continue; \
		fi; \
		v=$$(awk -v anchor="$$anchor" -v needle="$$needle" -v win="$$win" -f $$af "$(ROOT)/$$src"); \
		case "$$v" in \
		GUARDED) echo "  ok   - $$src: guard holds above '$$anchor'" ;; \
		NOANCHOR) echo "  FAIL - $$src: anchor '$$anchor' is gone; the guard table is stale"; fail=1 ;; \
		*) echo "  FAIL - $$src: no '$$needle' within $$win lines above '$$anchor' -> $$label"; fail=1 ;; \
		esac; \
		if [ ! -f "$(ROOT)/tests/fixtures/$$fixture" ]; then \
			echo "  FAIL - missing fixture: tests/fixtures/$$fixture"; fail=1; continue; \
		fi; \
		fv=$$(awk -v anchor="$$anchor" -v needle="$$needle" -v win="$$win" -f $$af "$(ROOT)/tests/fixtures/$$fixture"); \
		case "$$fv" in \
		UNGUARDED) echo "  ok   - fixture $$fixture correctly rejected" ;; \
		NOANCHOR) echo "  FAIL - fixture $$fixture has no '$$anchor'; it fails for the wrong reason"; fail=1 ;; \
		*) echo "  FAIL - fixture $$fixture passed; the check can no longer see this regression"; fail=1 ;; \
		esac; \
	done < <(printf '%s\n' '$(GUARDS)' | tr '~' '\n'); \
	if [ $$total -eq 0 ]; then \
		echo "[FAIL] the guard table is empty; this target would pass by doing nothing"; \
		exit 1; \
	fi; \
	for f in "$(ROOT)"/tests/fixtures/guards/*.swift; do \
		[ -e "$$f" ] || continue; \
		base="guards/$$(basename "$$f")"; \
		case " $$seen " in \
		*" $$base "*) ;; \
		*) echo "  FAIL - orphan fixture $$base: no row in GUARDS refers to it"; fail=1 ;; \
		esac; \
	done; \
	if [ $$fail -eq 0 ]; then \
		echo "[OK] $$n load-bearing guards present, $$n broken fixtures rejected"; \
	else \
		echo "[FAIL] a load-bearing guard is gone, or a broken fixture stopped being rejected"; \
		exit 1; \
	fi

# --- Variant type fence --------------------------------------------------
#
# Subject: the build variant is a TYPE, not a string.  Every check above this
# one reads text; this one asks the compiler a question no text reader can
# answer, and it is the first target in this Makefile whose subject lives in
# the type system.
#
# What forks on the variant.  `.trinity` vs `.trinity-dev` (the running app's
# encrypted memory, its delegation store, and safety_budget.json - the value
# cron-life.md treats as the halt switch), Keychain vs DevSecretStore, 9105 vs
# 9205, the bundle id, the binary name, the Frameworks directory.  All six live
# in ONE place, `BuildVariant` in rings/SR-00/BuildVariantPolicy.swift, and are
# reached by asking a value of that type.  ProjectPaths.swift says so out loud:
# "Those constants used to be written a third time in this file, beside the
# copies in build.sh and in BuildVariant; only the copy nobody called was under
# test."
#
# What makes that a single symbol rather than a house style is a type-level
# fact: there is no path from a raw String to a BuildVariant except the
# failable `init?(rawValue:)`, so a literal cannot be written where the variant
# belongs.  That is the fence, and only a compiler can decide whether it is
# still standing.
#
# It is not hypothetical that people write the literal instead.
# tools/ChatProbe.swift:30 is `let isDev = variant == "dev"` against its own
# String copy, while BR-OUTPUT/ProjectPaths.swift:128 is `variant == .dev`.
# The probe is outside the app module so nothing stops it; this target is what
# stops the same line landing INSIDE the module.  A string comparison has no
# wrong answers, only false ones - `== "Dev"` is merely false - and a dev build
# that quietly reports itself as release writes into the state of the app the
# user is running, which is the one outcome the two-variant split exists to
# prevent.
#
# Two arms, and the second is why the first can be believed:
#
#   positive.swift    compiled WITH the two real sources; must typecheck.  It
#                     names each symbol at the type the fence depends on, so
#                     the cheapest way to satisfy every negative at once -
#                     delete the enum, rename ProjectPaths.variant, change
#                     areFullyIsolated's arity - is a failing check and not a
#                     passing one.
#   neg-*.swift       each compiled WITH the two real sources and ALONE; each
#                     must NOT typecheck, AND swiftc must say the sentence the
#                     witness declares in its `// EXPECT:` line.  Without that
#                     second half a witness broken into "cannot find
#                     ProjectPathz in scope" would score as the fence holding,
#                     which is this repo's recurring forgery: the right verdict
#                     for the wrong reason.
#
# One negative per file, deliberately.  A compile fails as a whole, so two
# negatives sharing a file would still fail with one of them silently
# compiling - the fence half gone and the target green.
#
# Driven rather than argued.  Adding `ExpressibleByStringLiteral` to
# BuildVariant - one legal, compiling conformance - flips all three negatives
# to TYPECHECKS while the positive stays green, so every raw-string fork in the
# tree re-opens at once.  No grep in this file can see that, and the mutation
# row below scores it.
#
# What it does NOT see, named rather than left to be discovered: the fence
# stops a raw string being READ as a variant.  It does nothing about `.trinity`
# being spelled out DOWNSTREAM of one - `"\(projectRoot)/.trinity/..."` is a
# String either way, and rings/SR-02/QueenSelfImprovementService.swift and
# BR-OUTPUT/QueenStatusViewModel.swift do exactly that today.  That is a real
# defect and it is a different instrument's job; claiming it here would be the
# same over-reach this target exists to avoid.
#
# Cost, driven on this machine: four `swiftc -typecheck` runs - the two real
# sources plus one witness each - 1.67s on the first run and 1.44 / 1.46 /
# 1.48s on the three after it.  It needs no dev build, no output-file map and
# no incremental state (the two sources typecheck standalone in 0.68s cold), so
# unlike the type floor in `mutants-guard` it can sit in `check`, and it does.
VARIANT_FENCE_SRC := $(ROOT)/BR-OUTPUT/ProjectPaths.swift $(ROOT)/rings/SR-00/BuildVariantPolicy.swift
VARIANT_FENCE_DIR := $(ROOT)/tests/fixtures/guards/variant-fence

.PHONY: variant-fence
variant-fence:
	@fail=0; n=0; \
	pos="$(VARIANT_FENCE_DIR)/positive.swift"; \
	if [ ! -f "$$pos" ]; then \
		echo "[FAIL] the positive witness is missing: $$pos"; \
		echo "       without it every negative arm below can be satisfied by the"; \
		echo "       symbols not existing, which is not the fence holding"; \
		exit 1; \
	fi; \
	if out=$$(swiftc -typecheck $(VARIANT_FENCE_SRC) "$$pos" 2>&1); then \
		echo "  ok   - the variant vocabulary and its positive witness typecheck"; \
	else \
		echo "  FAIL - the variant vocabulary does not typecheck with its witness"; \
		echo "$$out" | grep 'error:' | head -5 | sed 's/^/         | /'; \
		fail=1; \
	fi; \
	for neg in "$(VARIANT_FENCE_DIR)"/neg-*.swift; do \
		[ -e "$$neg" ] || continue; \
		n=$$((n + 1)); \
		base=$$(basename "$$neg"); \
		want=$$(sed -n 's|^// EXPECT: ||p' "$$neg" | head -1); \
		if [ -z "$$want" ]; then \
			echo "  FAIL - $$base carries no '// EXPECT:' line; a compile that fails"; \
			echo "         for an unnamed reason is not evidence of this fence"; \
			fail=1; continue; \
		fi; \
		if out=$$(swiftc -typecheck $(VARIANT_FENCE_SRC) "$$neg" 2>&1); then \
			echo "  FAIL - $$base TYPECHECKS: a raw string is accepted where a"; \
			echo "         BuildVariant belongs, so the fence is gone"; \
			fail=1; \
		elif echo "$$out" | grep -F "$$neg:" | grep -qF "$$want"; then \
			echo "  ok   - $$base refused: $$want"; \
		else \
			echo "  FAIL - $$base was refused for the WRONG reason; swiftc never said"; \
			echo "         this ABOUT $$base:"; \
			echo "         $$want"; \
			echo "$$out" | grep 'error:' | head -3 | sed 's/^/         | /'; \
			fail=1; \
		fi; \
	done; \
	if [ $$n -eq 0 ]; then \
		echo "[FAIL] no neg-*.swift in $(VARIANT_FENCE_DIR); this target would pass"; \
		echo "       by asserting nothing about the fence"; \
		exit 1; \
	fi; \
	if [ $$fail -eq 0 ]; then \
		echo "[OK] the build variant is a type: $$n raw-string substitutions refused by the compiler"; \
	else \
		echo "[FAIL] a raw string can stand in for a BuildVariant, or the variant"; \
		echo "       vocabulary no longer typechecks. .trinity vs .trinity-dev,"; \
		echo "       Keychain vs DevSecretStore and 9105 vs 9205 fork on this value."; \
		exit 1; \
	fi

# --- Parse-every-test-source guard --------------------------------------
#
# A green build proves the app compiled, not that every test source is
# syntactically valid.  A broken func header or an unbalanced brace in a
# test file that clade-e2e happened not to compile this run sits unnoticed
# until the next time that suite runs — which may be never, if the build
# appeared green.  This check runs `swiftc -parse` (syntax only, no type
# resolution) on every Swift file under tests/swift/ so a syntax error is
# caught and named before it hides behind a suite that did not run.
#
# Two arms, proven by a fixture:
#
#   1. Positive — every file under tests/swift/ must parse.  A real source
#      with a syntax error is a FAIL.
#
#   2. Negative — tests/fixtures/parse-fixture.swift must NOT parse.  It is
#      deliberately broken (missing func keyword).  If it ever parses, the
#      check FAILS: the sentinel has been fixed, and the target can no
#      longer prove it catches broken sources.
#
# If the fixture goes missing the check fails rather than silently passing
# with one fewer file to check.
.PHONY: parse-tests
parse-tests:
	@fail=0; \
	if [ ! -f "$(ROOT)/tests/fixtures/parse-fixture.swift" ]; then \
		echo "[FAIL] missing fixture: $(ROOT)/tests/fixtures/parse-fixture.swift"; \
		exit 1; \
	fi; \
	for f in "$(ROOT)"/tests/swift/*.swift; do \
		if ! err=$$(swiftc -parse "$$f" 2>&1); then \
			echo "[FAIL] $$f does not parse:"; \
			echo "$$err" | grep 'error:' | head -5 | sed 's/^/  /'; \
			fail=1; \
		fi; \
	done; \
	if err=$$(swiftc -parse "$(ROOT)/tests/fixtures/parse-fixture.swift" 2>&1); then \
		echo "[FAIL] parse-fixture.swift parsed — expected it to be broken"; \
		fail=1; \
	else \
		echo "[OK] parse-fixture.swift correctly fails to parse"; \
	fi; \
	if [ $$fail -eq 0 ]; then \
		echo "[OK] every test source parses, broken fixture rejected"; \
	else \
		exit 1; \
	fi

# --- The vendoring step -------------------------------------------------
#
# TRIOS_VENDORED=1 is how trios builds on a machine with no neighbouring
# trinity checkout, and it works only because a NORMAL build leaves both
# halves of QueenUILib behind: the dylib the linker needs and the
# swiftmodule `import QueenUILib` needs.  Both copies live in build.sh
# between the `BEGIN vendor-halves` and `END vendor-halves` markers.
#
# Delete that region and nothing complains.  Driven, this machine: with the
# region cut out of build.sh a dev build printed "[OK] Build successful"
# and build.sh's own vendored-interface probe printed "[OK] Vendored
# QueenUILib resolves from .../Frameworks-dev/Modules (TRIOS_VENDORED=1 is
# buildable)", exit 0, while Frameworks-dev/Modules/QueenUILib.swiftmodule
# kept the timestamp an EARLIER build had given it.  The probe typechecks
# one `import QueenUILib` against that directory as it stands, so it was
# reading a leftover artifact and calling this build honest.  It cannot see
# the step that produces the artifact; only something that reads build.sh
# can.  make-dollars, empty-sources, finish-mark-order, guard-shapes,
# parse-tests and keychain-doors all passed over the same broken tree.
#
# Two arms, both run every time, in the shape finish-mark-order and
# parse-tests use:
#
#   1. Positive -- the live build.sh must carry the region, and each copy
#      in VENDOR_HALVES must appear INSIDE it.  A copy that drifted out of
#      the region is reported the same as a deleted one, because a copy
#      outside the markers is a copy the fixture cannot remove and this
#      check can no longer prove anything about.
#   2. Negative -- a fixture whose region body has been deleted, exactly
#      the adversarial edit above, must come back GONE.  Not merely "fail":
#      a fixture that had also lost the markers or the anchor would fail
#      for the wrong reason and the negative arm would pass while proving
#      nothing, so NOREGION and NOANCHOR are reported separately from GONE.
#
# The fixture is generated from the live build.sh instead of being checked
# in, and that is the one deliberate departure from the two targets above.
# A checked-in copy of a 900-line script goes stale on the first unrelated
# edit; a copy taken now and cut at the markers is the real file minus the
# real step.  Everything that could quietly stop it from being a fixture is
# a named failure: no file produced, nothing removed (which is what a
# build.sh with no markers left looks like), markers lost, anchor lost, or
# an empty table.
#
# What this cannot do: it reads shape, not meaning.  A copy still present
# but wrapped in `if false`, or pointed at the wrong directory, contains
# the needle and passes.  It catches deletion, which is the failure that
# happened.
#
# Wired into `dev`, not only `check`: a hard exit buried in build.sh is not
# a guard, and build.sh's exit status does not even reach `make dev` (the
# probe's `exit 1` fires after "Build successful", which is the line `dev`
# greps for).  As a prerequisite this refuses the build out loud instead.
VENDOR_SRC    := build.sh
VENDOR_BEGIN  := --- BEGIN vendor-halves ---
VENDOR_END    := --- END vendor-halves ---
# Sits immediately after the region and survives the fixture's cut, so the
# fixture can be told apart from a build.sh that lost the whole passage.
VENDOR_ANCHOR := rm -f "$$STANDALONE_FRAMEWORKS/$$SQLCIPHER_DYLIB_NAME"
# One row per vendored half: needle@@consequence, rows separated by `~`.
# Do not put a `#` in the table: inside a Make variable it starts a comment
# and would silently truncate the row.  Do not put a `'` in it either: the
# rows are fed to the loop inside a single-quoted printf, and one apostrophe
# splits a row in two -- which the malformed-row arm below does catch, but
# only after it has already thrown the row away.
VENDOR_HALVES := \
	cp "$$QUEEN_DYLIB" "$$STANDALONE_FRAMEWORKS/libQueenUILib.dylib"@@the linker half: a vendored build finds no libQueenUILib.dylib~ \
	"$$STANDALONE_FRAMEWORKS/Modules/$$queen_module_artifact"@@the compile-time half: every import QueenUILib fails with "no such module"

.PHONY: vendor-step
vendor-step:
	@fail=0; n=0; \
	src="$(ROOT)/$(VENDOR_SRC)"; \
	af=$$(mktemp /tmp/trios_vs.XXXXXX); \
	ff=$$(mktemp /tmp/trios_vs_cut.XXXXXX); \
	fx=$$(mktemp /tmp/trios_vs_fixture.XXXXXX); \
	trap 'rm -f $$af $$ff $$fx' EXIT INT TERM; \
	printf '%s\n' \
		'index($$0, b) { inr = 1; seen = 1; next }' \
		'index($$0, e) { inr = 0; next }' \
		'index($$0, a) { anchor = 1 }' \
		'inr && index($$0, needle) { hit = 1 }' \
		'END {' \
		'  if (!seen)   { print "NOREGION"; exit 3 }' \
		'  if (!anchor) { print "NOANCHOR"; exit 4 }' \
		'  if (!hit)    { print "GONE"; exit 5 }' \
		'  print "PRESENT"' \
		'}' \
	> $$af; \
	printf '%s\n' \
		'index($$0, b) { print; skip = 1; next }' \
		'index($$0, e) { skip = 0 }' \
		'!skip { print }' \
	> $$ff; \
	if [ ! -f "$$src" ]; then \
		echo "  FAIL - missing source: $(VENDOR_SRC)"; \
		exit 1; \
	fi; \
	awk -v b='$(VENDOR_BEGIN)' -v e='$(VENDOR_END)' -f $$ff "$$src" > $$fx; \
	if [ ! -s $$fx ]; then \
		echo "  FAIL - fixture generator produced nothing; there is no broken fixture to reject"; \
		exit 1; \
	fi; \
	if cmp -s "$$src" $$fx; then \
		echo "  FAIL - fixture generator removed nothing from $(VENDOR_SRC): the"; \
		echo "         '$(VENDOR_BEGIN)' markers are gone, so there is no fixture"; \
		echo "         and the positive arm below would be checking an unmarked file"; \
		exit 1; \
	fi; \
	while IFS= read -r raw; do \
		entry=$$(printf '%s' "$$raw" | sed 's/^[[:space:]]*//; s/[[:space:]]*$$//'); \
		[ -n "$$entry" ] || continue; \
		fields=$$(printf '%s' "$$entry" | awk -F'@@' '{print NF}'); \
		if [ "$$fields" != "2" ]; then \
			echo "  FAIL - malformed vendor row ($$fields fields, want 2): $$entry"; fail=1; continue; \
		fi; \
		needle=$${entry%%@@*}; label=$${entry#*@@}; \
		n=$$((n + 1)); \
		v=$$(awk -v b='$(VENDOR_BEGIN)' -v e='$(VENDOR_END)' -v a='$(VENDOR_ANCHOR)' \
			-v needle="$$needle" -f $$af "$$src"); \
		case "$$v" in \
		PRESENT) echo "  ok   - $(VENDOR_SRC): $$label -- copy still inside the vendor-halves region" ;; \
		NOREGION) echo "  FAIL - $(VENDOR_SRC): the vendor-halves markers are gone; nothing is being checked"; fail=1 ;; \
		NOANCHOR) echo "  FAIL - $(VENDOR_SRC): the anchor is gone; this check is stale"; fail=1 ;; \
		*) echo "  FAIL - $(VENDOR_SRC): vendoring step gone -> $$label"; fail=1 ;; \
		esac; \
		fv=$$(awk -v b='$(VENDOR_BEGIN)' -v e='$(VENDOR_END)' -v a='$(VENDOR_ANCHOR)' \
			-v needle="$$needle" -f $$af $$fx); \
		case "$$fv" in \
		GONE) echo "  ok   - cut fixture correctly rejected: $$label" ;; \
		NOREGION) echo "  FAIL - cut fixture lost the markers; it fails for the wrong reason"; fail=1 ;; \
		NOANCHOR) echo "  FAIL - cut fixture lost the anchor; it fails for the wrong reason"; fail=1 ;; \
		*) echo "  FAIL - cut fixture passed; this check cannot see the vendoring step disappear"; fail=1 ;; \
		esac; \
	done < <(printf '%s\n' '$(VENDOR_HALVES)' | tr '~' '\n'); \
	if [ $$n -eq 0 ]; then \
		echo "[FAIL] the vendor-halves table is empty; this target would pass by doing nothing"; \
		exit 1; \
	fi; \
	if [ $$fail -eq 0 ]; then \
		echo "[OK] $$n vendoring copies present in build.sh, $$n rejected in the cut fixture"; \
	else \
		echo "[FAIL] TRIOS_VENDORED=1 would build against whatever an earlier build left"; \
		echo "       in Frameworks-dev/Modules, and build.sh's own probe would not notice."; \
		exit 1; \
	fi

# Diagnostic aggregate (wave 088): the full check walk in one command,
# under the lock-phase bypass. It exists because every step is green in
# its own run but no single invocation has ever walked them all - the
# lock anomaly (owner root-heals) makes plain `check` stop at cassettes.
# TRIOS_SKIP_LOCK rides the whole child environment, so the cassettes
# step inherits it without hand-typing. Never wire this into CI: the
# prohibition travels with the name.
check-bypass:
	@echo "[check-bypass] diagnostic full walk: lock phase jumped (owner root-heals; never for CI)"
	@TRIOS_SKIP_LOCK=1 $(MAKE) --no-print-directory check

check: check-selftest keychain-doors type-floor t27-rings t27-lowering chain make-dollars empty-sources sources-drift sources-drift-selftest finish-mark-order guard-shapes variant-fence parse-tests run-completeness-selftest cassette-isolation vendor-step dev warnings test cassettes mutants-changed

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

# The cassette recipe must never name the Queen's variant.
#
# The isolation above is one `sed` away from being undone, and the failure is
# silent: the suite still passes, and a live delegation registry disappears.
# That is exactly how it happened - `rm -f .trinity-dev/state/queen_delegation
# .json` sat in the recipe as a deliberate, commented, correct-looking line for
# months, because when it was written nothing lived there.
#
# Scoped to the recipe, not the file: DEV_APP and .trinity-dev are legitimate
# everywhere else in this Makefile.
.PHONY: cassette-isolation
cassette-isolation:
	@body=$$(awk '/^cassettes: /,/^# --- Running/' "$(ROOT)/Makefile"); \
	if [ -z "$$body" ]; then \
		echo "[FAIL] cassette-isolation could not find the cassettes recipe to read"; \
		exit 1; \
	fi; \
	fail=0; \
	for needle in 'trios-dev' '.trinity-dev' 'DEV_APP' 'DEV_PROC' '$$(LOG)'; do \
		if printf '%s\n' "$$body" | /usr/bin/grep -qF -- "$$needle"; then \
			echo "  [FAIL] the cassette recipe names '$$needle'"; \
			echo "         The harness runs as the test variant precisely so it can"; \
			echo "         kill and wipe freely. Reaching into dev destroys the"; \
			echo "         Queen's live delegation registry (#1275 follow-up)."; \
			fail=1; \
		fi; \
	done; \
	if ! printf '%s\n' "$$body" | /usr/bin/grep -qF -- 'trios-test'; then \
		echo "  [FAIL] the cassette recipe names no test variant at all -"; \
		echo "         a rename would satisfy every check above by accident."; \
		fail=1; \
	fi; \
	if [ $$fail -eq 0 ]; then \
		echo "[OK] the cassette recipe stays inside the test variant"; \
	fi; \
	exit $$fail

# The harness bundle the cassette suite drives.
#
# TRIOS_SKIP_SWIFT_TEST / TRIOS_SKIP_CHAT_E2E: build.sh runs both suites at the
# end of a build, and this bundle exists only to be launched four times with a
# recorded stream. Running the test suites here would make `make cassettes`
# depend on them, so a failure in either would be reported as a cassette
# failure - the wrong name for the wrong layer.
.PHONY: test-app
test-app:
	@TRIOS_VARIANT=test TRIOS_SKIP_SWIFT_TEST=1 TRIOS_SKIP_CHAT_E2E=1 \
		"$(ROOT)/build.sh" > /tmp/trios_test_app_build.log 2>&1 || { \
			echo "[FAIL] the harness bundle did not build"; \
			tail -15 /tmp/trios_test_app_build.log | sed 's/^/  | /'; \
			exit 1; \
		}
	@test -x "$(TEST_BIN)" || { echo "[FAIL] $(TEST_BIN) is missing after a build that claimed success"; exit 1; }
	@echo "[OK] harness bundle built: $(TEST_APP)"

# Wave 075 note: neither `SHELLFLAGS=-x` nor `.SHELLFLAGS=-x` traces this
# Makefile's recipes (measured on both a simple target and cassettes - zero
# trace lines either way). The working alternative for the next attempt is
# a literal `set -x;` at the head of the recipe line itself - a bash
# mechanism, independent of make's flag plumbing.
# Diagnostic alias (wave 086): the named, self-announcing way to run the
# cassette suite around the lock-phase anomaly while the owner root-heals
# the interceptor. It exists so nobody types TRIOS_SKIP_LOCK=1 by hand and
# forgets the CI prohibition - the name says what it is, the echo says
# what engaged, and `check` never calls it.
cassettes-bypass:
	@echo "[cassettes-bypass] diagnostic run: lock phase jumped (owner root-heals the interceptor; never wire into check)"
	@TRIOS_SKIP_LOCK=1 $(MAKE) --no-print-directory cassettes

cassettes: test-app
	@: "Serialised against every other harness run in this checkout."; \
	: "Several agents share this tree and each runs `make check`. Two"; \
	: "cassette runs drive the SAME trios-test.app and each ends every"; \
	: "cassette with pkill on that bundle path, so they terminate each"; \
	: "other's replay. Measured 2026-08-23: a run died with"; \
	: "'make: *** [cassettes] Terminated: 15' while a second run was 40"; \
	: "seconds into its own cassettes step. Nothing was broken; the two"; \
	: "runs were killing each other, and the signal reads like a crash."; \
	: "Waits rather than refusing. Both runs are legitimate and neither"; \
	: "agent knows about the other, so failing the second one turns a"; \
	: "scheduling collision into a red gate somebody has to investigate."; \
	: "This line's own watchdog. The budget watchdog below lives in the"; \
	: "replay line, which this line never reaches when it wedges -"; \
	: "measured 2026-08-24: a wedged lock-line carried no sleep child at"; \
	: "all and sat forever holding nothing, while every other agent"; \
	: "queued behind it. Same budget, same form, started at entry to the"; \
	: "lock phase, killed when the line completes normally below."; \
	( sleep $(CASSETTE_TOTAL_BUDGET) && { \
		echo "[LOCK-WATCHDOG] lock-phase budget spent - tree before TERM:"; \
		ps -o pid,ppid,etime,command -p $$$$ 2>/dev/null | tail -1; \
		for c in $$(pgrep -P $$$$ 2>/dev/null); do \
			ps -o pid,ppid,etime,command -p $$c 2>/dev/null | tail -1; \
			for g in $$(pgrep -P $$c 2>/dev/null); do \
				ps -o pid,ppid,etime,command -p $$g 2>/dev/null | tail -1; \
			done; \
		done; \
		kill -TERM $$$$; \
	} ) & lwpid=$$!; \
	trap 'kill $$lwpid 2>/dev/null' EXIT; \
	trap 'kill $$lwpid 2>/dev/null; exit 124' TERM INT; \
	waited=0; \
	echo "[SKIP-LOCK probe] seen=$${TRIOS_SKIP_LOCK:-}"; \
	if [ -n "$${TRIOS_SKIP_LOCK:-}" ]; then \
		echo "[SKIP-LOCK ON] branch engaged, jumping the acquire dance"; \
		: "Diagnostic bypass (wave 083): the lock phase is where the"; \
		: "system-layer exec anomaly lives - measured waves 069-082,"; \
		: "every run wedges here with the lock free. TRIOS_SKIP_LOCK"; \
		: "jumps the acquire dance so replays can run while the owner"; \
		: "root-diagnoses the interceptor. Never set in CI: two runs"; \
		: "would drive the same test bundle into each other."; \
		kill $$lwpid 2>/dev/null || true; \
	else \
	while :; do \
		owner_pid=$$(cat "$(HARNESS_LOCK)/pid" 2>/dev/null || true); \
		if mkdir "$(HARNESS_LOCK)" 2>/dev/null; then break; fi; \
		if [ -n "$$owner_pid" ] && ! kill -0 $$owner_pid 2>/dev/null; then \
			echo "[INFO] reclaiming harness lock from dead PID $$owner_pid"; \
			rm -rf "$(HARNESS_LOCK)"; continue; \
		fi; \
		if [ $$waited -ge $(HARNESS_LOCK_WAIT) ]; then \
			echo "[FAIL] another harness run has held $(HARNESS_LOCK) for $(HARNESS_LOCK_WAIT)s"; \
			echo "       (owner PID $$owner_pid). Not waiting further."; \
			exit 1; \
		fi; \
		if [ $$waited = 0 ]; then \
			echo "[cassettes] another harness run holds the lock (PID $$owner_pid); waiting"; \
		fi; \
		sleep 5; waited=$$((waited + 5)); \
	done; \
	: "PPID, not $$$$. Every line of a make recipe is its own shell, so"; \
	: "this shell's PID is dead a moment after it is written and the next"; \
	: "run would reclaim the lock as abandoned while the target still"; \
	: "holds it. PPID is make itself, which lives for the whole target -"; \
	: "so a run killed mid-cassette still leaves a PID that is genuinely"; \
	: "dead, and the reclaim above is honest rather than a formality."; \
		echo $$PPID > "$(HARNESS_LOCK)/pid"; \
		[ $$waited -gt 0 ] && echo "[cassettes] acquired the harness lock after $${waited}s" || true; \
		kill $$lwpid 2>/dev/null || true; \
	fi
	@pkill -f "$(TEST_PROC_HERE)" 2>/dev/null || true
	@sleep 2
	@: "A branch that looks like a delegation's real work, planted so the sweep \
	    below has something it must NOT delete. Widening CASSETTE_BRANCHES back \
	    to queen/* now fails the suite instead of quietly eating a branch."; \
	git -C "$(ROOT)" branch --force $(SWEEP_CANARY) HEAD >/dev/null 2>&1
	@fail=0; covered=""; \
	( sleep $(CASSETTE_TOTAL_BUDGET) && { \
		echo "[WATCHDOG] cassette budget spent - process tree before TERM:"; \
		ps -o pid,ppid,etime,command -p $$$$ 2>/dev/null | tail -1; \
		for c in $$(pgrep -P $$$$ 2>/dev/null); do \
			ps -o pid,ppid,etime,command -p $$c 2>/dev/null | tail -1; \
			for g in $$(pgrep -P $$c 2>/dev/null); do \
				ps -o pid,ppid,etime,command -p $$g 2>/dev/null | tail -1; \
			done; \
		done; \
		kill -TERM $$$$; \
	} ) & wpid=$$!; \
	trap 'kill $$wpid 2>/dev/null' EXIT; \
	trap 'kill $$wpid 2>/dev/null; exit 124' TERM INT; \
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
		before=$$(wc -l < "$(TEST_LOG)" 2>/dev/null || echo 0); \
		: "Everything the harness variant remembers between runs, cleared."; \
		: "The delegation store, the inbox file, and - the one that is not a"; \
		: "file - the inbox offset and executed-fingerprint sets, which live"; \
		: "in UserDefaults under the test bundle id. Without that last one"; \
		: "the second run of any cassette is answered with"; \
		: "queen.inbox.skipped - Line already executed, and the suite reads"; \
		: "as a marker that never appeared. Safe to wipe wholesale: nothing"; \
		: "but this harness writes to com.browseros.trios.test."; \
		rm -f "$(ROOT)/.trinity-test/state/queen_delegation.json"; \
		rm -f "$(ROOT)/.trinity-test/state/queen_inbox.jsonl"; \
		defaults delete com.browseros.trios.test >/dev/null 2>&1 || true; \
		: "The harness dispatches real delegations, so it makes real"; \
		: "worktrees. Cleared under .worktrees/test only - the working"; \
		: "Queen's checkouts live under .worktrees/dev and a branch checked"; \
		: "out in one of those cannot be deleted by the sweep below, which"; \
		: "is how this surfaced. Removing them is not an option: they hold"; \
		: "live work."; \
		for wt in "$(ROOT)/.worktrees/test"/queen-*; do \
			[ -d "$$wt" ] || continue; \
			git -C "$(ROOT)" worktree remove --force "$$wt" >/dev/null 2>&1 || true; \
		done; \
		git -C "$(ROOT)" worktree prune >/dev/null 2>&1 || true; \
		: "A cassette effect writes a file; if it survives from the last run the \
		   baseline diff is empty and the commit assertion fails for the wrong \
		   reason. Clean before, not only after."; \
		rm -f "$(ROOT)/docs/replay.md"; \
		git -C "$(ROOT)" branch --list '$(CASSETTE_BRANCHES)' --format='%(refname:short)' \
			| xargs -r -n1 git -C "$(ROOT)" branch -D >/dev/null 2>&1 || true; \
		: "NOT trios\#1086. Make strips a backslash-hash in a VARIABLE \
		   ASSIGNMENT (see ISSUE below, which is correct) and does NOT strip \
		   it in a RECIPE, where a plain # needs no escape at all inside \
		   double quotes. So this line shipped a literal backslash into the \
		   app: IssueReference took the repo as 'trios\', every GitHub URL \
		   became /repos/gHashTag/trios%5C/issues/1086, the issue body could \
		   not be read, the worker got no boundary, and every file it wrote \
		   was dropped as outside-boundary. That is the whole cassette \
		   failure, and it read as 'the worker changed no files'."; \
		open --env TRIOS_E2E_DELEGATE="gHashTag/trios#1086|queen-swift|Cassette $$cassette|docs" \
		     --env TRIOS_REPLAY_CASSETTE="$(CASSETTE_DIR)/$$cassette" \
		     --env TRIOS_E2E_SECOND_TURN="$$second" \
		     --env TRIOS_E2E_DISABLE_KEYCHAIN="1" "$(TEST_APP)"; \
		: "The wait measures PROGRESS, not wall time. A fixed cliff (40 s, \
		   then 120 s) kept calling a loaded machine broken: with make check \
		   and half a dozen agents sharing the CPU the replay finishes late, \
		   the old loop timed out at 120 s, printed 'marker never appeared' \
		   about a process that was alive and working, and then killed it. \
		   Now log growth resets a 120 s idle clock; the suite fails only \
		   when the log has grown NOTHING for 120 s, when trios-test exits \
		   without the marker, or at a 600 s total backstop. Each failure \
		   message states which of those was measured."; \
		: "Rotation-aware: the harness app rotates its own log on boot, and \
		   a truncated file put the marker BELOW the pre-run line count - \
		   tail read past EOF, the growth check compared against a stale \
		   baseline, and a scenario that had SUCCEEDED (the marker was in \
		   the file) failed as 'grew nothing for 120s'. A shrink resets the \
		   read base to the top of the new file."; \
		found=0; started=0; idle=0; total=0; lastn=$$before; alive=0; base=$$before; \
		while :; do \
			tail -n "+$$((base + 1))" "$(TEST_LOG)" 2>/dev/null | grep -q "$$marker" && { found=1; break; }; \
			curn=$$(wc -l < "$(TEST_LOG)" 2>/dev/null || echo 0); \
			if [ "$$curn" -lt "$$base" ]; then base=0; lastn=0; fi; \
			if [ "$$curn" -gt "$$lastn" ]; then lastn=$$curn; idle=0; else idle=$$((idle + 2)); fi; \
			if pgrep -f "$(TEST_PROC_HERE)" >/dev/null 2>&1; then started=1; alive=1; \
			else alive=0; [ $$started -eq 1 ] && break; fi; \
			[ $$idle -ge 120 ] && break; \
			[ $$total -ge 600 ] && break; \
			sleep 2; total=$$((total + 2)); \
		done; \
		if [ $$found -eq 1 ]; then echo "  ok   - $$label"; \
		elif [ $$started -eq 0 ]; then \
			echo "  FAIL - $$label (trios-test never started; no process was seen in $${total}s)"; fail=1; \
		elif [ $$alive -eq 1 ] && [ $$total -ge 600 ]; then \
			echo "  FAIL - $$label (still alive with the log still growing at the 600s total budget; killed here, not proven broken)"; fail=1; \
		elif [ $$alive -eq 1 ]; then \
			echo "  FAIL - $$label (alive for $${total}s but the log grew nothing for 120s and $$marker never appeared)"; fail=1; \
		else \
			echo "  FAIL - $$label (trios-test exited after $${total}s without emitting $$marker)"; fail=1; \
		fi; \
		pkill -f "$(TEST_PROC_HERE)" 2>/dev/null || true; \
		sleep 2; \
	done; \
	: "The LAST cassette's checkout is still standing here - the per-run"; \
	: "cleanup above happens BEFORE each replay, so nothing clears the"; \
	: "final one. A branch checked out in a worktree cannot be deleted,"; \
	: "and the sweep then reports branches that survived."; \
	for wt in "$(ROOT)/.worktrees/test"/queen-*; do \
		[ -d "$$wt" ] || continue; \
		git -C "$(ROOT)" worktree remove --force "$$wt" >/dev/null 2>&1 || true; \
	done; \
	git -C "$(ROOT)" worktree prune >/dev/null 2>&1 || true; \
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
	: "Released here whether the suite passed or failed - the lock guards"; \
	: "the harness, not the verdict. A run killed before this line leaves"; \
	: "the directory behind with make's PID in it, and the next run"; \
	: "reclaims it after finding that PID dead."; \
	rm -rf "$(HARNESS_LOCK)" 2>/dev/null || true; \
	if [ $$fail -eq 0 ]; then echo "[OK] cassette suite passed ($$present cassettes)"; else echo "[FAIL] cassette suite"; exit 1; fi

# --- Running ------------------------------------------------------------

run: dev
	@open "$(DEV_APP)"

run-release:
	@open "$(RELEASE_APP)"

# Bring the backing services up after a reboot.
#
# A reboot leaves nothing running: no agent-server on 9105, no CDP browser on
# 9222, and pm2's process list empty because no resurrect is configured. The
# e2e suite's very first check then reports "BrowserOS Server: DOWN", which
# reads as a regression and is not one.
#
# The order is not cosmetic. `main.ts` requires --cdp-port AND connects to it
# before it will listen, so a server started before the browser exits at once.
# Once running it tolerates losing CDP (`/health` reports cdpConnected: false
# and stays ok) - that asymmetry is why "it worked yesterday" and "it refuses
# to start today" are both true.
.PHONY: serve
serve:
	@if curl -s -m 3 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then \
		echo "[OK] CDP already up on 9222"; \
	else \
		echo "[..] starting BrowserOS with remote debugging on 9222"; \
		open -a /Applications/BrowserOS.app --args --remote-debugging-port=9222; \
		for i in $$(seq 1 20); do \
			curl -s -m 2 http://127.0.0.1:9222/json/version >/dev/null 2>&1 && break; \
			sleep 2; \
		done; \
	fi
	@if curl -s -m 3 http://127.0.0.1:9105/health >/dev/null 2>&1; then \
		echo "[OK] server already up on 9105"; \
	else \
		echo "[..] starting agent-server on 9105"; \
		cd "$(ROOT)/agent-server" && \
			nohup bun apps/server/src/index.ts --server-port 9105 --cdp-port 9222 \
			> /tmp/trios_server_9105.log 2>&1 & \
		for i in $$(seq 1 20); do \
			curl -s -m 2 http://127.0.0.1:9105/health >/dev/null 2>&1 && break; \
			sleep 2; \
		done; \
	fi
	@health=$$(curl -s -m 5 http://127.0.0.1:9105/health || true); \
	case "$$health" in \
		*'"status":"ok"'*) echo "[OK] 9105 $$health" ;; \
		*) echo "[FAIL] 9105 did not come up: $${health:-no answer}"; \
		   tail -5 /tmp/trios_server_9105.log 2>/dev/null | sed 's/^/  | /'; \
		   exit 1 ;; \
	esac

stop:
	@pkill -f '$(RELEASE_PROC)' 2>/dev/null || true
	@pkill -f '$(DEV_PROC)' 2>/dev/null || true
	@echo "stopped"

# --- Release gate -------------------------------------------------------

# Promotion is the one moment the working app is deliberately replaced, so it
# is the one moment worth gating.
promote: check
	@echo "Gates passed. Promoting dev to release."
	@$(MAKE) release

# --- Diagnostics --------------------------------------------------------

# A REPORT, and it says so in its own output.
#
# There is no threshold to give this target, and inventing one would be worse
# than the honest report: every state it prints is a legitimate state of the
# machine. "server down" is not a defect, it is the answer you ran doctor to
# get, and a doctor that exits 1 when the app is not running is a doctor nobody
# can use in the one situation it exists for.
#
# But something here HAS been wrong, for weeks, in silence: `pgrep -x trios-dev`
# could never match anything, because both bundles ship an executable literally
# named `trios` (7d0335276). Nothing about a target that always exits 0 could
# have surfaced that. So instead of a verdict on the machine, the `running` line
# now carries a verdict on ITSELF: how many processes named `trios` exist, and
# how many of them the two variant patterns actually accounted for. Under the
# old patterns that line would have read `1 of 2 matched` and named its own bug.
# It stays a report - an unaccounted process is a normal thing to have (another
# checkout, a worktree, a bare ./trios_app) - but it can no longer be quietly
# incomplete.
#
# What it still does not prove: DEV_PROC has no leading anchor and RELEASE_PROC
# anchors only on a slash, so a *worktree's* bundle matches the same pattern as
# this checkout's. Such a process is counted as matched, and the line above
# would attribute it here. That one is unmeasured, not solved.

# REPORT, like doctor: every tile is an observation with its window printed on
# it. The generator only reads state; it never decides whether the state is
# good. Ceilings shown on the page are rendered from the same constants the
# signals carry, not judged here.
.PHONY: dashboard
dashboard:
	@python3 "$(ROOT)/tools/dashboard.py"

# The trios-live-forensics skill's steps 1-3 as one runnable command instead
# of three copy-paste blocks. REPORT-only, always exit 0. VARIANT picks the
# log root (release -> .trinity, dev -> .trinity-dev, test -> .trinity-test),
# which kills the wrong-root failure mode the skill documents: reading dev's
# log and saying "the swarm is stopped" about release, eleven times.
#
# LOG_VARIANT, not VARIANT directly: chat-probe declares `VARIANT ?= dev`
# further down, so "$(VARIANT)" here silently reported the dev log while the
# command line asked nothing - measured on this target's first run, which
# printed dev's board as if it were the release. Only an explicit
# command-line VARIANT wins over the release default.
ifeq ($(origin VARIANT),command line)
LOG_VARIANT := $(VARIANT)
else
LOG_VARIANT := release
endif
.PHONY: forensics
forensics:
	@python3 "$(ROOT)/tools/forensics.py" forensics --variant "$(LOG_VARIANT)"

# Counts of the named persistence/keychain/reconcile signals since the last
# server.launch anchor in the variant's log. Counts only - the diagnosis
# stays with the reader.
.PHONY: signals
signals:
	@python3 "$(ROOT)/tools/forensics.py" signals --variant "$(LOG_VARIANT)"

# Which of the five measured conditions refused the encryption key, per event.
# `signals` says how often the key was unavailable; this says who refused, and
# whether securityd was contacted at all. Two of the five refusals never reach
# it, and reporting them as "the key is locked" is what wrote the Queen's own
# transcript to plaintext on 2026-08-23.
# The floor cost of a cold Keychain data read on THIS machine, measured rather
# than assumed. The caller deadline is 2s; measured 2026-08-23, first touch of
# three items in one fresh process took 65.4s, 4.4s and 3.9s, and the same three
# in the same process afterwards took 0.070s, 0.011s and 0.012s. A deadline an
# order of magnitude below the floor is not a timeout, it is a guaranteed stall.
# Prints timings and byte counts only - never secret material.
.PHONY: keychain-floor
keychain-floor:
	@: "Stable path, stable signature. The first version built to mktemp and"; \
	: "let swiftc ad-hoc sign the result, so every run was a DIFFERENT"; \
	: "application to macOS. Keychain ACLs are bound to the application, so"; \
	: "the login keychain asked for a password on EVERY run and 'Always"; \
	: "Allow' could never stick - it whitelisted a throwaway binary that was"; \
	: "deleted seconds later. The operator reported the dialog appearing"; \
	: "every time, which is what sent me looking."; \
	: "Signed with the same identity build.sh gives the app bundle, which is"; \
	: "why the app itself stopped prompting in July. Answer 'Always Allow'"; \
	: "once and this binary stays trusted."; \
	mkdir -p "$(ROOT)/.trinity/build"; \
	bin="$(ROOT)/.trinity/build/keychain_floor"; \
	DEVELOPER_DIR=$(DEVELOPER_DIR) swiftc -O "$(ROOT)/tools/keychain_floor.swift" -o "$$bin" \
	  || { echo "[FAIL] keychain_floor did not build"; exit 1; }; \
	sign="$${TRIOS_SIGN_IDENTITY:-TriOS Development}"; \
	if security find-identity -p codesigning 2>/dev/null | grep -q "$$sign"; then \
		eval "$$(grep -E '^(KEYCHAIN_NAME|KEYCHAIN_PASSWORD)=' "$(ROOT)/scripts/create_dev_signing_identity.sh")"; \
		security unlock-keychain -p "$$KEYCHAIN_PASSWORD" "$$KEYCHAIN_NAME" 2>/dev/null || true; \
		codesign --force --sign "$$sign" "$$bin" 2>/dev/null \
		  || echo "[WARN] could not sign $$bin; the keychain will keep prompting"; \
	else \
		echo "[WARN] no '$$sign' identity, so this binary is ad-hoc signed and the"; \
		echo "[WARN] keychain will prompt on every run. Create one once with:"; \
		echo "[WARN]   bash scripts/create_dev_signing_identity.sh"; \
	fi; \
	"$$bin"

.PHONY: refusals
refusals:
	@python3 "$(ROOT)/tools/forensics.py" refusals --variant "$(LOG_VARIANT)"

# The delegation registry bucketed by state, with the legend that keeps
# "8 spoken for" from reading as "8 busy bees": only running has a worker.
.PHONY: board
board:
	@python3 "$(ROOT)/tools/forensics.py" board --variant "$(LOG_VARIANT)"

# One-line binary-vs-commit verdict per variant. Named to avoid colliding
# with `make drift-guard`, which is a type-level interface check.
.PHONY: binary-drift
binary-drift:
	@python3 "$(ROOT)/tools/forensics.py" drift

# Aggregate spend from the delegation registry: per-day tasks, tool calls and
# tokens, dollars only where a ModelPricing prefix matches recorded usage.
# Today it truthfully reports zero tokens - the agent-server does not emit a
# usage SSE event yet (see .trinity/specs/usage-sse-emission.md).
.PHONY: spend
spend:
	@python3 "$(ROOT)/tools/forensics.py" spend --variant "$(LOG_VARIANT)"

doctor:
	@echo "release app : $$([ -f '$(RELEASE_BIN)' ] && stat -f '%Sm' '$(RELEASE_BIN)' || echo 'absent')"
	@echo "dev app     : $$([ -f '$(DEV_BIN)' ] && stat -f '%Sm' '$(DEV_BIN)' || echo 'absent')"
	@up=''; \
	 rel=$$(pgrep -f '$(RELEASE_PROC)' 2>/dev/null | wc -l | tr -d ' '); \
	 dv=$$(pgrep -f '$(DEV_PROC)'      2>/dev/null | wc -l | tr -d ' '); \
	 named=$$(pgrep -x trios           2>/dev/null | wc -l | tr -d ' '); \
	 [ "$$rel" -gt 0 ] && up='release'; \
	 [ "$$dv"  -gt 0 ] && up="$${up:+$$up+}dev"; \
	 echo "running     : $${up:--} ($$((rel + dv)) of $$named processes named 'trios' matched)"
	@echo "server 9105 : $$(curl -s -m 3 http://127.0.0.1:9105/health || echo 'down')"
	@echo "server 9205 : $$(curl -s -m 3 http://127.0.0.1:9205/health || echo 'down')"
	@echo "-- REPORT: state read off this machine, not a verdict on it. Every line above is"
	@echo "   an observation, none of them can fail, and this target always exits 0."

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
	@pkill -f "$(DEV_PROC_HERE)" 2>/dev/null || true
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
QUEEN_COMMAND ?=

LOG := $(ROOT)/.trinity-dev/logs/trios-app.jsonl

delegate-probe:
	@# Remember where the log ends. Without this the wait loop matches the
	@# PREVIOUS run's verdict and reports a stale result as if it were fresh.
	@before=$$(wc -l < "$(LOG)" 2>/dev/null || echo 0); echo $$before > /tmp/trios_delegate_mark
	@# When trios-dev is already running, append to the inbox instead of
	@# killing it. The app's inbox poller (every 5 s) picks up the entry.
	@# When it is not running, launch it with the delegation env vars --
	@# `open` goes through LaunchServices, which does not inherit the shell
	@# environment, so --env is the only way the flags reach the app.
	@if pgrep -f "$(DEV_PROC_HERE)" >/dev/null 2>&1; then \
		echo "[probe] trios-dev already running -- appending to inbox"; \
		mkdir -p "$(ROOT)/.trinity-dev/state"; \
		python3 -c 'import json,sys; print(json.dumps({"issue":sys.argv[1],"worker":sys.argv[2] or None,"title":sys.argv[3] or None,"paths":sys.argv[4].split() or None,"criteria":[c.strip() for c in sys.argv[5].split(";") if c.strip()] or None}))' \
			"$(ISSUE)" "$(WORKER)" "$(TASK)" "$(PATHS)" "$(CRITERIA)" \
			>> "$(ROOT)/.trinity-dev/state/queen_inbox.jsonl"; \
	else \
		echo "[probe] trios-dev not running -- launching"; \
		rm -f "$(ROOT)/.trinity-dev/state/queen_delegation.json"; \
		open --env TRIOS_E2E_DELEGATE="$(ISSUE)|$(WORKER)|$(TASK)|$(PATHS)|$(CRITERIA)" \
			--env TRIOS_E2E_DELEGATE_SECOND="$(SECOND)" \
			--env TRIOS_E2E_DELEGATE_REVIEW="$(REVIEW)" \
			--env TRIOS_QUEEN_AUTONOMY="$(AUTONOMY)" \
			--env TRIOS_REPLAY_CASSETTE="$(CASSETTE)" \
			--env TRIOS_E2E_SECOND_TURN="$(SECOND_TURN)" \
			--env TRIOS_E2E_QUEEN_COMMAND="$(QUEEN_COMMAND)" "$(DEV_APP)"; \
	fi
	@echo "delegating $(ISSUE) to $(WORKER); waiting up to 16 min"
	@before=$$(cat /tmp/trios_delegate_mark); \
	issue="$(ISSUE)"; \
	for i in $$(seq 1 192); do \
		tail -n "+$$((before + 1))" "$(LOG)" 2>/dev/null \
			| grep -F "$$issue" \
			| grep -q "selftest.\(passed\|failed\)\|worker.\(finish\|failed\)" && break; \
		sleep 5; \
	done; \
	tail -n "+$$((before + 1))" "$(LOG)" 2>/dev/null \
		| grep -F "$$issue" \
		|| echo "no lines were written for $$issue"

# --- The source list, written twice ---------------------------------------
#
# The set of Swift files that make up this app was written down in two places
# and neither read the other:
#
#   - build.sh: the LEAN_BR_OUTPUT array plus `find rings -name '*.swift'`
#   - Package.swift AT THE GIT ROOT (not in trios/, which is part of why nobody
#     looked at it): the TriOSKit target's `sources:` list
#
# By the time anyone diffed them they were 46 paths apart: 45 that build.sh
# compiled and the manifest did not, and 1 the other way. One of the 45 is
# main.swift and can never be in a library target, so 45 of the 46 were
# unintended. That did not surface
# as a missing file. It surfaced as SwiftPM stopping at "Emitting module
# TriOSKit" on `cannot find type SessionGuard in scope`, which meant the ENTIRE
# XCTest suite had never once compiled - and XCTEST_ERROR_CEILING was 2, exactly
# what that wreckage produced. The gate was green because it had been fitted to
# the breakage.
#
# The 1 the other way was worse, because SwiftPM does not fail on it:
# "BR-OUTPUT/HotkeyAnalytics.swift" was deleted in 939028c91 and the manifest
# entry stayed, which SwiftPM reports as `Invalid Source ...: File not found.`
# - a WARNING, on a build that then succeeds. So this target checks that every
# entry EXISTS as well as that the two sets agree.
#
# build.sh is the list of record and prints it (`TRIOS_PRINT_SOURCES=1`, 0.5s,
# no side effects), so this compares the manifest against the list that actually
# builds the app rather than against a third copy of it. Same move, and the same
# reason, as TRIOS_PRINT_FLAGS.
SOURCES_MANIFEST := $(ROOT)/../Package.swift

# The two lists cannot be made identical, and these are the six paths that
# differ, each with the compiler error that forces it. Package.swift carries the
# same list next to the entries; this one is what the gate enforces. A seventh
# cannot be added by accident - only by editing this line.
#
#   main.swift                            SwiftPM refuses a `main` file in a
#                                         library product outright
#   BR-OUTPUT/MenuBuilder.swift           cannot find type 'AppDelegate'
#   BR-OUTPUT/ChatPanelView.swift         Notification.Name has no member
#                                         'exportSessionRecoveryPackage'
#   BR-OUTPUT/FullscreenChatWorkspace.swift  cannot find 'ChatPanelView'
#   BR-OUTPUT/QueenTabView.swift          cannot find 'AdaptiveChatWorkspace'
#   BR-OUTPUT/TriosTabView.swift          cannot find 'QueenTabView'
#
# Only the first is a rule of the tool. The rest are one entanglement:
# MenuBuilder.swift holds the AppDelegate menu wiring AND the Notification.Name
# constants the chat views need. Split that file and four of these five come
# back under test.
SOURCES_APP_ONLY := main.swift \
	BR-OUTPUT/MenuBuilder.swift \
	BR-OUTPUT/ChatPanelView.swift \
	BR-OUTPUT/FullscreenChatWorkspace.swift \
	BR-OUTPUT/QueenTabView.swift \
	BR-OUTPUT/TriosTabView.swift

# Paths the manifest may carry that build.sh does not. Empty, and it should stay
# that way: this is where "just for the test" lives, and the last occupant was a
# dangling reference to a file deleted eight commits earlier. A name here must
# also be a real file, and must really be absent from build.sh's list, or the
# gate calls the exception stale.
SOURCES_TEST_ONLY :=

.PHONY: sources-drift
sources-drift:
	@tmp=$$(mktemp -d /tmp/trios_sources_drift.XXXXXX) || exit 1; \
	trap 'rm -rf "$$tmp"' EXIT INT TERM; \
	if [ ! -f "$(SOURCES_MANIFEST)" ]; then \
		echo "[FAIL] no manifest to check: $(SOURCES_MANIFEST)"; \
		exit 1; \
	fi; \
	if ! TRIOS_PRINT_SOURCES=1 "$(ROOT)/build.sh" > "$$tmp/build" 2>"$$tmp/build_err"; then \
		echo "[FAIL] build.sh could not print its source list, so this target"; \
		echo "       measured nothing. Output:"; \
		sed -n "1,10p" "$$tmp/build_err" | sed "s/^/  /"; \
		exit 1; \
	fi; \
	if [ ! -s "$$tmp/build" ]; then \
		echo "[FAIL] build.sh printed an empty source list. An empty list agrees"; \
		echo "       with nothing and would compare clean against an empty"; \
		echo "       manifest, so it is a failure, not a pass."; \
		exit 1; \
	fi; \
	sort -u "$$tmp/build" -o "$$tmp/build"; \
	awk '/sources:[ \t]*\[/{f=1;next} f&&/^[ \t]*\],[ \t]*$$/{f=0} f' \
		"$(SOURCES_MANIFEST)" \
		| grep -v '^[ \t]*//' \
		| sed -n 's|^[ \t]*"\([^"]*\)".*|\1|p' \
		| sort -u > "$$tmp/literal"; \
	if [ ! -s "$$tmp/literal" ]; then \
		echo "[FAIL] found no source entries in $(SOURCES_MANIFEST). Either the"; \
		echo "       target lost its sources: list or this recipe stopped being"; \
		echo "       able to read it; both are failures."; \
		exit 1; \
	fi; \
	missing=""; \
	while IFS= read -r entry; do \
		[ -e "$(ROOT)/$$entry" ] || missing="$$missing$$entry"$$'\n'; \
	done < "$$tmp/literal"; \
	if [ -n "$$missing" ]; then \
		echo "[FAIL] $(SOURCES_MANIFEST) names sources that do not exist."; \
		echo "       SwiftPM only warns about these and builds on, so a test"; \
		echo "       that needs the file fails with 'cannot find ... in scope'"; \
		echo "       and nothing points at the manifest:"; \
		printf '%s' "$$missing" | sed "s/^/  /"; \
		exit 1; \
	fi; \
	while IFS= read -r entry; do \
		if [ -d "$(ROOT)/$$entry" ]; then \
			find "$(ROOT)/$$entry" -name '*.swift' | sed "s|^$(ROOT)/||"; \
		else \
			echo "$$entry"; \
		fi; \
	done < "$$tmp/literal" | sort -u > "$$tmp/manifest"; \
	printf '%s\n' $(SOURCES_APP_ONLY) | grep -v '^$$' | sort -u > "$$tmp/app_only"; \
	printf '%s\n' $(SOURCES_TEST_ONLY) | grep -v '^$$' | sort -u > "$$tmp/test_only"; \
	stale=""; \
	while IFS= read -r entry; do \
		grep -qxF "$$entry" "$$tmp/build" \
			|| stale="$$stale$$entry (SOURCES_APP_ONLY, but build.sh does not compile it)"$$'\n'; \
	done < "$$tmp/app_only"; \
	while IFS= read -r entry; do \
		[ -z "$$entry" ] && continue; \
		grep -qxF "$$entry" "$$tmp/build" \
			&& stale="$$stale$$entry (SOURCES_TEST_ONLY, but build.sh compiles it too)"$$'\n'; \
	done < "$$tmp/test_only"; \
	if [ -n "$$stale" ]; then \
		echo "[FAIL] declared exception no longer describes anything real:"; \
		printf '%s' "$$stale" | sed "s/^/  /"; \
		echo "       An exception that is not an exception is a place for the"; \
		echo "       next divergence to hide. Remove it."; \
		exit 1; \
	fi; \
	comm -23 "$$tmp/build" "$$tmp/app_only" | sort -u > "$$tmp/expected"; \
	cat "$$tmp/test_only" >> "$$tmp/expected"; \
	sort -u "$$tmp/expected" -o "$$tmp/expected"; \
	only_build=$$(comm -23 "$$tmp/expected" "$$tmp/manifest"); \
	only_manifest=$$(comm -13 "$$tmp/expected" "$$tmp/manifest"); \
	if [ -n "$$only_build" ] || [ -n "$$only_manifest" ]; then \
		echo "[FAIL] the source list and $(SOURCES_MANIFEST) disagree."; \
		if [ -n "$$only_build" ]; then \
			echo "  build.sh compiles these, the manifest does not (so the"; \
			echo "  library, and every test that links it, cannot see them):"; \
			echo "$$only_build" | sed "s/^/    /"; \
		fi; \
		if [ -n "$$only_manifest" ]; then \
			echo "  the manifest lists these and build.sh does not (so they are"; \
			echo "  under test but not in the shipped app):"; \
			echo "$$only_manifest" | sed "s/^/    /"; \
		fi; \
		echo "  Add the file to whichever list is missing it, or - if the"; \
		echo "  difference is deliberate and forced - name it in SOURCES_APP_ONLY"; \
		echo "  or SOURCES_TEST_ONLY in the Makefile, with the compiler error"; \
		echo "  that forces it."; \
		exit 1; \
	fi; \
	echo "[OK] build.sh and $$(basename "$(SOURCES_MANIFEST)") agree on $$(wc -l < "$$tmp/manifest" | tr -d ' ') sources" \
		"($$(wc -l < "$$tmp/app_only" | tr -d ' ') declared app-only," \
		"$$(wc -l < "$$tmp/test_only" | tr -d ' ') declared test-only)"

# Proof that the target above can go red. Each fixture is a real Package.swift
# on disk rather than a mocked list, run through the same recipe by pointing
# SOURCES_MANIFEST at the copy - so what is exercised is the parser and the
# comparison, not a stub of them. The summary counts the cases it ran; a number
# written into the message is a number that goes stale on the next case added.
#
# Written because the gate it proves exists to replace one that was green for
# the wrong reason. A drift check that cannot fail would be the same mistake
# with a longer name.
.PHONY: sources-drift-selftest
sources-drift-selftest:
	@tmp=$$(mktemp -d /tmp/trios_drift_selftest.XXXXXX) || exit 1; \
	trap 'rm -rf "$$tmp"' EXIT INT TERM; \
	fail=0; ran=0; \
	run() { \
		label="$$1"; want="$$2"; shift 2; \
		"$(MAKE)" --no-print-directory sources-drift "$$@" > "$$tmp/out" 2>&1; \
		rc=$$?; \
		if [ "$$want" = "pass" ] && [ "$$rc" -ne 0 ]; then \
			echo "  [FAIL] $$label: expected pass, got exit $$rc"; \
			sed -n "1,6p" "$$tmp/out" | sed "s/^/         /"; fail=1; return; \
		fi; \
		if [ "$$want" = "fail" ] && [ "$$rc" -eq 0 ]; then \
			echo "  [FAIL] $$label: expected a failure, the gate passed"; \
			sed -n "1,6p" "$$tmp/out" | sed "s/^/         /"; fail=1; return; \
		fi; \
		ran=$$((ran + 1)); \
		echo "  [ok] $$label -> $$(head -n 1 "$$tmp/out")"; \
	}; \
	cp "$(SOURCES_MANIFEST)" "$$tmp/clean.swift"; \
	sed '\|"BR-OUTPUT/SessionGuard.swift",|d' "$$tmp/clean.swift" > "$$tmp/dropped.swift"; \
	cmp -s "$$tmp/clean.swift" "$$tmp/dropped.swift" && { \
		echo "[FAIL] fixture did not change anything: BR-OUTPUT/SessionGuard.swift"; \
		echo "       is no longer an entry, so this fixture proves nothing."; \
		exit 1; \
	}; \
	sed 's|"BR-OUTPUT/SessionGuard.swift",|"BR-OUTPUT/SessionGuard.swift",\n                "main.swift",|' \
		"$$tmp/clean.swift" > "$$tmp/added.swift"; \
	sed 's|"BR-OUTPUT/SessionGuard.swift",|"BR-OUTPUT/SessionGuard.swift",\n                "BR-OUTPUT/HotkeyAnalytics.swift",|' \
		"$$tmp/clean.swift" > "$$tmp/ghost.swift"; \
	run "unmodified manifest" pass SOURCES_MANIFEST="$$tmp/clean.swift"; \
	run "entry removed (the SessionGuard hole)" fail SOURCES_MANIFEST="$$tmp/dropped.swift"; \
	run "app-only file added to the library" fail SOURCES_MANIFEST="$$tmp/added.swift"; \
	run "entry naming a deleted file (HotkeyAnalytics)" fail SOURCES_MANIFEST="$$tmp/ghost.swift"; \
	run "stale declared exception" fail SOURCES_APP_ONLY="main.swift BR-OUTPUT/NotCompiledByBuildSh.swift"; \
	if [ "$$fail" -ne 0 ]; then \
		echo "[FAIL] sources-drift did not behave as claimed"; \
		exit 1; \
	fi; \
	if [ "$$ran" -lt 2 ]; then \
		echo "[FAIL] only $$ran fixture(s) ran; this proves nothing"; \
		exit 1; \
	fi; \
	echo "[OK] sources-drift behaved as claimed on all $$ran fixtures"

# The XCTest target, reported honestly rather than folded into the app build.
# Counts distinct errors, not lines mentioning one.
#
# swiftc prints each error with several lines of source context, and every one
# of those contains the word "error:". Counting lines reported 1651 where there
# were 76 - a debt that looks hopeless instead of a fortnight's work, which is a
# decent explanation for why nobody has picked it up. A metric nobody measured
# is worse than no metric: this one was actively arguing against being fixed.
#
# --- And then it printed the metric and exited 0 whatever it said ----------
#
# Everything above argues the number matters. The recipe below then reported it
# with no threshold, which means nobody had to hold it: 76 could climb back
# without a single person deciding to allow it. Three things changed.
#
# 1. A ceiling, the same shape as WARNING_CEILING. Not a round number somebody
#    liked - it is exactly what this tree measures today, which is the only
#    value that is simultaneously green now and impossible to argue upward.
#    That property is necessary and it is NOT sufficient: this ceiling sat at 2
#    and green for months because 2 was what a packaging bug produced, and
#    "measured today" says nothing about whether the measurement reaches the
#    thing being gated. Ask what the count did not get to before trusting it.
#
# 2. The old line called the count "pre-existing debt", and it is not. Driven
#    on this revision the two errors are one missing symbol:
#
#      rings/SR-00/CompositionRoot.swift: cannot find type SessionGuard in scope
#      rings/SR-00/CompositionRoot.swift: cannot find SessionGuard in scope
#
#    BR-OUTPUT/SessionGuard.swift is compiled by build.sh and is NOT in
#    Package.swift's sources list. That is a packaging gap in the LIBRARY, so
#    SwiftPM stops at "Emitting module TriOSKit" and never compiles
#    tests/TriOSKitTests at all. The 2 is not the suite's debt; it is how far
#    the compiler got before the first wall, and the old wording read as if the
#    suite were two fixes from green. The recipe now says which of the two it
#    measured - and, by the rule the warning gate already follows, the advice to
#    LOWER the ceiling is reachable only from a count that compiled the tests.
#    Expect the number to JUMP the day the wall comes down: that red is the
#    first honest measurement of the suite, not a regression, and it is the one
#    time raising this ceiling is a finding rather than tuning.
#
# 2b. THE WALL CAME DOWN, and the number is 23. Package.swift's sources list now
#    matches what build.sh compiles (see `make sources-drift` above), the two
#    QueenUILib -I/-L flags are read from build.sh rather than absent, and
#    `Emitting module TriOSKitTests` is reached for the first time. 2 -> 23 is
#    not a regression and not 21 new bugs; 2 was never the suite's error count,
#    it was the distance to a wall that hid the other 23. All 23 are in test
#    files, none in the library:
#
#      ChatFailureTests.swift             9   MainActor isolation, three Mock
#                                             types no longer matching the
#                                             protocols they stub, and
#                                             ModelHealthResult.unavailable
#      LocalAuthProviderTests.swift       7   isolation, a dropped `try`, and
#                                             an argument the API no longer has
#      LogsTabViewTests.swift             6   isolation, a syntax error, and
#                                             LogRotationPolicy needing Hashable
#      HotkeyAnalyticsEncryptionTests.swift 1 cannot find HotkeyAnalyticsViewModel
#
#    The last one is not fixable in the test: BR-OUTPUT/HotkeyAnalytics.swift
#    was deleted in 939028c91 and the test that asserts those analytics are
#    encrypted at rest has been testing nothing since. The other 38 test files
#    compile. That is the finding this ceiling is now holding, and the next
#    honest move on it is DOWN.
#
# 3. `swift build` failing with no source-level error line at all - a manifest
#    error, no sqlcipher, no toolchain - used to print "0 distinct compile
#    errors" and exit 0. That is the same false zero the warning gate was
#    rebuilt to kill. It is now a failure that says it measured nothing.
#
# One build, not two: the old recipe ran `swift build --build-tests` twice and
# took the error count from one run and the file count from the other, so the
# two halves of one sentence came from two different measurements.
#
# Not in `check`, and this is a measurement I did not make rather than an
# argument. One warm run here is 15s, which `check` could afford, but it puts a
# second build system inside a target whose `dev` step already runs build.sh's
# own `swift test`, and on a machine without sqlcipher it is a fresh way for
# `check` to go red for a reason unrelated to the change under test. `make dev`
# already prints "run 'make xctest' for detail" when the suite is broken, so the
# pointer exists; the wiring needs its own driving before it is claimed.
# Zero, and this number is derived from a REQUIREMENT rather than from a
# reading. It was 2 for months because a mirrored source list stopped the build
# after exactly 2 errors; it was 23 for an afternoon because that is what the
# suite reported the first time it compiled. Both were snapshots. A suite that
# compiles is the requirement, so the ceiling is 0 and any rise is a regression.
XCTEST_ERROR_CEILING := 0

.PHONY: xctest
# --- Does the suite RUN, and does it FINISH? -----------------------------
#
# 'xctest' counts COMPILE errors. That is one of three distinct states, and for
# months this repository had a gate on the first while believing it measured the
# third: does it build, does it run, does it pass.
#
# This target answers the second and third, and the completeness check is the
# load-bearing part. An aborted run does not report "n failures" -- it reports a
# PREFIX, and a prefix is indistinguishable from a short suite. That is not
# hypothetical: the suite reported 121 tests, then 133, and the real figure was
# 483, because a fatalError in a URLProtocol and fourteen force-unwraps after a
# failed XCTAssertNotNil were each killing the process mid-run. Everything
# scheduled after the crash silently disappeared.
#
# So the run must certify its own completeness: XCTest prints a final
# "Test Suite 'All tests'" summary if and only if it reached the end. No summary
# means the number is a prefix, whatever it says.
#
# TRIOS_E2E_DISABLE_KEYCHAIN=1 is part of the contract, not a superstition:
# without it KeychainSymmetricKeyStoreTests hits a real keychain, dies on a
# Fatal error, and the run stops there. A precondition that changes the SHAPE of
# the result rather than its value belongs in the recipe.
#
# The judgement lives in 'xctest-log-complete', which reads a log given to it,
# so the red side can be driven in milliseconds instead of the 5.5 minutes a
# real abort costs. A gate proven only from the green side is not proven.
.PHONY: xctest-run
xctest-run:
	@log=$$(mktemp /tmp/trios_xctest_run.XXXXXX) || exit 1; \
	trap 'rm -f "$$log"' EXIT INT TERM; \
	TRIOS_E2E_DISABLE_KEYCHAIN=1 TRIOS_VARIANT=dev \
		swift test --package-path "$(ROOT)/.." > "$$log" 2>&1 || true; \
	$(MAKE) --no-print-directory xctest-log-complete LOG="$$log"

.PHONY: xctest-log-complete
xctest-log-complete:
	@log="$(LOG)"; \
	if [ -z "$$log" ] || [ ! -f "$$log" ]; then \
		echo "[FAIL] xctest-log-complete needs LOG=<path to a swift test log>"; \
		exit 1; \
	fi; \
	if ! /usr/bin/grep -q "Test Suite 'All tests'" "$$log"; then \
		echo "[FAIL] the run did not finish: no 'All tests' summary."; \
		echo "       Whatever count it printed is a PREFIX, not a result."; \
		/usr/bin/grep -E "Fatal error|signal code" "$$log" | head -3 | sed 's/^/       | /'; \
		exit 1; \
	fi; \
	line=$$(/usr/bin/grep -E "^\s+Executed .* tests?, with" "$$log" | tail -1); \
	: "'started' is load-bearing: XCTest prints two lines per case, so the"; \
	: "bare prefix counts every test twice. This target printed 966 for a"; \
	: "483-test suite on its very first run. The line ends 'started.' WITH a"; \
	: "period, and anchoring on 'started$$' then printed 0 for the same 483 -"; \
	: "the second wrong count in the same expression, which is why the"; \
	: "self-check below exists."; \
	ran=$$(/usr/bin/grep -cE "^Test Case .* started\.?$$" "$$log"); \
	: "A counter that can silently read zero is worse than no counter: it"; \
	: "reports absence with the same confidence as a measurement. If the"; \
	: "summary says tests executed and this says none started, the pattern is"; \
	: "wrong, not the suite."; \
	if [ "$$ran" -eq 0 ] && ! printf '%s' "$$line" | /usr/bin/grep -q "Executed 0 tests"; then \
		echo "[FAIL] the summary reports executed tests but no start lines matched."; \
		echo "       $$line"; \
		echo "       The counting pattern is stale, not the suite. Sample line:"; \
		/usr/bin/grep -m1 "^Test Case" "$$log" | sed 's/^/       | /'; \
		exit 1; \
	fi; \
	echo "[OK] the run finished. $$line"; \
	echo "     $$ran test case starts observed"

# Both sides of the completeness check, on synthetic logs. The truncated one is
# the exact shape the real suite had for months: a plausible "Executed N tests"
# line, a crash, and nothing after it. A reader who trusts the number reads 2
# where the truth is 483.
.PHONY: run-completeness-selftest
run-completeness-selftest:
	@d=$$(mktemp -d /tmp/trios_runsel.XXXXXX) || exit 1; \
	trap 'rm -rf "$$d"' EXIT INT TERM; \
	fail=0; \
	printf "%s\n" \
		"Test Case '-[T a]' started" \
		"Test Case '-[T a]' passed (0.1 seconds)" \
		"Test Suite 'All tests' passed at 2026-08-17 03:00:00.000." \
		"	 Executed 1 test, with 0 failures (0 unexpected) in 0.1 (0.1) seconds" \
		> "$$d/whole.log"; \
	printf "%s\n" \
		"Test Case '-[T a]' started" \
		"Test Case '-[T a]' passed (0.1 seconds)" \
		"Test Case '-[T b]' started" \
		"	 Executed 2 tests, with 0 failures (0 unexpected) in 0.2 (0.2) seconds" \
		"Fatal error: MockURLProtocol.requestHandler is not set" \
		> "$$d/cut.log"; \
	if ! $(MAKE) --no-print-directory xctest-log-complete LOG="$$d/whole.log" \
			> "$$d/whole.out" 2>&1; then \
		echo "  [FAIL] a complete log was rejected:"; sed 's/^/         | /' "$$d/whole.out"; \
		fail=1; \
	fi; \
	if $(MAKE) --no-print-directory xctest-log-complete LOG="$$d/cut.log" \
			> "$$d/cut.out" 2>&1; then \
		echo "  [FAIL] a TRUNCATED log passed. The gate does not gate:"; \
		sed 's/^/         | /' "$$d/cut.out"; \
		fail=1; \
	fi; \
	if $(MAKE) --no-print-directory xctest-log-complete LOG="$$d/absent.log" \
			> /dev/null 2>&1; then \
		echo "  [FAIL] a MISSING log passed. An unrun suite would read as green."; \
		fail=1; \
	fi; \
	if [ $$fail -eq 0 ]; then \
		echo "[OK] run-completeness: whole log accepted, truncated and missing refused"; \
	fi; \
	exit $$fail

xctest:
	@tmp=$$(mktemp -d /tmp/trios_xctest.XXXXXX) || exit 1; \
	trap 'rm -rf "$$tmp"' EXIT INT TERM; \
	: "Two of the library sources import QueenUILib, which lives in the"; \
	: "trinity checkout and is not a SwiftPM dependency of this package. Without"; \
	: "its -I/-L the test build stops on 'no such module' - one error, in the"; \
	: "library, tests never reached - and the number this target prints is the"; \
	: "distance to that wall rather than the state of the suite. The exact same"; \
	: "way the SessionGuard gap made this gate read 2 for months. build.sh"; \
	: "resolves those directories and prints them, so read them from there."; \
	if ! TRIOS_PRINT_FLAGS=1 "$(ROOT)/build.sh" > "$$tmp/flags" 2>"$$tmp/flags_err"; then \
		echo "[FAIL] build.sh could not resolve the module flags, so the test build"; \
		echo "       would have measured a missing QueenUILib instead of the suite."; \
		echo "       Nothing was measured and the ceiling is not being enforced:"; \
		sed -n "1,10p" "$$tmp/flags_err" | sed "s/^/  /"; \
		exit 1; \
	fi; \
	xflags=(); \
	while IFS= read -r flag; do xflags+=(-Xswiftc "$$flag"); done < "$$tmp/flags"; \
	if [ "$${#xflags[@]}" -eq 0 ]; then \
		echo "[FAIL] build.sh printed no module flags; refusing to report a count"; \
		echo "       taken without them."; \
		exit 1; \
	fi; \
	swift build --build-tests "$${xflags[@]}" > "$$tmp/log" 2>&1; rc=$$?; \
	/usr/bin/grep -E "^/.*error:" "$$tmp/log" \
		| sed "s/:[0-9]*:[0-9]*: error: /: /" \
		| sort -u > "$$tmp/errors"; \
	errors=$$(wc -l < "$$tmp/errors" | tr -d " "); \
	files=$$(/usr/bin/grep -oE "^/[^:]*\.swift" "$$tmp/errors" \
		| sort -u | wc -l | tr -d " "); \
	if [ "$$rc" -ne 0 ] && [ "$$errors" -eq 0 ]; then \
		echo "[FAIL] the test build failed and printed no source-level error, so this"; \
		echo "       target measured nothing and the ceiling of $(XCTEST_ERROR_CEILING) is not being"; \
		echo "       enforced. First lines of the build output:"; \
		sed -n "1,10p" "$$tmp/log" | sed "s/^/  /"; \
		exit 1; \
	fi; \
	if [ "$$rc" -eq 0 ] || /usr/bin/grep -qE "(Compiling|Emitting module) TriOSKitTests" "$$tmp/log"; then \
		reached=1; \
	else \
		reached=0; \
	fi; \
	if [ "$$reached" -eq 1 ]; then \
		echo "XCTest: $$errors distinct compile error(s) across $$files file(s);"; \
		echo "        tests/TriOSKitTests was compiled, so this is the whole count."; \
	else \
		echo "XCTest: $$errors distinct compile error(s) across $$files file(s), all of them in"; \
		echo "        the library the tests link against. tests/TriOSKitTests was never"; \
		echo "        compiled, so its errors are not in this number: a lower bound."; \
	fi; \
	if [ "$$errors" -gt $(XCTEST_ERROR_CEILING) ]; then \
		echo "[FAIL] $$errors distinct compile error(s); the ceiling is $(XCTEST_ERROR_CEILING)."; \
		sed "s|$(ROOT)/||" "$$tmp/errors" | head -25 | sed "s/^/  /"; \
		exit 1; \
	fi; \
	echo "[OK] $$errors distinct compile error(s), ceiling $(XCTEST_ERROR_CEILING)."; \
	if [ "$$reached" -eq 1 ] && [ "$$errors" -lt $(XCTEST_ERROR_CEILING) ]; then \
		echo "[NOTE] under the ceiling. Lower XCTEST_ERROR_CEILING in the Makefile so the"; \
		echo "       gain cannot be given back."; \
	fi

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
# If the needle is gone but its replacement is in place, the run was
# interrupted mid-mutation: a leftover mutation.  It is repaired (the
# replacement is swapped back to the needle) and the mutation re-runs.
# A needle gone with no replacement present is genuinely stale.
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
#
# Why the digest row below exists.  Twenty named checks were written for the
# reaper's predicates and none of them noticed when the stream-open guard was
# deleted from the shipped reaper: the test helper `reaperWouldTake` carries
# its own copy of that line, so it kept passing against the copy.  A test that
# re-states the code under test can only fail when the re-statement is wrong.
# The digest's checks therefore call `QueenReviewDigest.stalled` and
# `QueenReviewScheduler.reviewNow` themselves, with nothing transcribed - and
# this row is how that claim is checked rather than asserted: put the clock
# back in the shipped digest and the suite must go red.
#
# --- What this table CANNOT ask, and why -------------------------------
#
# The standing checks in `make check` were audited by hand with one question:
# "what event in the world makes this red?".  The obvious next move is to stop
# asking it by hand and put each answer in this table.  It does not work, and
# the reason is worth writing down so nobody spends the hour again.
#
# The oracle here is the SSE suite, and the scoring contract above admits two
# verdicts as evidence: the suite ran and failed (caught), or the suite ran and
# passed (survived).  Every other standing check exists precisely BECAUSE the
# compiler and the suite cannot see its failure - which is the same sentence,
# read backwards, as "its failure cannot be scored here".
#
# Each line below was DRIVEN with `make mutants MUTANTS=<the single row>` on a
# clean tree.  The verdict quoted is what the harness printed.
#
#   keychain-doors  A real SecItemCopyMatching call planted in
#                   rings/SR-02/AgentMemoryService.swift, which imports
#                   Security and is not on KEYCHAIN_ALLOWLIST.
#                   `make keychain-doors` names the file and exits 1.  The
#                   harness printed SURVIVED.  The suite runs with
#                   TRIOS_E2E_DISABLE_KEYCHAIN=1: it is keychain-blind by
#                   construction.
#
#   warning gate    `let triosWarningProbe = 1;` in front of
#                   QueenObserver.swift:160 puts
#                   "initialization of immutable value ... was never used"
#                   into the suite's OWN build log, and the harness printed
#                   SURVIVED.  run_chat_sse_e2e.sh reads PIPESTATUS, never the
#                   warning text, and no scenario counts warnings.
#
#   parse-tests     Both halves fail, in opposite directions.  Drop the `func`
#                   keyword in tests/swift/ChatSSETestMocks.swift, which the
#                   suite compiles: "ERROR - the suite never ran".  Do it in
#                   tests/swift/queen_delegation_test.swift, which it does not
#                   compile - the exact case parse-tests was written for:
#                   SURVIVED.  A syntax error is a tree that does not build,
#                   and the contract above refuses, on purpose, to score a
#                   tree that does not build as coverage.
#
#   empty-sources   Not expressible: a row is one text substitution and cannot
#                   take a file to zero bytes.  It would not help anyway - an
#                   emptied rings/ file is a build failure, i.e. the same
#                   ERROR measured for parse-tests, not a catch.
#
#   make-dollars    Its subject is this file.  The suite never reads the
#                   Makefile, so any row is a survivor - and a table that runs
#                   inside `make check` should not rewrite the Makefile that
#                   is executing it.
#
#   backlog-audit   Has no red to trigger.  Driven against
#                   tests/fixtures/backlog-bad.json it prints
#                   "verdict=looks-open" and exits 0, by design: it only
#                   reports.  Its input is the GitHub timeline, not the tree,
#                   so a tree mutation has no lever on it at all.
#
#   drift-guard     The only one whose subject the suite CAN see
#                   (QueenBranchCommitter.verifyCombinedBuild), and the only
#                   one blocked by this table's SHAPE rather than by its
#                   oracle: the scenario runs only under TRIOS_RUN_DRIFT_GUARD,
#                   so a row on it survives a plain `make mutants`.
#                   Worse, and found while trying to baseline it: on this
#                   machine `make drift-guard` does not finish.  On a clean
#                   tree it sat 17 minutes inside the scenario's own `git`
#                   helper, in -[NSConcreteTask waitUntilExit], with no live
#                   child process - the helper hands git a Pipe nobody reads.
#                   A check that hangs is worse news than one that cannot be
#                   mutated, and it has to be fixed before a row for it means
#                   anything.
#
# Four of these seven already have a mechanical red-driver, and it is not this
# table: check-selftest plants the SecItem call, the single-dollar recipe line,
# the zero-byte source and the two backlog fixtures.  That is where a Makefile
# check's "what makes this red?" belongs, because there the oracle is the
# check itself.
#
# The smallest extension that fits the rest - BUILT, below `MUTANTS_LOGIC`, as
# `MUTANTS_GUARD` / `make mutants-guard`.  Driven on this machine: the two rows
# the audit measured as impossible here (the planted SecItemCopyMatching, and
# the dropped func keyword in a test source the app build never compiles) both
# print "ok - caught" against their own check, and `make mutants-guard` exits 0
# in 16-26s (three runs here: 26s, 15.7s, 18.2s - `swiftc -parse` over
# tests/swift is the whole cost).  With keychain-doors made red BEFORE the row
# ran - a SecItemDelete planted in a THIRD file - the row printed "REFUSED";
# `shasum -c` against a checksum taken before the run showed the file the row
# WOULD have mutated byte-identical, so the refusal happened before any edit;
# the sibling parse-tests row still scored "ok - caught" on that same run; and
# the target failed (recipe exit 1, make exit 2).  The sketch below is why that
# gate is not ceremony:
#
#   A sibling table carrying one extra field that names the oracle, exactly as
#   MUTANTS_LOGIC already carries a suite label:
#
#       MUTANTS_GUARD := source@@needle@@replacement@@target@@name
#
#   and a loop that, per row, runs `make <target>` BEFORE the mutation - it
#   must exit 0, otherwise an already-red machine forges a catch - then
#   applies the mutation and runs it again, scoring only 0 -> non-zero as
#   caught.  That covers keychain-doors, make-dollars, parse-tests and every
#   other pure tree-reader (guard-shapes, finish-mark-order, vendor-step).  It
#   needs no confirmation run: those targets are deterministic file readers
#   with no build, no network and no clock, so the flake rule the SSE oracle
#   needs would only double the cost.
#
#   Since built and filled out: guard-shapes and finish-mark-order are rows
#   and are driven; make-dollars is NOT, and the sketch was wrong to list it -
#   a row that mutates the file it is stored in cannot report STALE or repair
#   a leftover, because its own table entry is a second copy of the needle it
#   searches for.  The reasoning is written out above MUTANTS_GUARD.
#
#   And one oracle that is NOT a tree reader has since been added:
#   `variant-fence` runs `swiftc -typecheck` four times.  The sentence above
#   still holds for it, for the reason it gave rather than by luck - no
#   network, no clock, no build products, same inputs and same compiler give
#   the same answer - so it needs no confirmation run either.  What it does not
#   inherit is the cost: 1.5s per consultation, twice per row.
#
#   The sketched row shape has since grown a fifth field, so the live shape is
#
#       MUTANTS_GUARD := source@@needle@@replacement@@target@@parse@@name
#
#   where `parse` is one of four values - `typechecks`, `must-not-typecheck`,
#   `parses`, `must-not-parse` - checked inside the mutation window, before
#   the target is consulted, with `swiftc -parse` on the one file and
#   `swiftc -typecheck` over the whole app module.  Which values a row may use
#   is not its own choice; it is read off the app build's source list.  The
#   sketch above was missing the field entirely, and that omission is exactly
#   the hole it left: with a tree-reader as the oracle, a mutant that does not
#   compile scores "ok - caught" for the wrong reason and nothing notices.
#   Written out above MUTANTS_GUARD, along with what each instrument does and
#   does not see.
#
#   Two would still not fit even that.  empty-sources needs an operation other
#   than substitution - smallest form, a sentinel replacement such as
#   <TRUNCATE> meaning "write zero bytes" rather than "replace the needle".
#   The warning gate needs a third oracle, a full `make dev` plus
#   `warning-gate WARN_LOG=<that build's log>`, because its evidence is a build
#   log and not the exit status of a tree reader; one row costs a whole dev
#   build, so price it before adding one.
#
# One row shape was considered and REJECTED: a mutation that opens a keychain
# door by overwriting an identifier the suite counts in a BR-OUTPUT view.  It
# would print "ok - caught", and the catch would be for the deleted call site,
# not for the open door.  A row that scores the right verdict for the wrong
# reason is the same lie as scoring a flake as coverage.
#
# Rows added by that pass: none.  A row that cannot end `make mutants` green
# is not a row.
MUTANTS := \
	rings/SR-02/QueenDelegationRegistry.swift@@            ownedPaths: ownedPaths,@@            ownedPaths: [],@@a delegated task is created without its owned-path boundary - the live-proven "bound to an issue and owned paths" MVP criterion attacked at its root \
	rings/SR-02/ChatViewModel.swift@@            let evidence = "\n\n" + QueenAcceptancePolicy.table(@@            let evidence = ""; _ = QueenAcceptancePolicy.table(@@the acceptance notice carries no evidence table - the live-proven "cannot accept without evidence" MVP criterion attacked at its voice \
	rings/SR-00/QueenObserver.swift@@lowered.contains("write") || lowered.contains("edit")@@lowered.contains("write")@@the boundary detector forgets edit-shaped tools \
	rings/SR-02/QueenDelegationRegistry.swift@@if criteria.contains(criterion) {@@if true {@@a verdict is accepted for a criterion the task never had \
	rings/SR-00/QueenDelegation.swift@@task.streamOutcome == .open@@false // gutted: no stream is ever open@@the reaper stops believing any stream is open and takes live workers mid-answer \
	rings/SR-00/QueenDelegation.swift@@task.streamOutcome == nil && (task.completedTurns ?? 0) == 0@@(task.completedTurns ?? 0) == 0 // gutted: turn count alone@@never-started is decided on turn count alone, so every running worker without a finished turn is an orphan \
	rings/SR-00/QueenReviewDigest.swift@@QueenDelegationPolicy.hasGoneSilent($$0, now: now, threshold: threshold)@@now.timeIntervalSince($$0.updatedAt) >= threshold // gutted: the clock again@@the hourly digest measures silence on updatedAt again and announces live workers as stalled while the reaper leaves them alone \
	rings/SR-00/QueenTaskSpec.swift@@lines.append(QueenBranchPolicy.ownershipRule(branch: branch))@@lines.append("")@@the specification stops telling the worker to leave the branch alone \
	rings/SR-00/QueenObserver.swift@@observedWrites.forEach(consider)@@_ = observedWrites@@the observer ignores what git measured and trusts tool names again \
	rings/SR-02/QueenBranchCommitter.swift@@guard !prefix.isEmpty, normalized.hasPrefix("\(prefix)/") else { return normalized }@@guard !prefix.isEmpty else { return normalized }@@a measured path is stripped whether or not it carries the prefix \
	rings/SR-01/SkillStore.swift@@!disabledIDs.contains(skill.id)@@true@@a switched-off skill reports itself as on \
	rings/SR-00/QueenSystemPrompt.swift@@tools: \(forbidden).@@tools of that kind.@@the Queen is no longer told which tools she may not call, only that some exist \
	BR-OUTPUT/GitHubAPIClient.swift@@"merge_method": "squash"@@"merge_method": "merge"@@the merge payload asks for a merge commit instead of a squash \
	BR-OUTPUT/GitHubAPIClient.swift@@if let sha {@@if false {@@the merge payload forgets the reviewed commit SHA \
	BR-OUTPUT/GitHubAPIClient.swift@@if statusCode == 200 {@@if statusCode == 299 {@@a successful merge is read as something other than merged \
	BR-OUTPUT/GitHubAPIClient.swift@@if statusCode == 409 {@@if statusCode == 499 {@@a 409 head-moved is folded into a generic refusal \
	BR-OUTPUT/GitHubAPIClient.swift@@mergeable == false || mergeState == "dirty"@@mergeState == "dirty"@@a mergeable=false signal stops being classified as a conflict \
	BR-OUTPUT/GitHubAPIClient.swift@@list.first { $$0.head?.ref == expectedBranch }@@list.first@@the first pull request is adopted without verifying its branch ref \
	BR-OUTPUT/GitHubAPIClient.swift@@"commit_title": title@@"commit_title": ""@@the merge payload loses its commit title

# Scoring contract, shared by all three mutation targets (#1262).
#
# A non-zero exit is NOT evidence that a mutation was caught. The SSE script
# exits non-zero when it cannot compile, cannot take the build lock, or dies
# before a single test runs - and scoring that as "ok - caught" made a green
# mutation run mean nothing. Proof: `exit 1` at the top of the script, so no
# test ran at all, still printed "ok - caught" and "[OK] every mutation was
# caught".
#
# So the output is captured and read, and only positive evidence counts:
#   "test(s) failed"                     -> the suite ran and failed: caught.
#   "All ChatSSEEndToEnd tests passed"   -> the suite ran and passed: SURVIVED.
#   neither                              -> the suite never ran: ERROR, and the
#                                           first lines of the captured output
#                                           are printed so the cause is visible.
# ERROR and SURVIVED both fail the target. Silence is not a pass.
#
# The logic targets read the same way from the clade-e2e report: only the
# "(<suite>) FAILED" verdict is a catch, only "(<suite>): passed" is a
# survivor, and "compile failed" or a missing report is a suite that never ran.
#
# One failure is not a catch (#1263). Once "caught" keys on "test(s) failed", a
# flaky suite is indistinguishable from a mutation the suite noticed: the gate
# would score its own flake as coverage. So the failure must REPEAT. On the
# first failing run the suite is run once more with the mutation still applied:
#   fails again  -> caught.
#   passes       -> FLAKY, and that fails the target. It is not a catch; it is
#                   evidence the suite is unreliable, which is worse news than
#                   a survivor and must not be scored as coverage.
#   neither      -> the confirmation run never ran: ERROR, also a failure.
# The cost is paid only by a catch, which then costs two suite runs instead of
# one. That is the intended trade: the slow, explicit mutation targets buy a
# verdict that a single flake cannot forge.
.PHONY: mutants mutants-logic mutants-changed
mutants:
	@backup=$$(mktemp -d); \
	: "ONE POLICY FOR ONE LOCK, 2026-08-25. This target used to refuse the"; \
	: "lock instantly and exit 1, while printing 'Nothing here is broken'."; \
	: "Both statements were true and together they made make check red for a"; \
	: "scheduling collision - a gate that fails while announcing it is not a"; \
	: "failure. Measured over four consecutive rounds: the same check came"; \
	: "back either fifty minutes late (cassettes waited) or instantly red"; \
	: "(this refused), for the same cause, on the same lock."; \
	: "Waiting is right here for the same reason it is right for cassettes:"; \
	: "both runs are legitimate, neither agent knows about the other, and"; \
	: "this target mutates real source files so it must not run beside one."; \
	: "Exiting 0 was the other option and is worse - make check would go"; \
	: "green without the mutation coverage having run, which is UNCHECKED"; \
	: "reported as agreement, the defect this repository pays for most."; \
	waited=0; \
	while :; do \
		owner_pid=$$(cat "$(HARNESS_LOCK)/pid" 2>/dev/null || true); \
		if mkdir "$(HARNESS_LOCK)" 2>/dev/null; then break; fi; \
		if [ -n "$$owner_pid" ] && ! kill -0 $$owner_pid 2>/dev/null; then \
			echo "[INFO] reclaiming harness lock from dead PID $$owner_pid"; \
			rm -rf "$(HARNESS_LOCK)"; continue; \
		fi; \
		if [ $$waited -ge $(HARNESS_LOCK_WAIT) ]; then \
			echo "[FAIL] another harness run has held $(HARNESS_LOCK) for $(HARNESS_LOCK_WAIT)s"; \
			echo "       (owner PID $$owner_pid). Not waiting further."; \
			rm -rf $$backup; exit 1; \
		fi; \
		if [ $$waited = 0 ]; then \
			echo "[mutants] another harness run holds the lock (PID $$owner_pid); waiting"; \
		fi; \
		sleep 5; waited=$$((waited + 5)); \
	done; \
	[ $$waited -gt 0 ] && echo "[mutants] acquired the harness lock after $${waited}s" || true; \
	echo $$$$ > "$(HARNESS_LOCK)/pid"; \
	trap 'for f in $$backup/*.bak; do [ -e "$$f" ] || continue; \
	      target=$$(cat "$$f.path"); \
	      cp "$$f" "$(ROOT)/$$target"; \
	      expected=$$(cat "$${f}.sha" 2>/dev/null); \
	      if [ -n "$$expected" ]; then \
		      actual=$$(shasum "$(ROOT)/$$target" | cut -d" " -f1); \
		      if [ "$$actual" != "$$expected" ]; then \
			      echo "[FAIL] restore checksum mismatch for $$target" >&2; \
		      fi; \
	      fi; done; \
	      rm -rf $$backup; \
	      rm -rf "$(HARNESS_LOCK)" 2>/dev/null' EXIT INT TERM; \
	fail=0; n=0; \
	: "Records are separated by ~ and fields by @@. A vertical bar cannot be \
	   the record separator: the first needle contains || and split itself in \
	   half, which the stale check caught rather than letting it pass."; \
	IFS='~'; for entry in $$(echo '$(MUTANTS)' | sed 's/ rings\//~rings\//g; s/ BR-OUTPUT\//~BR-OUTPUT\//g'); do \
		unset IFS; \
		src=$$(echo "$$entry" | awk -F'@@' '{print $$1}'); \
		needle=$$(echo "$$entry" | awk -F'@@' '{print $$2}'); \
		repl=$$(echo "$$entry" | awk -F'@@' '{print $$3}'); \
		name=$$(echo "$$entry" | awk -F'@@' '{print $$4}'); \
		n=$$((n + 1)); \
		cp "$(ROOT)/$$src" "$$backup/$$n.bak"; echo "$$src" > "$$backup/$$n.bak.path"; \
		shasum "$(ROOT)/$$src" | cut -d" " -f1 > "$$backup/$$n.bak.sha"; \
		MUT_SRC="$(ROOT)/$$src" MUT_OLD="$$needle" MUT_NEW="$$repl" python3 -c \
			'import os,sys; p=os.environ["MUT_SRC"]; s=open(p).read(); o=os.environ["MUT_OLD"]; n=os.environ["MUT_NEW"]; open(p,"w").write(s.replace(o,n,1)) if o in s else (open(p,"w").write(s.replace(n,o,1)),sys.exit(2))[1] if n in s else sys.exit(1)'; rc=$$?; \
		case $$rc in \
			2) echo "  LEFTOVER MUTATION - $$name (repaired: replacement was in $$src without its needle)"; \
			   cp "$(ROOT)/$$src" "$$backup/$$n.bak"; shasum "$(ROOT)/$$src" | cut -d" " -f1 > "$$backup/$$n.bak.sha"; \
			   MUT_SRC="$(ROOT)/$$src" MUT_OLD="$$needle" MUT_NEW="$$repl" python3 -c \
			   'import os,sys; p=os.environ["MUT_SRC"]; s=open(p).read(); o=os.environ["MUT_OLD"]; open(p,"w").write(s.replace(o,os.environ["MUT_NEW"],1))' ;; \
			1) echo "  STALE - $$name (its needle is no longer in $$src)"; fail=1; \
			   cp "$$backup/$$n.bak" "$(ROOT)/$$src"; continue ;; \
		esac; \
		shasum "$(ROOT)/$$src" | cut -d" " -f1 > "$$backup/$$n.mut.sha"; \
		out=$$(bash "$(ROOT)/tests/swift/run_chat_sse_e2e.sh" 2>&1 || true); \
		if echo "$$out" | grep -qF "test(s) failed"; then \
			: "One failure could be the suite's own flake. Confirm it with a \
			   second run, mutation still applied."; \
			out2=$$(bash "$(ROOT)/tests/swift/run_chat_sse_e2e.sh" 2>&1 || true); \
			if echo "$$out2" | grep -qF "test(s) failed"; then \
				echo "  ok   - caught: $$name (failed twice)"; \
			elif echo "$$out2" | grep -qF "All ChatSSEEndToEnd tests passed"; then \
				echo "  FLAKY - the suite failed once and passed once with the mutation applied: $$name"; fail=1; \
			else \
				echo "  ERROR - the confirmation run never ran: $$name"; fail=1; \
				echo "$$out2" | head -5 | sed 's/^/         | /'; \
			fi; \
		elif echo "$$out" | grep -qF "All ChatSSEEndToEnd tests passed"; then \
			echo "  SURVIVED - $$name"; fail=1; \
		else \
			echo "  ERROR - the suite never ran: $$name"; fail=1; \
			echo "$$out" | head -5 | sed 's/^/         | /'; \
		fi; \
		if [ -f "$$backup/$$n.mut.sha" ]; then \
			now_sha=$$(shasum "$(ROOT)/$$src" | cut -d" " -f1); \
			if [ "$$now_sha" != "$$(cat "$$backup/$$n.mut.sha")" ]; then \
				echo "  [FAIL] $$src changed while the harness held it mutated."; \
				echo "         Restoring the backup would silently revert whoever wrote to it."; \
				echo "         The mutation is left in place; resolve by hand. Backup: $$backup/$$n.bak"; \
				fail=1; continue; \
			fi; \
		fi; \
		cp "$$backup/$$n.bak" "$(ROOT)/$$src"; \
	done; \
	if [ $$fail -eq 0 ]; then echo "[OK] every mutation was caught ($$n)"; \
	else echo "[FAIL] a mutation survived, went stale, or failed only once"; exit 1; fi

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
	: "ONE POLICY FOR ONE LOCK, 2026-08-25 (second pass). Six targets use"; \
	: "this lock. cassettes waited; the other five refused instantly and"; \
	: "exited 1 while printing Nothing here is broken - a gate that fails"; \
	: "for a scheduling collision while announcing it is not a failure."; \
	: "The first pass fixed ONE of the five, because I counted two users"; \
	: "and never counted the rest. Waiting is right for all of them: the"; \
	: "runs are legitimate, neither agent knows about the other, and these"; \
	: "targets mutate real source files. Exiting 0 would be worse - check"; \
	: "green without the coverage having run is UNCHECKED read as agreed."; \
	waited=0; \
	while :; do \
		owner_pid=$$(cat "$(HARNESS_LOCK)/pid" 2>/dev/null || true); \
		if mkdir "$(HARNESS_LOCK)" 2>/dev/null; then break; fi; \
		if [ -n "$$owner_pid" ] && ! kill -0 $$owner_pid 2>/dev/null; then \
			echo "[INFO] reclaiming harness lock from dead PID $$owner_pid"; \
			rm -rf "$(HARNESS_LOCK)"; continue; \
		fi; \
		if [ $$waited -ge $(HARNESS_LOCK_WAIT) ]; then \
			echo "[FAIL] another harness run has held $(HARNESS_LOCK) for $(HARNESS_LOCK_WAIT)s"; \
			echo "       (owner PID $$owner_pid). Not waiting further."; \
			rm -rf $$backup; exit 1; \
		fi; \
		if [ $$waited = 0 ]; then \
			echo "[harness] another run holds the lock (PID $$owner_pid); waiting"; \
		fi; \
		sleep 5; waited=$$((waited + 5)); \
	done; \
	[ $$waited -gt 0 ] && echo "[harness] acquired the lock after $${waited}s" || true; \
	echo $$$$ > "$(HARNESS_LOCK)/pid"; \
	trap 'for f in $$backup/*.bak; do [ -e "$$f" ] || continue; \
	      target=$$(cat "$$f.path"); \
	      cp "$$f" "$(ROOT)/$$target"; \
	      expected=$$(cat "$${f}.sha" 2>/dev/null); \
	      if [ -n "$$expected" ]; then \
		      actual=$$(shasum "$(ROOT)/$$target" | cut -d" " -f1); \
		      if [ "$$actual" != "$$expected" ]; then \
			      echo "[FAIL] restore checksum mismatch for $$target" >&2; \
		      fi; \
	      fi; done; \
	      rm -rf $$backup; \
	      rm -rf "$(HARNESS_LOCK)" 2>/dev/null' EXIT INT TERM; \
	fail=0; n=0; \
	IFS='~'; for entry in $$(echo '$(MUTANTS_LOGIC)' | sed 's/ rings\//~rings\//g; s/ BR-OUTPUT\//~BR-OUTPUT\//g'); do \
		unset IFS; \
		src=$$(echo "$$entry" | awk -F'@@' '{print $$1}'); \
		needle=$$(echo "$$entry" | awk -F'@@' '{print $$2}'); \
		repl=$$(echo "$$entry" | awk -F'@@' '{print $$3}'); \
		suite=$$(echo "$$entry" | awk -F'@@' '{print $$4}'); \
		name=$$(echo "$$entry" | awk -F'@@' '{print $$5}'); \
		n=$$((n + 1)); \
		cp "$(ROOT)/$$src" "$$backup/$$n.bak"; echo "$$src" > "$$backup/$$n.bak.path"; \
		shasum "$(ROOT)/$$src" | cut -d" " -f1 > "$$backup/$$n.bak.sha"; \
		MUT_SRC="$(ROOT)/$$src" MUT_OLD="$$needle" MUT_NEW="$$repl" python3 -c \
			'import os,sys; p=os.environ["MUT_SRC"]; s=open(p).read(); o=os.environ["MUT_OLD"]; n=os.environ["MUT_NEW"]; open(p,"w").write(s.replace(o,n,1)) if o in s else (open(p,"w").write(s.replace(n,o,1)),sys.exit(2))[1] if n in s else sys.exit(1)'; rc=$$?; \
		case $$rc in \
			2) echo "  LEFTOVER MUTATION - $$name (repaired: replacement was in $$src without its needle)"; \
			   cp "$(ROOT)/$$src" "$$backup/$$n.bak"; shasum "$(ROOT)/$$src" | cut -d" " -f1 > "$$backup/$$n.bak.sha"; \
			   MUT_SRC="$(ROOT)/$$src" MUT_OLD="$$needle" MUT_NEW="$$repl" python3 -c \
			   'import os,sys; p=os.environ["MUT_SRC"]; s=open(p).read(); o=os.environ["MUT_OLD"]; open(p,"w").write(s.replace(o,os.environ["MUT_NEW"],1))' ;; \
			1) echo "  STALE - $$name (its needle is no longer in $$src)"; fail=1; \
			   cp "$$backup/$$n.bak" "$(ROOT)/$$src"; continue ;; \
		esac; \
		: "clade-e2e prints the report path on stdout and its own summary on \
		   stderr AFTER it, so the two streams are captured separately: \
		   merging them would make tail -1 the summary, not the path."; \
		e2e_out="$$backup/$$n.clade-e2e.out"; e2e_err="$$backup/$$n.clade-e2e.err"; \
		(cd "$(ROOT)" && cargo run --quiet --bin clade-e2e) >"$$e2e_out" 2>"$$e2e_err" || true; \
		report=$$(tail -1 "$$e2e_out"); \
		if [ -f "$$report" ] && grep -qF "[FAIL] Swift logic tests ($$suite) FAILED" "$$report"; then \
			: "One failure could be the suite's own flake. Confirm it with a \
			   second run, mutation still applied."; \
			e2e_out2="$$backup/$$n.clade-e2e.confirm.out"; e2e_err2="$$backup/$$n.clade-e2e.confirm.err"; \
			(cd "$(ROOT)" && cargo run --quiet --bin clade-e2e) >"$$e2e_out2" 2>"$$e2e_err2" || true; \
			report2=$$(tail -1 "$$e2e_out2"); \
			if [ -f "$$report2" ] && grep -qF "[FAIL] Swift logic tests ($$suite) FAILED" "$$report2"; then \
				echo "  ok   - caught by $$suite: $$name (failed twice)"; \
			elif [ -f "$$report2" ] && grep -qF "[OK] Swift logic tests ($$suite): passed" "$$report2"; then \
				echo "  FLAKY - the suite failed once and passed once with the mutation applied: $$name"; fail=1; \
			else \
				echo "  ERROR - the confirmation run of $$suite never ran: $$name"; fail=1; \
				cat "$$e2e_err2" "$$e2e_out2" | head -5 | sed 's/^/         | /'; \
			fi; \
		elif [ -f "$$report" ] && grep -qF "[OK] Swift logic tests ($$suite): passed" "$$report"; then \
			echo "  SURVIVED - $$name"; fail=1; \
		else \
			echo "  ERROR - the $$suite suite never ran: $$name"; fail=1; \
			cat "$$e2e_err" "$$e2e_out" | head -5 | sed 's/^/         | /'; \
		fi; \
		if [ -f "$$backup/$$n.mut.sha" ]; then \
			now_sha=$$(shasum "$(ROOT)/$$src" | cut -d" " -f1); \
			if [ "$$now_sha" != "$$(cat "$$backup/$$n.mut.sha")" ]; then \
				echo "  [FAIL] $$src changed while the harness held it mutated."; \
				echo "         Restoring the backup would silently revert whoever wrote to it."; \
				echo "         The mutation is left in place; resolve by hand. Backup: $$backup/$$n.bak"; \
				fail=1; continue; \
			fi; \
		fi; \
		cp "$$backup/$$n.bak" "$(ROOT)/$$src"; \
	done; \
	if [ $$fail -eq 0 ]; then echo "[OK] every logic-suite mutation was caught ($$n)"; \
	else echo "[FAIL] a logic-suite mutation survived, went stale, failed only once, or was not measured"; exit 1; fi

# --- Mutations whose oracle is a standing check, not a suite -------------
#
# This is the sibling table sketched in "What this table CANNOT ask, and why"
# above `MUTANTS`.  The audit there ended with seven checks whose "what event
# makes this red?" the SSE table cannot ask, and one sentence explaining all
# seven: a standing check exists precisely BECAUSE the compiler and the suite
# cannot see the failure it guards, which read backwards is "its failure
# cannot be scored against the suite".
#
# So do not score it against the suite.  Score it against the check.
#
#   MUTANTS_GUARD := source@@needle@@replacement@@target@@parse@@name
#
# Fields are separated by `@@`, rows by a literal `~`, the way GUARDS does it.
# Rows used to be split by guessing a record boundary from the leading path -
# a fixed list of ` rings/`, ` BR-OUTPUT/` and ` tests/` - which had two ways
# to lie the moment a row named a file outside that list: `main.swift` would
# have been swallowed into its predecessor's label, and any row whose LABEL
# contained the words " main.swift" would have been split in half.  Row 7 is
# a main.swift row whose label names main.swift, so both were live.
#
# `replacement` is normally the text the needle becomes.  When it begins with
# `<DELETE-BLOCK>` it is not a substitution at all - see "The second
# operation" below.
#
# Per row, in order:
#   1. `make <target>` BEFORE the mutation.  It must exit 0 and print an [OK].
#      This is not ceremony.  A target that is ALREADY red returns non-zero
#      after the mutation too, and the row would print "caught" for a machine
#      that never noticed anything - a forged catch, which is the same lie as
#      scoring a flake as coverage.  A row that cannot establish a green
#      baseline REFUSES to score, and refusing fails the target.
#   2. Apply the mutation (same stale / leftover-mutation handling as above).
#   3. `make <target>` again.
#         non-zero and it printed [FAIL]  -> caught.
#         zero and it printed [OK]        -> SURVIVED.
#         anything else                   -> ERROR, first lines shown.
#      The exit status alone is not read, for the reason the SSE contract
#      gives: a target that dies before it checks anything also exits
#      non-zero.  Positive evidence, or no verdict.
#
# No confirmation run.  `make mutants` repeats a failure because the SSE suite
# can flake and a flake would be scored as coverage; these targets are
# deterministic readers of the tree - no build, no network, no clock - so the
# second run can only restate the first, and would double the cost to buy
# nothing.  That difference is exactly why they can be scored this way and the
# suite cannot.
#
# Kept out of `check`, like the other two: it writes to tracked sources.  It
# shares the harness lock, the backup-and-restore trap with checksum
# verification, and the concurrent-write guard from b4d1946fe - if the source
# changed while the harness held it mutated, the mutation is LEFT in place and
# named, because restoring would silently revert whoever wrote to it.
#
# The first two rows below are the two the audit measured as impossible for the
# SSE table and trivial here:
#
#   keychain-doors  A real SecItemCopyMatching call in a file that imports
#                   Security and is not on KEYCHAIN_ALLOWLIST.  Against the
#                   suite this printed SURVIVED: the suite runs with
#                   TRIOS_E2E_DISABLE_KEYCHAIN=1 and is keychain-blind by
#                   construction.  Against `make keychain-doors` it is caught.
#
#   parse-tests     The func keyword dropped from a test source that the app
#                   build never compiles - the exact case parse-tests was
#                   written for, and the exact case the SSE table scored
#                   SURVIVED.  A syntax error in a file nobody compiles is
#                   invisible to a suite and plain to a parser.
#
# The next two are the standing checks whose red state a substitution CAN
# express.  Both needed the same one-line change to their oracle first: they
# printed `  ok` and `  FAIL`, never a bracketed verdict, so the positive-
# evidence rule above could not read them and every row against them would
# have scored ERROR.  A target that wants to be an oracle has to say [OK] or
# [FAIL] out loud.
#
#   finish-mark-order  The completed-turn mark deleted from runner.onFinish.
#                      Note WHICH arm this drives.  The literal #1248
#                      regression - the call moving INSIDE the deferred Task -
#                      is already driven on every run by the target's own
#                      fixture, and cannot be a row anyway: moving a line is
#                      two edits and a row is one substitution, with no way to
#                      write the newline between them.  What no fixture can
#                      show is that the arm reading the REAL source is still
#                      wired to the real source; that is what this row scores,
#                      and deleting the call is the smallest edit that asks it.
#
#   guard-shapes       Guard 6 removed from ChatViewModel.swift: the reaper's
#                      `guard !isStreamOpen(current) else { continue }` becomes
#                      a bare `_ = isStreamOpen(current)` - predicate still
#                      consulted, answer thrown away, live workers taken
#                      mid-answer.  It was for a while the ONLY guard with a
#                      row, because substitution is a one-line edit and guard 6
#                      is the only one of the seven that is a one-line
#                      statement: replacing the first line of a multi-line
#                      `guard ... else {` orphans its brace, and the mutant
#                      does not compile.  A row whose mutant does not compile
#                      proves nothing (see the fifth field below).  The block
#                      operations lifted that limit: <DELETE-BLOCK> gave guards
#                      2, 3 and 7 rows, and <UNWRAP-BLOCK> gave the last three -
#                      1, 4 and 5 - so all seven guards are now driven.  A
#                      compiler cannot see a missing guard, which is the whole
#                      reason guard-shapes exists; here that is measured, not
#                      argued.
#
# --- The second operation: <DELETE-BLOCK> --------------------------------
#
# A row whose replacement begins `<DELETE-BLOCK>` does not substitute.  It
# removes the needle line and everything up to and including the brace that
# closes it.  The text after the sentinel is an ANCHOR, and the needle chosen
# is the occurrence NEAREST ABOVE it - the same lookup guard-shapes does.
# That is not decoration.  Two of the seven needles are ambiguous by plain
# first-match: `guard ProjectPaths.isDevVariant else {` is a prefix of guard
# 2's own line, so a first-match delete for guard 3 would have removed guard
# 2 instead; and `guard RecursionGuard.shared.ensureSingleInstance() else {`
# appears twice in main.swift, at line 31 in applicationDidFinishLaunching and
# at 1198 in the boot path, and only the second is the one row 7 scores.  A
# first-match delete there removes a guard nobody is scoring, guard-shapes
# stays green, and the row prints SURVIVED - a false alarm rather than a
# forged catch, but still an answer about the wrong code.
#
# Brace matching is lexical, not a character count.  Line comments, nested
# block comments, escapes, raw strings of any hash count, multiline strings
# and `\(...)` interpolation are all tracked, so a brace inside a string is
# not a brace - while a brace inside an interpolation IS one, because that is
# code again.
#
# Measured, and worth saying plainly: none of the seven guards CURRENTLY hides
# a brace in a string or a comment, so on this tree today a naive counter
# would give the same answer.  The reason to be lexical anyway is that "today"
# is not a property of the checker.  A guard line grows a string with a brace
# in it and the naive version starts deleting the wrong span, silently, in a
# harness whose entire job is to be trusted while it edits tracked sources.
#
# What proves the claim is tests/fixtures/delete-block-braces.swift, which
# exercises each rule at least once: `{` inside the guard line's own string,
# `}` in a line comment, `}` in a plain string, `{`/`}` in a block comment,
# `}` in a raw string with a hashed escape, `{`/`}` in a multiline string, and
# a `{ item in item }` closure inside an interpolation followed by a `}` still
# in the string.  Driven: a character counter closes that guard nine lines
# early, on the first `log(...)`; the matcher closes it on the guard's own
# brace, deleting lines 16-27.  mutants-guard runs that fixture against
# delete-block-braces.expected.swift BEFORE the table, and if the two differ
# no row runs at all.
#
# It refuses instead of guessing when it meets a shape it does not handle:
# code before the needle on its line, code after the closing brace on its
# line (`} else {`), or a source that does not lex.  Driven: a row aimed at
# `if let client = a2aClient {`, whose block closes into an `} else {`,
# prints "BROKEN ROW ... code follows the closing brace on its line" and
# writes nothing.
#
# Which guards this fits, and which it does not:
#
#   guards 2, 3, 7  Fit, and have rows.  Each is a `guard ... else { ... }`
#                   whose else-body is the bail-out, so deleting the whole
#                   statement is exactly the dangerous edit - the protection
#                   goes, the function runs on - and the guard-shapes ANCHOR,
#                   which sits after the guard, survives to be found.  Driven:
#                   all three flip guard-shapes from GUARDED to UNGUARDED.
#
#   guards 1, 4, 5  Do NOT fit THIS operation, and take <UNWRAP-BLOCK> below
#                   instead.  All three are `if <dev-only> { ... }`, and their
#                   guard-shapes anchor sits INSIDE the block:
#                   `queenInboxPollTask = Task` at 441 within 437-448,
#                   `DevSecretStore.read(...)` at 76 within 75-80, `return try
#                   loadOrCreateTestKey()` at 204 within 203-205.  Deleting the
#                   block takes the anchor with it, and guard-shapes then
#                   answers NOANCHOR - "the guard table is stale" - not
#                   UNGUARDED.  That still exits non-zero, so the row WOULD
#                   print "ok - caught"; it would be scoring a stale table
#                   under the name of a missing guard.  Measured, not argued,
#                   and re-driven when the unwrap went in: the three deletions
#                   were applied to /tmp copies and guard-shapes, pointed at
#                   them, said "anchor ... is gone; the guard table is stale"
#                   for each, against "no 'if ProjectPaths.isDevVariant {'
#                   within 8 lines above ..." for the same three unwrapped.
#
#   guard 6         Keeps its substitution row.  Deleting `guard ... else
#                   { continue }` whole is legal, but the row already exists
#                   and gutting it is the sharper edit: the predicate is still
#                   called, so the mutant is indistinguishable from live code
#                   to anything but a shape check.
#
# What a delete row gives up: the leftover-mutation branch.  A deletion has no
# replacement text, so there is nothing to find in a file to tell a killed run
# from a clean tree.  It is not needed.  A leftover deletion leaves the guard
# MISSING, so guard-shapes is red, and the green-baseline check refuses the
# row by name before it touches anything.  That is also why exit 1 from the
# deleter means a stale table here and never a leftover.
#
# And the compile question, which parse alone cannot answer.  Deleting a block
# can break code that a substitution never would - `guard let x = ... else
# { return }` deleted whole leaves every later use of `x` undefined, which
# parses clean and does not typecheck.  None of guards 2, 3 and 7 binds
# anything, so none has that problem, but "none of them binds" is an argument
# and the fifth field only buys syntax.  So it was driven once, by hand: all
# three deletions applied to the real tree at once, `make dev` run over them,
# EXIT=0 with 0 warnings across the 3 files it recompiled, then both sources
# restored and verified by shasum and the dev app rebuilt from the restored
# tree.  That is a measurement of these three rows on this tree, not a gate:
# a build per row would cost minutes and buy, for rows that bind nothing,
# what a 0.2s parse already answers.  A row that ever deletes a block with a
# binding in it should pay for a build.
#
# --- The third operation: <UNWRAP-BLOCK> ---------------------------------
#
# A row whose replacement begins `<UNWRAP-BLOCK>` removes the needle line and
# its matching closing brace and KEEPS the body.  The block's contents start
# running unconditionally - which is not a variation on deleting the block, it
# is the opposite failure, and it is the accident guard-shapes was built for:
# a dev-only branch quietly becoming everybody's code path.
#
# It exists because the three guards <DELETE-BLOCK> could not reach need the
# anchor to SURVIVE.  Unwrapping leaves it exactly where it was, one line
# shallower, so guard-shapes answers UNGUARDED - the missing guard the row
# names - instead of NOANCHOR.  Driven, on /tmp copies of the three real
# sources, with guard-shapes itself as the instrument:
#
#   unwrapped   "no 'if ProjectPaths.isDevVariant {' within 8 lines above
#               'queenInboxPollTask = Task'"   ... and the same for 4 and 5
#   deleted     "anchor 'queenInboxPollTask = Task' is gone; the guard table
#               is stale"                      ... and the same for 4 and 5
#
# Everything up to the brace match is the DELETE-BLOCK code path: same lookup
# (the needle occurrence nearest above the anchor), same lexical matcher, same
# three refusals.  The operation is a flag on the same script, not a second
# copy of a brace matcher, because two matchers drift and only one of them
# would be the one the fixture proves.
#
# Where unwrapping is more dangerous than deleting, and what is done about it.
# A deletion that closes the block on the wrong line leaves a hole - the
# mutant does not compile and the type floor says so.  An unwrap that gets the
# span wrong SILENTLY EATS A LINE and can still compile: close one line early
# and a body line goes instead of the brace.  So three shapes are refused
# outright rather than guessed at, each driven in the self-test:
#
#   a one-line block            `if devOnly(...) { return false }` - the open
#                               and close are the same line, and removing it
#                               takes the body with it.
#   code before the closing     `return false }` - removing that line removes
#   brace on its line           the return.  DELETE-BLOCK accepts this shape
#                               (it removes the body anyway); unwrap must not.
#   an anchor outside the       the row would be unwrapping a block that does
#   block                       not contain the line it scores - which is the
#                               DELETE-BLOCK shape, written under the wrong
#                               operation.
#
# The self-test is therefore four arms, not one, and it runs before any row:
# tests/fixtures/unwrap-block-braces.swift carries the same string, comment,
# raw-string, multiline and interpolation hazards as the delete fixture, and
# the positive arm is diffed against unwrap-block-braces.expected.swift.  The
# three refusals must each exit 3, name their reason, and leave the copy they
# were handed byte-identical.  Driven: the positive arm reports "unwrapped
# lines 22 and 33, body kept".
#
# The compile question is sharper here than for a deletion and is answered the
# same way - by the type floor, on every run.  Unwrapping guards 4 and 5 makes
# a `return` unconditional, so the rest of each function becomes unreachable;
# that is a warning, not an error, and `swiftc -typecheck` stays green.  A
# mutant that broke the module would be a BROKEN ROW and guard-shapes would
# not be consulted at all.
#
# Two standing checks with a red state are still NOT here, each for its own
# reason:
#
#   empty-sources  A row is one text substitution and cannot take a file to
#                  zero bytes.  It keeps its red-driver in check-selftest,
#                  which truncates a real source with `: > file`.
#
#   make-dollars   Its only input is this Makefile, so its row would have to
#                  mutate the file the harness is executing - and that is not
#                  the objection, since the parent make has already parsed it
#                  and a mutation chosen to keep parsing is survivable.  The
#                  objection is self-reference: the row's needle and
#                  replacement would be STORED in the same file they search,
#                  so `needle in file` and `replacement in file` are both
#                  permanently true, and the two branches that read them stop
#                  working - a stale row could never report STALE (it would
#                  silently mutate its own table entry instead, the first
#                  occurrence being the one below), and the leftover-mutation
#                  repair could never fire.  A row that cannot go stale out
#                  loud is a row that forges verdicts later.  make-dollars
#                  also already has a driven red-driver in check-selftest,
#                  which appends a single-dollar recipe line to a COPY of the
#                  Makefile - the same event, scored where the oracle is the
#                  check itself and the table has no copy of the string.
#
# On a SUBSTITUTION row, needle and replacement are chosen so that neither
# contains the other, otherwise the leftover-mutation branch cannot tell a
# half-finished run from a clean tree.  `count: 32` becomes `count: 0x20` for
# that reason alone - same constant, different text.  A `<DELETE-BLOCK>` row
# has no replacement text and is exempt; what covers it instead is written out
# under "The second operation" below.
#
# The planted call is also chosen to COMPILE.  keychain-doors is a grep and
# does not care, but another agent may be building this tree inside the few
# seconds the mutation is applied, and a harness that hands a neighbour a
# broken source is buying its verdict with somebody else's build.  That used
# to be a choice and is now a measurement - see "The type floor" below - which
# matters more since the floor also lengthens the window a neighbour can build
# in, by the ~2s each mutant spends being typechecked.
#
# --- Does the mutant compile?  The fifth field ---------------------------
#
# "Chosen to compile" was, for three of these four rows, an ARGUMENT: each
# replacement uses only identifiers already in scope and throws the result
# away with `_ =`.  No compiler ever checked, which is the same shape as
# every other defect found in this harness - a claim about the world resting
# on reasoning rather than on a run.
#
# It matters more here than in the SSE table.  A mutant that does not compile
# sends the target red for a reason that is NOT the guard noticing, and the
# row prints "ok - caught" having proved nothing.  The SSE table survives
# that case by accident of its scoring contract: a suite that cannot build
# prints neither verdict and scores ERROR.  These targets are text readers.
# They never build anything.  Nothing here would have caught it.
#
# So every row now declares, in a fifth field, what its mutant must survive,
# and the loop checks that INSIDE the mutation window, BEFORE the target is
# consulted:
#
#   typechecks      the mutant must parse AND typecheck inside the app module.
#                   What almost every row on a compiled source wants; see
#                   "The type floor" below.
#   must-not-typecheck
#                   the mutant must parse and must NOT typecheck.  For a row
#                   whose subject is a type-level property: the mutation
#                   deliberately plants a TYPE error, and `typechecks` would
#                   call such a row BROKEN for doing precisely what it exists
#                   to do.  It is legal on the same files `typechecks` is and
#                   no others - a module is where the answer lives, in either
#                   direction - and it is checked BOTH ways: a mutant that
#                   does not PARSE is planting a syntax error rather than a
#                   type error, and a mutant that TYPECHECKS has not planted
#                   anything, so the target is not consulted about a mutation
#                   that did not happen.  One row uses it - `variant-fence`,
#                   whose subject is that a raw string cannot stand in for a
#                   BuildVariant; see "The value that got its row" below.
#   parses          the mutant must still parse, and nothing more can be asked
#                   of it because the file is in no module this Makefile can
#                   assemble.  If it does not parse, the row is BROKEN: the
#                   target is not run at all and the target fails.  A broken
#                   row is not a catch and must not be reported as one.
#   must-not-parse  the mutant must NOT parse.  Only parse-tests, whose whole
#                   subject is a syntax error in a source the app build never
#                   compiles.  Be honest about what the gate buys THERE: it
#                   is the same instrument as the oracle, so it does not
#                   independently confirm the catch - it asserts the row's
#                   premise, and would fire if the replacement were ever
#                   edited into something that parses, at which point the row
#                   would be scoring some other event under the old name.
#
# Which of the four a row may declare is not a matter of taste, and the loop
# does not take the row's word for it.  Before anything is written it asks the
# app build's own source list whether this file is compiled into the module:
# in it, and only `typechecks` or `must-not-typecheck` are allowed; out of it,
# and only `parses` or `must-not-parse` are.  A row that gets it wrong is
# BROKEN and no mutation is applied.  That is what keeps `parses` from being
# used as a shortcut on a file where a type answer is available, and it is
# measured rather than declared: the day tests/swift joins the app build, row 2
# says so out loud instead of quietly asking less than it could.
#
# The membership rule sorts the four into two pairs, and it is worth being
# exact about what that does and does not buy, because the fourth value is the
# first one it cannot tell from its neighbour.  Against the OTHER pair it is
# decisive: `must-not-typecheck` on a file the app build never compiles is
# BROKEN, so it can never be reached for as a way to skip the type instrument,
# which is the shortcut the rule exists to prevent.  Within its own pair it is
# silent by construction - membership answers "is a typecheck measurable
# here?", not "which way must it come out?" - so `typechecks` and
# `must-not-typecheck` are both legal on the same file and the source list
# cannot rank them.  What keeps the fourth value honest there is that it asks
# for MORE evidence than its neighbour rather than less: the mutant must parse
# AND the module must go red, both measured, and a row that claims a type
# error while its mutant typechecks is BROKEN with the target unconsulted.
# The residual, named rather than argued away: a row whose mutant fails to
# typecheck BY ACCIDENT could be flipped from `typechecks` to
# `must-not-typecheck` to turn a BROKEN ROW into a catch.  That is the same
# hazard `must-not-parse` carries against `parses`, where membership happens
# to close it and here it does not, and nothing this Makefile can run tells
# "the author meant it" from "the author gave up".  What the field buys is
# that the intent is written down in the row and enforced in both directions,
# so the flip is a visible edit to a declared expectation and not a silent
# pass.
#
# The instrument is `swiftc -parse` on the one mutated file.  What that does
# and does not see, driven on this machine rather than argued:
#
#   CAUGHT      syntax.  A dropped `func`, an unbalanced brace, a replacement
#               pasted in with the needle's trailing context lost.
#               `swiftc -parse` on a one-line file `func g( {` exits non-zero
#               and names the column.
#   NOT CAUGHT  types, scope and imports.  `_ = task.id` parses whether or
#               not `task` exists, whether or not it has an `id`, and whether
#               or not the file imports what the identifier needs.  A file
#               whose whole body is `_ = nonexistentThing` parses clean
#               (exit 0) and fails `-typecheck` with "cannot find in scope".
#
# So a parse proves the mutant is Swift.  It does not prove the mutant is the
# code the row's prose describes.  It was a floor, and it was named as one.
#
# `swiftc -parse` costs 0.13-0.21s per file here and runs twice per row -
# once on the pristine source, so a file that was ALREADY broken by somebody
# else is REFUSED rather than blamed on the row, and once on the mutant.
# Under two seconds across the whole table: driven, the target went from
# 16-26s before the gate to 24s and 29s with it.
#
# --- The type floor ------------------------------------------------------
#
# "The replacement uses only identifiers already in scope" stayed an argument
# after the parse gate went in, because a parse cannot see scope: `_ = task.id`
# parses whether or not `task` exists.  Three instruments were priced for that
# before, and the note here rejected all three.  Two of those rejections were
# right and one was wrong, so read them as a record of what was measured, not
# as a conclusion:
#
#   swiftc -typecheck on the ONE file.  Still unusable, and this is the arm
#   that misled the earlier pass into rejecting types altogether.  The rest of
#   the module is absent, so a PRISTINE source already fails: measured on this
#   tree, unmutated, rings/SR-02/AgentMemoryService.swift 28 errors in 0.7s
#   and tests/swift/queen_delegation_test.swift 190 errors in 2.5s.  There is
#   no green baseline for ONE FILE ALONE.  The step that was never taken was
#   to ask the same question of the whole module.
#
#   A whole-module typecheck.  This is the one that was wrongly dismissed, on
#   an argument rather than a number - that it would need build.sh's source
#   list and -I set copied here, where the copy would rot.  Measured instead,
#   on this tree: `swiftc -typecheck` over all 185 app sources is GREEN
#   (exit 0, 0 errors, the 4 known warnings) in 13.3-13.6s cold, and 0.48s
#   with `-incremental` and a warm state directory when nothing changed, 2.1s
#   when one file changed.  There IS a green baseline; it is the module, not
#   the file.  What the rot argument gets right is that a hand-copied source
#   list would rot - so nothing is copied: the list is READ from the dev
#   build's own output-file-map, the artifact `make dev` writes, and the flag
#   set is READ from build.sh's own flag print (`TRIOS_PRINT_FLAGS=1`, 0.4s,
#   compiles nothing) and passed to the typecheck whole, every -I directory of
#   which is checked to exist before a row runs.  Passing it whole rather than
#   keeping the -I pairs is measured, not argued: full set and -I-only set,
#   same 185 sources, both exit 0 with byte-identical diagnostics and the same
#   0.53s warm - swiftc ignores -L/-l under -typecheck without so much as an
#   unused-argument warning.  The flag set was the last thing here that WAS a
#   copy, and it had already drifted - it named Frameworks-dev/Modules while a
#   dev build compiles against SwiftPM's .build/.../debug/Modules.  A set that
#   is wrong cannot be silent now: either the print refuses by naming the
#   directory, or the pristine module typecheck below goes red and every row
#   REFUSES by name.
#
#   `make dev` per row.  Still not worth it: measured here, one incremental
#   `make dev` after touching rings/SR-02/ChatViewModel.swift took 80s, exit 0
#   - roughly 40x the 2.1s the incremental typecheck costs for the same file,
#   to answer the same question plus codegen and a link nobody here reads.
#
#   swift-frontend -typecheck -primary-file <mutant> <the other 184>.  Priced
#   because it looks like the surgical form of the same idea, and it is the
#   slowest of the lot: 53.2s, four times the whole-module driver run, which
#   batches.  Rejected on the number.
#
# So the fifth field's `typechecks` runs `swiftc -typecheck -incremental` over
# the whole app module, twice per row: once on the pristine tree, so a module
# somebody else broke is REFUSED rather than blamed on the row, and once on
# the mutant, where a mutant that parses and does not typecheck is a BROKEN
# ROW and the target is not consulted.
#
# `must-not-typecheck` is the same two runs read the other way round.  The
# pristine pass is needed for exactly the same reason and says exactly the
# same thing - a module already red cannot tell anyone what THIS mutation did,
# so the row is REFUSED - and the mutant pass scores the opposite outcome: red
# is the row's premise holding, green is a BROKEN ROW.  It costs a row no more
# than `typechecks` does, because it is the same instrument at the same two
# points; the fourth value buys a direction, not an extra measurement.
#
# What it costs, driven on this machine:
#
#   state directory empty (first run, or after it is deleted)   16.6-17.1s
#   nothing in the tree changed                                      0.48s
#   rings/SR-02/ChatViewModel.swift changed                          2.08s
#   main.swift changed                                               1.05s
#   rings/SR-02/AgentMemoryService.swift changed                     0.83s
#
# which is ~21s across the seven rows once warm - the same file typechecked
# twice per row, pristine and mutated, and four of the seven rows are the same
# file.  The whole target went from 21.3s on the run before this change to
# 56.7s with an empty state directory and 42.5s / 46.9s / 51.0s on the three
# warm runs after it.  The spread is machine load, not the gate; the honest
# summary is "roughly double, and under a minute".  It stays out of `make
# check` for the same reason it already did - it writes to tracked sources -
# so that price is paid by someone who asked for it.
#
# The state directory is $(TYPE_STATE), a sibling of the app build's object
# directory and NOT inside it: mixing a -typecheck dependency graph into the
# objects' graph would corrupt the build this gate exists to imitate.  It is
# 12 MB of .swiftdeps, under .trinity/build/ and therefore gitignored, and it
# is disposable - delete it and the next run refills it in 17s.
#
# The flags are written to $(TYPE_STATE)/typecheck.args and passed as a
# response file, and they are byte-stable on purpose.  Driven twice by
# accident: changing `-I ../Sources/CSQLCipher` to the same directory spelled
# absolutely, and dropping the SQLCipher include, each threw the incremental
# state away and turned a 0.48s run back into a 16.7-17.1s one.  A flag set
# that is rebuilt differently on each run is a gate that is never warm.
#
# Three honest limits, none of which can forge a catch:
#
#   - it needs a dev build to have happened.  The source list is the dev
#     build's output-file-map; with no such file the target FAILS at the top
#     and says to run `make dev`.  It does not fall back to parse-only, which
#     would be the same silent downgrade this section exists to remove.
#   - a source list stale since the last `make dev` (a file added or deleted
#     since) makes the pristine typecheck red, and every row REFUSES.  Loud,
#     and the message names the cause.
#   - it reads the WHOLE tree, so a neighbour writing any source mid-run can
#     turn a row REFUSED or BROKEN.  Wider exposure than the parse gate, which
#     reads one file - but both fail toward "no verdict", never toward a
#     verdict this harness did not earn.
#
# --- The value that got its row ------------------------------------------
#
# `must-not-typecheck` went in before anything declared it, and the section
# that stood here said so: the value was live vocabulary with no referent, and
# inventing a row to fill the gap would have been the same defect this harness
# keeps finding - a claim about the world with nothing behind it.  The honest
# way out was never to invent a row.  It was to find a duplicated value whose
# single symbol the COMPILER can defend, and build the missing check.
#
# That check is `variant-fence`, and its two rows are the last two in the table
# above.  Its subject: the build variant is a type, not a string.  `.trinity`
# vs `.trinity-dev`, Keychain vs DevSecretStore, 9105 vs 9205, the bundle id,
# the binary name and the Frameworks directory all fork on one `BuildVariant`
# value, and the only route from a String into that type is the failable
# `init?(rawValue:)`.  Nothing in this file can read that fact.  A compiler
# decides it in 1.5s.
#
# The row the value existed for:
#
#   BR-OUTPUT/ProjectPaths.swift@@static var isDevVariant: Bool
#       { variant == .dev }@@ ... { variant == "dev" }@@variant-fence@@
#       must-not-typecheck@@ ...    (one row; wrapped here to fit the margin)
#
# It reintroduces the literal where the enum case belongs - the line
# tools/ChatProbe.swift:30 already carries outside the module - and the mutant
# CANNOT compile, because `==` has no overload between a BuildVariant and a
# String.  That is not a broken mutant; it is the regression, stated in the
# only language that can state it.  Driven both ways below: declared
# `must-not-typecheck` it is "ok - caught by variant-fence"; declared
# `typechecks` it is "BROKEN ROW ... the mutant parses but does not typecheck"
# with the target never consulted.  Before the fourth value this row could not
# be written at all, which is precisely what the old section predicted.
#
# The second row is `typechecks` and it is not decoration.  A check whose
# negative arms assert "this does not compile" can rot in a direction the
# first row cannot reach: adding `ExpressibleByStringLiteral` to BuildVariant
# is one legal, COMPILING conformance that flips all three negative witnesses
# green at once and re-opens every raw-string fork in the tree.  Driven: the
# positive witness stays green, all three negatives print "TYPECHECKS ... the
# fence is gone".  One check, two rows, one per arm - and each row was scored
# against a target that cannot see it (row A against keychain-doors, row B
# against guard-shapes) and printed SURVIVED, so neither is being rubber-
# stamped by some incidental redness.
#
# The survey that produced "none of them" is kept below, because it is still
# true of every check that predates variant-fence, and it is the reason a new
# check had to be built rather than a row found:
#
#   keychain-doors      the presence of a SecItem* call outside an allowlist.
#                       Text.  Its mutant is a real, compiling call.
#   guard-shapes        a guard line within N lines above an anchor.  Shape.
#                       All seven guards are `if`/`guard` over a Bool with no
#                       bindings, so every deletion and unwrap of them
#                       typechecks - which is why its seven rows here say so.
#   finish-mark-order   the ORDER of two statements inside onFinish.  Line
#                       numbers.
#   parse-tests         syntax, in sources the app build never compiles - the
#                       far end of the vocabulary, not this end.
#   empty-sources       a tracked source's byte count.
#   vendor-step         a copied line inside a marked region of build.sh, a
#                       file swiftc never reads.
#   make-dollars,       already excluded above for reasons that have nothing
#   backlog-audit       to do with types.
#
# `drift-guard` was the only OTHER check whose subject is type-level - it
# proves QueenBranchCommitter.verifyCombinedBuild catches a signature mismatch
# - and it is still not a row: the mismatch it judges is between two scratch
# packages it builds itself, not between two states of this tree, so a
# mutation here has no lever on it.  Excluded above for its shape as well.
# That is the difference variant-fence had to be built with: it judges THIS
# tree's sources, so a mutation in them moves it.
#
# The two ways one could arrive at such a row.  The first is no longer a
# forecast - it is what variant-fence did - and it is left in the shape it was
# written in, because the prediction and the outcome agreeing is the evidence:
#
#   1. A check whose subject is genuinely type-level - say a guard asserting
#      that some call site keeps a particular signature, or that a type keeps
#      a conformance.  Its honest mutant CHANGES that signature or drops that
#      conformance, which breaks every caller in the module.  Under
#      `typechecks` the type floor calls such a row BROKEN for doing exactly
#      what it exists to do, so the row cannot be written at all and the check
#      has no mutation proving it works.  That is the hole this value fills.
#      Arrived at exactly this way: the fence asserts that a String cannot
#      become a BuildVariant, its mutant plants that conversion, and the flip
#      to `typechecks` was driven and prints the predicted BROKEN ROW.
#
#   2. empty-sources, which is not type-level but arrives at the same place.
#      Its subject is a source that went to zero bytes; per #1238 above, what
#      that actually produced was "cannot find QueenObserver in scope" - an
#      empty Swift file parses (driven: `swiftc -parse` on a zero-byte file
#      exits 0), and the module then fails to typecheck because the
#      declarations it exported are gone.  So its row is the first in this
#      table that would parse and could not typecheck.  It needs one more
#      thing than the vocabulary: the <TRUNCATE> operation sketched above
#      MUTANTS_LOGIC, since substitution cannot empty a file.  With both, the
#      row reads
#
#        rings/SR-00/QueenObserver.swift@@<any anchor>@@<TRUNCATE>@@
#            empty-sources@@must-not-typecheck@@a tracked source loses its
#            bytes            (one row; wrapped here to fit the margin)
#
#      and note what the fifth field is doing there that no other value could:
#      `typechecks` would be false, `parses` and `must-not-parse` are illegal
#      on a compiled file, and without a fourth value the row's only way in
#      would be to weaken the gate for everybody.
#
# Driven, this machine, all five arms (the first line's row count is from the
# run, and the table has grown since - see the block-operation arms below it):
#
#   - the table as it stands: four rows, all "ok - caught", exit 0.
#   - the guard-shapes replacement swapped for an unbalanced
#     `isStreamOpen(current` : "BROKEN ROW ... the mutant does not parse",
#     make guard-shapes NOT run, recipe exit 1 / make exit 2, and
#     ChatViewModel.swift restored byte-identical (shasum before == after).
#   - the SAME unbalanced replacement with its field flipped to
#     `must-not-parse`, so the gate is satisfied and the target IS consulted:
#     "ok - caught", exit 0.  That is what this table printed for an
#     uncompilable mutant before the fifth field existed, and it is the whole
#     reason the field exists.
#   - keychain-doors flipped to `must-not-parse` while its mutant parses:
#     "BROKEN ROW ... the mutant parses, and this row exists to plant a
#     syntax error".  A garbage field value (`maybe`) is a broken row too.
#   - a temporary row pointing at tests/fixtures/parse-fixture.swift, which
#     does not parse on a clean tree: "REFUSED ... does not parse BEFORE the
#     mutation", and the fixture's shasum unchanged, so nothing was written.
#
# Driven again when `<DELETE-BLOCK>` was added.  The negative arms were driven
# by overriding the table on the command line - `make mutants-guard
# MUTANTS_GUARD='...'` - so no temporary row was ever committed:
#
#   - the table as it stands: seven rows, all "ok - caught", exit 0, 32.6s.
#     The three new ones print "caught by guard-shapes", and the run before
#     them - the matcher's own fixture - prints "deleted lines 16-27".
#   - `git status --short rings/ BR-OUTPUT/ main.swift` empty after every run
#     below, including the ones that failed.
#   - a delete row whose ANCHOR was renamed away: "STALE ... - the anchor is
#     not in this source".  Its needle renamed away instead: "STALE ... - no
#     needle line above the anchor".  Two different faults, two different
#     sentences; the deleter's own words are appended to the verdict.
#   - a delete row aimed at `if let client = a2aClient {`, whose block closes
#     into `} else {`: "BROKEN ROW ... code follows the closing brace on its
#     line", nothing written, make exit 2.
#   - guard 2's deletion scored against `keychain-doors`, a target that cannot
#     see it: "SURVIVED", make exit 2.  A delete row is not rubber-stamped by
#     being a deletion.
#   - delete-block-braces.expected.swift edited to disagree with the matcher:
#     "[FAIL] the block deletion did not reproduce ...", the diff printed, and
#     NO row run.  The input fixture moved out of the way instead: "[FAIL] the
#     block-deletion fixtures are missing".  The harness lock was released on
#     both of those early exits.
#
# Driven a third time when the type floor went in.  Same method - the negative
# arms come from `make mutants-guard MUTANTS_GUARD='...'`, so nothing
# temporary was committed - and `git status --short rings/ BR-OUTPUT/
# main.swift` was empty after every one of them, including the failures:
#
#   - the table as it stands: seven rows, all "ok - caught", exit 0, 56.7s
#     with an empty state directory and 42.5s / 46.9s / 51.0s warm, against
#     21.3s for the same table on the run before the gate.
#   - guard 6's replacement changed to `_ =
#     QueenDelegationPolicy.isStreamOpenNoSuchMember(current)`, which PARSES
#     (swiftc -parse exit 0) and does not typecheck: "BROKEN ROW ... the
#     mutant parses but does not typecheck", the compiler's own "type
#     'QueenDelegationPolicy' has no member" line quoted underneath, make
#     guard-shapes NOT consulted, make exit 2.  That is the counterfactual the
#     whole floor exists for: before this, that mutant scored "ok - caught".
#   - the same row left at `typechecks` while the module was broken by a
#     THIRD file (an undefined identifier planted in rings/SR-00/
#     QueenObserver.swift): "REFUSED ... the app module does not typecheck
#     BEFORE the mutation", no mutation applied - ChatViewModel.swift
#     byte-identical by shasum - and make exit 2.
#   - row 1 flipped to `parses` on a file that IS in the module: "BROKEN ROW
#     ... IS compiled into the app module ... declare 'typechecks'", nothing
#     written.  Row 2 flipped to `typechecks` on a file that is NOT: "BROKEN
#     ROW ... is NOT compiled into the app module".  A garbage value
#     (`maybe`) is still a broken row, now caught before the mutation rather
#     than after it.
#   - `parses` is not dead vocabulary, and it was driven rather than reasoned
#     about: row 2's needle renamed to `issueParsingRenamed` - a mutant
#     OUTSIDE the module that stays valid Swift - was accepted by the
#     membership rule, parsed, and scored "SURVIVED" against parse-tests,
#     which is the right verdict for a rename a grep cannot see.  Not BROKEN:
#     the arm is live.
#   - the dev output-file-map pointed at a path that does not exist: "[FAIL]
#     no dev output-file-map ... Run 'make dev' once", no row run, harness
#     lock released.  Pointed instead at a copy naming one file that does not
#     exist - what a source list stale since the last build looks like:
#     "[FAIL] ... 1 of its 186 sources no longer exist, first: ...", no row
#     run, and the state directory NOT rewritten from the bad list.
#   - the include set made unresolvable with PKG_CONFIG_LIBDIR=/nonexistent,
#     which blinds pkg-config for one invocation and touches no shared state:
#     "[FAIL] the app module's include set cannot be resolved", the three
#     directories listed with `SQLCipher headers: NOT FOUND`, no row run,
#     harness lock released.
#
# Driven a fourth time when <UNWRAP-BLOCK> closed guards 1, 4 and 5.  Same
# method - every negative arm from `make mutants-guard MUTANTS_GUARD='...'`,
# nothing temporary committed - and `git status --short rings/ BR-OUTPUT/
# main.swift` empty after every run below, the failures included:
#
#   - the table as it stands: ten rows, all "ok - caught", exit 0, 53.8s /
#     55.3s / 57.4s on three warm runs, against 57.3s for the same table at
#     seven rows on the run before this change.  The three new rows cost
#     nothing this instrument can see - the spread between identical runs is
#     wider than the difference - because nine of the ten rows are the same
#     four files and the incremental typecheck is already warm for each.
#   - the operation's own self-test, which runs before any row: "block unwrap
#     keeps the body past strings and comments (unwrapped lines 22 and 33,
#     body kept)" and "block unwrap refuses 3 shapes that would eat code".
#   - the reason this operation exists, measured on /tmp copies of the three
#     real sources with guard-shapes itself as the instrument: unwrapped, it
#     says "no 'if ProjectPaths.isDevVariant {' within 8 lines above
#     'queenInboxPollTask = Task'" - UNGUARDED, the missing guard; deleted, it
#     says "anchor 'queenInboxPollTask = Task' is gone; the guard table is
#     stale" - NOANCHOR, the wrong event.  Same for guards 4 and 5.
#   - an unwrap row aimed at the one-line `if value >= 1_000_000 { return ...
#     }`: "BROKEN ROW ... the block unwrap refused: the block opens and closes
#     on one line; unwrapping it would delete its body", nothing written.
#   - an unwrap row aimed at `if let branch = task.virtualBranch {`, whose
#     body uses the binding: "BROKEN ROW ... the mutant parses but does not
#     typecheck", the compiler's own "cannot find 'branch' in scope" quoted
#     underneath, guard-shapes NOT consulted, make exit 2.  That is the
#     unwrap's version of the deletion's binding hazard, and the type floor
#     answers it without a special case.
#   - guard 5's needle renamed away: "STALE ... - no needle line above the
#     anchor".  Guard 5's unwrap scored against `keychain-doors`, a target
#     that cannot see it: "SURVIVED".  An unwrap is not rubber-stamped by
#     being a block operation either.
#
# Driven a fifth time when `must-not-typecheck` was added.  The value has no
# row, so ALL of it - the positive arm included - comes from `make
# mutants-guard MUTANTS_GUARD='...'`, and nothing temporary was committed.
# `git status --short rings/ BR-OUTPUT/ main.swift tests/swift/` was empty
# after every run below, the failures included:
#
#   - the table as it stands, unchanged by this: ten rows, all "ok - caught",
#     exit 0, 56.1s on the run before the change and 55.0s on the run after
#     it.  One sample each, so read it against the warm spread already
#     recorded for this same ten-row table one block above - 53.8s / 55.3s /
#     57.4s - which both numbers sit inside.  A value nobody declares costs
#     nothing, which is the point of adding it before the row that needs it.
#   - the positive arm.  Guard 6's replacement changed to
#     `_ = QueenDelegationPolicy.isStreamOpenNoSuchMember(current)` - the exact
#     mutant the type floor was built to reject - declared
#     `must-not-typecheck`: it parsed, the module went red, guard-shapes was
#     consulted and printed "ok - caught by guard-shapes", exit 0.  Under
#     `typechecks` that same mutant is the "BROKEN ROW ... parses but does not
#     typecheck" arm two blocks above, which is the whole shape of the gap.
#   - the negative arm, and the one that decides whether the value is a
#     shortcut.  The REAL guard 6 replacement - a mutant that compiles -
#     declared `must-not-typecheck`: "BROKEN ROW ... the mutant typechecks,
#     and this row exists to plant a type error", make guard-shapes NOT
#     consulted, make exit 2.  A row cannot claim a type error it did not
#     plant and be scored a catch for it.
#   - membership, the property the other three values have and this one keeps:
#     `must-not-typecheck` on tests/swift/queen_delegation_test.swift, which
#     the app build never compiles: "BROKEN ROW ... is NOT compiled into the
#     app module ... declare 'parses' or 'must-not-parse'", no mutation
#     applied.  So the fourth value cannot be reached for as a way around the
#     type instrument on a file where no typecheck is possible.
#   - the parse floor underneath it: `must-not-typecheck` with an unbalanced
#     `isStreamOpen(current` : "BROKEN ROW ... the mutant does not parse, so it
#     plants a syntax error and not the type error this row claims", with
#     swiftc's own "expected ')' in expression list" quoted underneath and
#     guard-shapes not consulted.  A syntax error does not get to score as a
#     type error.
#   - the pristine-module REFUSE, which now covers this value too: the
#     positive arm re-run with a THIRD file broken (an undefined identifier
#     appended to rings/SR-00/QueenObserver.swift): "REFUSED ... the app
#     module does not typecheck BEFORE the mutation", no mutation applied -
#     ChatViewModel.swift byte-identical by shasum across the run - make exit
#     2.  Without it, "the module is red" would read as this row's premise
#     holding when it is really somebody else's edit.
#   - a garbage value (`maybe`) is still a BROKEN ROW before the mutation, and
#     the message now names all four: "want typechecks, must-not-typecheck,
#     parses or must-not-parse".
#
# Driven a sixth time when `variant-fence` gave the fourth value its row.  The
# rows are now IN the table, so the positive arms come from a plain `make
# mutants-guard`; every negative arm is still `make mutants-guard
# MUTANTS_GUARD='...'`, so nothing temporary was committed, and `git status
# --short rings/ BR-OUTPUT/ main.swift` was empty after every run below, the
# failures included:
#
#   - the table with both new rows: twelve rows, all "ok - caught", exit 0,
#     77.4s / 74.1s / 89.1s on three runs, against ~55s for the same table at
#     ten rows.  The two rows are dearer than the eight before them because
#     they are the first to touch BR-OUTPUT/ProjectPaths.swift and rings/SR-00/
#     BuildVariantPolicy.swift, and the second of those sits near the bottom of
#     the dependency graph, so its incremental typecheck re-checks most of the
#     module.  The 74-89s spread is machine load; the honest summary is
#     "roughly +20s, and under a minute and a half".
#   - the `must-not-typecheck` row, positive arm, in the table: "ok - caught by
#     variant-fence: the dev/release fork is decided by a raw string again, the
#     way tools/ChatProbe.swift already does it".
#   - the same row flipped to `typechecks`: "BROKEN ROW ... the mutant parses
#     but does not typecheck", with swiftc's own "cannot convert value of type
#     'BuildVariant' to expected argument type 'String'" quoted underneath and
#     make variant-fence NOT consulted.  This is the counterfactual the value
#     was added for, now with a real row behind it instead of a forecast.
#   - the same row with a COMPILING mutant (`variant == .prod`) still declaring
#     `must-not-typecheck`: "BROKEN ROW ... the mutant typechecks, and this row
#     exists to plant a type error", target not consulted, make exit 2.
#   - the same row with an unbalanced mutant (`{ variant == "dev" ` , brace
#     dropped): "BROKEN ROW ... the mutant does not parse, so it plants a
#     syntax error and not the type error this row claims", swiftc's "static
#     properties may only be declared on a type" quoted underneath.
#   - both rows scored against a target that cannot see them - row A against
#     keychain-doors, row B against guard-shapes: "SURVIVED", make exit 2.  A
#     type error is not rubber-stamped by being a type error; the catch has to
#     come from the check whose subject it is.
#   - the check's own arms, driven on scratch copies via `make variant-fence
#     VARIANT_FENCE_SRC=...` and `VARIANT_FENCE_DIR=...`, so no tracked file
#     was touched: the fence removed by `ExpressibleByStringLiteral` (positive
#     green, all three negatives "TYPECHECKS ... the fence is gone"); the raw
#     string written into the real source (positive red, naming
#     ProjectPaths.swift:128); a missing positive witness; a directory with no
#     neg-*.swift; a negative with its `// EXPECT:` line stripped; a negative
#     with a bogus `// EXPECT:` line.  All six exit 2 and say which.
#   - and one defect the driving found in the check itself, recorded because it
#     is the failure this repo keeps re-discovering.  The EXPECT match was
#     first written as a grep over the WHOLE swiftc output.  With the raw
#     string planted in the real source, ProjectPaths.swift:128 emitted the
#     exact sentence neg-compare-literal.swift declares, so that witness
#     printed "ok - refused" on the strength of an error in a different file.
#     The match is now anchored to lines swiftc attributes to the witness
#     itself, and the same run prints "FAIL ... swiftc never said this ABOUT
#     neg-compare-literal.swift".
#
# Where the type state lives.  A sibling of the app build's object directory,
# never inside it - see "The type floor" above for why, and for the numbers.
TYPE_STATE := $(ROOT)/.trinity/build/typecheck-guard

MUTANTS_GUARD := \
	rings/SR-02/AgentMemoryService.swift@@var bytes = [UInt8](repeating: 0, count: 32)@@_ = SecItemCopyMatching([kSecClass as String: kSecClassGenericPassword] as CFDictionary, nil); var bytes = [UInt8](repeating: 0, count: 0x20)@@keychain-doors@@typechecks@@a real keychain call is opened in a file that is not on the allowlist~ \
	tests/swift/queen_delegation_test.swift@@static func issueParsing() {@@static issueParsing() {@@parse-tests@@must-not-parse@@a test source the app build never compiles loses its func keyword~ \
	rings/SR-02/ChatViewModel.swift@@delegationRegistry.recordCompletedTurn(taskID: task.id)@@_ = task.id // gutted: the turn is never marked complete@@finish-mark-order@@typechecks@@the completed-turn mark is dropped from the finish callback~ \
	rings/SR-02/ChatViewModel.swift@@guard !QueenDelegationPolicy.isStreamAlive(current, now: now) else { continue }@@_ = QueenDelegationPolicy.isStreamAlive(current, now: now) // gutted: the answer is thrown away@@guard-shapes@@typechecks@@guard 6 is gutted in place: the reaper still asks the predicate and throws the answer away~ \
	rings/SR-02/ChatViewModel.swift@@guard ProjectPaths.hasSupervisorInbox else { return }@@<DELETE-BLOCK>let path = Self.queenInboxPath@@guard-shapes@@typechecks@@guard 2 is deleted through its brace: the dev-inbox read loses its variant check~ \
	rings/SR-02/ChatViewModel.swift@@guard ProjectPaths.hasSupervisorInbox else {@@<DELETE-BLOCK>let entry = QueenInboxEntry(@@guard-shapes@@typechecks@@guard 3 is deleted through its brace: the inbox enqueue loses its variant check~ \
	main.swift@@guard RecursionGuard.shared.ensureSingleInstance() else {@@<DELETE-BLOCK>NSApplication.shared.run()@@guard-shapes@@typechecks@@guard 7 is deleted through its brace: the boot path stops enforcing a single instance~ \
	rings/SR-02/ChatViewModel.swift@@if ProjectPaths.hasSupervisorInbox {@@<UNWRAP-BLOCK>queenInboxPollTask = Task@@guard-shapes@@typechecks@@guard 1 is unwrapped, body kept: a release build starts the dev Queen inbox poller~ \
	rings/SR-00/KeychainSecrets.swift@@if ProjectPaths.usesFileSecretStore {@@<UNWRAP-BLOCK>DevSecretStore.read(service: service, account: account)@@guard-shapes@@typechecks@@guard 4 is unwrapped, body kept: a release build reads secrets from the plaintext dev store~ \
	rings/SR-00/TriOSEncryption.swift@@if ProcessInfo.processInfo.environment["TRIOS_E2E_DISABLE_KEYCHAIN"] == "1" {@@<UNWRAP-BLOCK>return try loadOrCreateTestKey()@@guard-shapes@@typechecks@@guard 5 is unwrapped, body kept: every build derives its data key from a volatile test file~ \
	BR-OUTPUT/ProjectPaths.swift@@static var isDevVariant: Bool { variant == .dev }@@static var isDevVariant: Bool { variant == "dev" }@@variant-fence@@must-not-typecheck@@the dev/release fork is decided by a raw string again, the way tools/ChatProbe.swift already does it~ \
	rings/SR-00/BuildVariantPolicy.swift@@enum BuildVariant: String, Equatable, Sendable {@@enum BuildVariant: String, Equatable, Sendable, ExpressibleByStringLiteral { init(stringLiteral value: String) { self = BuildVariant(rawValue: value) ?? .prod }@@variant-fence@@typechecks@@BuildVariant becomes string-convertible and every raw-string fork in the tree re-opens at once

.PHONY: mutants-guard
mutants-guard:
	@backup=$$(mktemp -d); \
	: "ONE POLICY FOR ONE LOCK, 2026-08-25 (second pass). Six targets use"; \
	: "this lock. cassettes waited; the other five refused instantly and"; \
	: "exited 1 while printing Nothing here is broken - a gate that fails"; \
	: "for a scheduling collision while announcing it is not a failure."; \
	: "The first pass fixed ONE of the five, because I counted two users"; \
	: "and never counted the rest. Waiting is right for all of them: the"; \
	: "runs are legitimate, neither agent knows about the other, and these"; \
	: "targets mutate real source files. Exiting 0 would be worse - check"; \
	: "green without the coverage having run is UNCHECKED read as agreed."; \
	waited=0; \
	while :; do \
		owner_pid=$$(cat "$(HARNESS_LOCK)/pid" 2>/dev/null || true); \
		if mkdir "$(HARNESS_LOCK)" 2>/dev/null; then break; fi; \
		if [ -n "$$owner_pid" ] && ! kill -0 $$owner_pid 2>/dev/null; then \
			echo "[INFO] reclaiming harness lock from dead PID $$owner_pid"; \
			rm -rf "$(HARNESS_LOCK)"; continue; \
		fi; \
		if [ $$waited -ge $(HARNESS_LOCK_WAIT) ]; then \
			echo "[FAIL] another harness run has held $(HARNESS_LOCK) for $(HARNESS_LOCK_WAIT)s"; \
			echo "       (owner PID $$owner_pid). Not waiting further."; \
			rm -rf $$backup; exit 1; \
		fi; \
		if [ $$waited = 0 ]; then \
			echo "[harness] another run holds the lock (PID $$owner_pid); waiting"; \
		fi; \
		sleep 5; waited=$$((waited + 5)); \
	done; \
	[ $$waited -gt 0 ] && echo "[harness] acquired the lock after $${waited}s" || true; \
	echo $$$$ > "$(HARNESS_LOCK)/pid"; \
	trap 'for f in $$backup/*.bak; do [ -e "$$f" ] || continue; \
	      target=$$(cat "$$f.path"); \
	      cp "$$f" "$(ROOT)/$$target"; \
	      expected=$$(cat "$${f}.sha" 2>/dev/null); \
	      if [ -n "$$expected" ]; then \
		      actual=$$(shasum "$(ROOT)/$$target" | cut -d" " -f1); \
		      if [ "$$actual" != "$$expected" ]; then \
			      echo "[FAIL] restore checksum mismatch for $$target" >&2; \
		      fi; \
	      fi; done; \
	      rm -rf $$backup; \
	      rm -rf "$(HARNESS_LOCK)" 2>/dev/null' EXIT INT TERM; \
	fail=0; n=0; \
	df="$$backup/delete-block.py"; \
	: "The block operation. A row whose replacement is <DELETE-BLOCK>ANCHOR"; \
	: "removes the needle line and everything up to and including the brace"; \
	: "that closes it, choosing the needle occurrence NEAREST ABOVE the anchor"; \
	: "- the same lookup guard-shapes does, so the guard deleted is the guard"; \
	: "scored. Braces are counted lexically: line comments, nested block"; \
	: "comments, escapes, raw and multiline strings, and interpolation are all"; \
	: "tracked, so a brace inside a string is not a brace. It refuses rather"; \
	: "than guesses when code precedes the needle on its line, when code"; \
	: "follows the closing brace on its line (an else chain), or when the"; \
	: "source does not lex."; \
	printf '%s\n' \
		'import os, sys' \
		'q1 = chr(34)' \
		'q3 = q1 * 3' \
		'hsh = chr(35)' \
		'src = open(os.environ["DB_SRC"], encoding="utf-8").read()' \
		'needle = os.environ["DB_NEEDLE"]' \
		'anchor = os.environ["DB_ANCHOR"]' \
		'op = os.environ.get("DB_OP", "delete")' \
		'if op not in ("delete", "unwrap"):' \
		'    sys.stderr.write("unknown block operation: " + op + "\n")' \
		'    sys.exit(3)' \
		'n = len(src)' \
		'code = bytearray(n)' \
		'stack = []' \
		'mode = "code"' \
		'hashes = 0' \
		'triple = False' \
		'depth_c = 0' \
		'paren = 0' \
		'i = 0' \
		'while i < n:' \
		'    c = src[i]' \
		'    if mode == "line":' \
		'        if c == "\n":' \
		'            mode = "code"' \
		'        i += 1' \
		'        continue' \
		'    if mode == "block":' \
		'        if src.startswith("/*", i):' \
		'            depth_c += 1' \
		'            i += 2' \
		'            continue' \
		'        if src.startswith("*/", i):' \
		'            depth_c -= 1' \
		'            i += 2' \
		'            if depth_c == 0:' \
		'                mode = "code"' \
		'            continue' \
		'        i += 1' \
		'        continue' \
		'    if mode == "str":' \
		'        esc = "\\" + hsh * hashes' \
		'        if src.startswith(esc + "(", i):' \
		'            stack.append((hashes, triple, paren))' \
		'            mode = "code"' \
		'            paren = 1' \
		'            i += len(esc) + 1' \
		'            continue' \
		'        if src.startswith(esc, i):' \
		'            i += len(esc) + 1' \
		'            continue' \
		'        close = (q3 if triple else q1) + hsh * hashes' \
		'        if src.startswith(close, i):' \
		'            mode = "code"' \
		'            i += len(close)' \
		'            continue' \
		'        i += 1' \
		'        continue' \
		'    if src.startswith("//", i):' \
		'        mode = "line"' \
		'        i += 2' \
		'        continue' \
		'    if src.startswith("/*", i):' \
		'        mode = "block"' \
		'        depth_c = 1' \
		'        i += 2' \
		'        continue' \
		'    h = 0' \
		'    while i + h < n and src[i + h] == hsh:' \
		'        h += 1' \
		'    if i + h < n and src[i + h] == q1:' \
		'        hashes = h' \
		'        triple = src.startswith(q3, i + h)' \
		'        mode = "str"' \
		'        i += h + (3 if triple else 1)' \
		'        continue' \
		'    if stack:' \
		'        if c == "(":' \
		'            paren += 1' \
		'        elif c == ")":' \
		'            paren -= 1' \
		'            if paren == 0:' \
		'                hashes, triple, paren = stack.pop()' \
		'                mode = "str"' \
		'                i += 1' \
		'                continue' \
		'    code[i] = 1' \
		'    i += 1' \
		'if mode != "code" or stack or depth_c:' \
		'    sys.stderr.write("the source does not lex: unterminated string or comment\n")' \
		'    sys.exit(3)' \
		'starts = [0]' \
		'for k in range(n):' \
		'    if src[k] == "\n":' \
		'        starts.append(k + 1)' \
		'lines = src.split("\n")' \
		'a = -1' \
		'for k in range(len(lines)):' \
		'    if anchor in lines[k]:' \
		'        a = k' \
		'        break' \
		'if a < 0:' \
		'    sys.stderr.write("the anchor is not in this source\n")' \
		'    sys.exit(1)' \
		'g = -1' \
		'for k in range(a - 1, -1, -1):' \
		'    if needle in lines[k]:' \
		'        g = k' \
		'        break' \
		'if g < 0:' \
		'    sys.stderr.write("no needle line above the anchor\n")' \
		'    sys.exit(1)' \
		'col = lines[g].index(needle)' \
		'if lines[g][:col].strip():' \
		'    sys.stderr.write("code precedes the needle on its own line\n")' \
		'    sys.exit(3)' \
		'open_at = -1' \
		'for p in range(starts[g] + col, n):' \
		'    if code[p] and src[p] == "{":' \
		'        open_at = p' \
		'        break' \
		'if open_at < 0:' \
		'    sys.stderr.write("no opening brace after the needle\n")' \
		'    sys.exit(3)' \
		'depth = 0' \
		'close_at = -1' \
		'for p in range(open_at, n):' \
		'    if not code[p]:' \
		'        continue' \
		'    if src[p] == "{":' \
		'        depth += 1' \
		'    elif src[p] == "}":' \
		'        depth -= 1' \
		'        if depth == 0:' \
		'            close_at = p' \
		'            break' \
		'if close_at < 0:' \
		'    sys.stderr.write("the opening brace has no match\n")' \
		'    sys.exit(3)' \
		'c_line = 0' \
		'for k in range(len(starts)):' \
		'    if starts[k] <= close_at:' \
		'        c_line = k' \
		'    else:' \
		'        break' \
		'if src[close_at + 1:starts[c_line] + len(lines[c_line])].strip():' \
		'    sys.stderr.write("code follows the closing brace on its line\n")' \
		'    sys.exit(3)' \
		'if op == "unwrap":' \
		'    if c_line == g:' \
		'        sys.stderr.write("the block opens and closes on one line; unwrapping it would delete its body\n")' \
		'        sys.exit(3)' \
		'    if src[starts[c_line]:close_at].strip():' \
		'        sys.stderr.write("code precedes the closing brace on its line\n")' \
		'        sys.exit(3)' \
		'    if a >= c_line:' \
		'        sys.stderr.write("the anchor is not inside the block this row unwraps\n")' \
		'        sys.exit(3)' \
		'end = starts[c_line] + len(lines[c_line])' \
		'if end < n and src[end] == "\n":' \
		'    end += 1' \
		'g_end = starts[g] + len(lines[g])' \
		'if g_end < n and src[g_end] == "\n":' \
		'    g_end += 1' \
		'if op == "unwrap":' \
		'    out = src[:starts[g]] + src[g_end:starts[c_line]] + src[end:]' \
		'    said = "unwrapped lines " + str(g + 1) + " and " + str(c_line + 1) + ", body kept"' \
		'else:' \
		'    out = src[:starts[g]] + src[end:]' \
		'    said = "deleted lines " + str(g + 1) + "-" + str(c_line + 1)' \
		'open(os.environ["DB_SRC"], "w", encoding="utf-8").write(out)' \
		'sys.stderr.write(said + "\n")' \
	> $$df; \
	: "It proves itself on a fixture before it is pointed at a real source."; \
	: "The fixture hides braces in a string, a line comment and a block"; \
	: "comment; a counter that walks characters closes that guard four lines"; \
	: "early and leaves a source that does not compile. Driven here, not"; \
	: "argued: if the result is not the expected file, no row runs at all."; \
	fx="$(ROOT)/tests/fixtures/delete-block-braces.swift"; \
	fxe="$(ROOT)/tests/fixtures/delete-block-braces.expected.swift"; \
	if [ ! -f "$$fx" ] || [ ! -f "$$fxe" ]; then \
		echo "[FAIL] the block-deletion fixtures are missing:"; \
		echo "       tests/fixtures/delete-block-braces.swift and .expected.swift"; \
		echo "       no row was run; the operation has nothing to prove itself on"; \
		exit 1; \
	fi; \
	sfx="$$backup/selftest.swift"; cp "$$fx" "$$sfx"; \
	if ! sferr=$$(DB_SRC="$$sfx" DB_NEEDLE='guard ready(shape:' DB_ANCHOR='return true' python3 $$df 2>&1); then \
		echo "[FAIL] the block-deletion self-test refused the fixture: $$sferr"; \
		echo "       no row was run"; \
		exit 1; \
	fi; \
	if ! diff -q "$$fxe" "$$sfx" >/dev/null; then \
		echo "[FAIL] the block deletion did not reproduce delete-block-braces.expected.swift"; \
		diff -u "$$fxe" "$$sfx" | head -20 | sed 's/^/       | /'; \
		echo "       no row was run: an operation that cannot match braces past a"; \
		echo "       string must not be pointed at a real source"; \
		exit 1; \
	fi; \
	echo "  ok   - block deletion matches braces past strings and comments ($$sferr)"; \
	: "The unwrap operation proves itself on its own fixture pair, and on more \
	   than the happy path. Unwrapping keeps the body, so every way of getting \
	   the span wrong DELETES CODE instead of leaving a gap: close one line \
	   early and a body line goes, aim at a one-line block and the whole body \
	   goes with the brace. So the positive arm is diffed against an expected \
	   file, and three shapes the operation must refuse are driven too - each \
	   must exit 3, name its reason, and leave the copy it was handed \
	   byte-identical."; \
	ufx="$(ROOT)/tests/fixtures/unwrap-block-braces.swift"; \
	ufxe="$(ROOT)/tests/fixtures/unwrap-block-braces.expected.swift"; \
	if [ ! -f "$$ufx" ] || [ ! -f "$$ufxe" ]; then \
		echo "[FAIL] the block-unwrap fixtures are missing:"; \
		echo "       tests/fixtures/unwrap-block-braces.swift and .expected.swift"; \
		echo "       no row was run; the operation has nothing to prove itself on"; \
		exit 1; \
	fi; \
	ufs="$$backup/selftest-unwrap.swift"; cp "$$ufx" "$$ufs"; \
	if ! uferr=$$(DB_OP=unwrap DB_SRC="$$ufs" DB_NEEDLE='if devOnly(shape: "brace{here' \
		DB_ANCHOR='// anchor: unwrap-positive' python3 $$df 2>&1); then \
		echo "[FAIL] the block-unwrap self-test refused the fixture: $$uferr"; \
		echo "       no row was run"; \
		exit 1; \
	fi; \
	if ! diff -q "$$ufxe" "$$ufs" >/dev/null; then \
		echo "[FAIL] the block unwrap did not reproduce unwrap-block-braces.expected.swift"; \
		diff -u "$$ufxe" "$$ufs" | head -20 | sed 's/^/       | /'; \
		echo "       no row was run: an operation that closes the block on the wrong"; \
		echo "       line does not leave a gap here, it eats a line of the body"; \
		exit 1; \
	fi; \
	echo "  ok   - block unwrap keeps the body past strings and comments ($$uferr)"; \
	uref=0; \
	for arm in \
		'if devOnly(shape: "inline"@@// anchor: unwrap-oneline@@opens and closes on one line' \
		'if devOnly(shape: "shared"@@// anchor: unwrap-shared@@code precedes the closing brace' \
		'if devOnly(shape: "outside"@@// anchor: unwrap-outside@@the anchor is not inside the block'; do \
		un=$${arm%%@@*}; urest=$${arm#*@@}; ua=$${urest%%@@*}; uw=$${urest#*@@}; \
		cp "$$ufx" "$$ufs"; \
		umsg=$$(DB_OP=unwrap DB_SRC="$$ufs" DB_NEEDLE="$$un" DB_ANCHOR="$$ua" python3 $$df 2>&1); urc=$$?; \
		uwrote=no; diff -q "$$ufx" "$$ufs" >/dev/null || uwrote=yes; \
		if [ $$urc -ne 3 ] || [ "$$uwrote" = yes ] || ! printf '%s' "$$umsg" | grep -qF "$$uw"; then \
			echo "[FAIL] the block unwrap did not refuse a shape it cannot unwrap safely:"; \
			echo "       needle: $$un"; \
			echo "       got exit $$urc, wrote=$$uwrote, said: $${umsg:-nothing}"; \
			echo "       wanted exit 3, wrote=no, naming: $$uw"; \
			echo "       no row was run: an unwrap that guesses at these shapes eats code"; \
			exit 1; \
		fi; \
		uref=$$((uref + 1)); \
	done; \
	echo "  ok   - block unwrap refuses $$uref shapes that would eat code (one-line block, code before the closing brace, anchor outside the block)"; \
	: "The type floor. A parse proves the mutant is Swift; only a typecheck \
	   proves it is code, and a typecheck needs the module the real build \
	   compiles. Nothing about that module is copied here, in either half: the \
	   source list is READ from the dev build's own output-file-map, and the \
	   include directories are READ from build.sh's own flag print. Both are \
	   artifacts of the build rather than restatements of it, so neither can \
	   rot. A set that is nonetheless wrong cannot be silent - the pristine \
	   typecheck per row goes red and every row REFUSES."; \
	ofm="$(WARN_OFM)"; \
	if [ ! -f "$$ofm" ]; then \
		echo "[FAIL] no dev output-file-map at $$ofm"; \
		echo "       This gate borrows the app build's own source list rather than"; \
		echo "       keeping a second copy that would rot out of step with it."; \
		echo "       Run 'make dev' once, then this target again."; \
		echo "       No row was run: falling back to parse-only would be the silent"; \
		echo "       downgrade the type floor exists to remove."; \
		exit 1; \
	fi; \
	: "The include set is not resolved here. It is PRINTED by build.sh - the \
	   script that passes it to the real compile - and read back: \
	   'TRIOS_PRINT_FLAGS=1 build.sh' resolves the CSQLCipher module map, the \
	   SQLCipher headers and QueenUILib's swiftmodule, prints the -I/-L/-l block \
	   one argument per line, and exits without compiling.  This target used to \
	   resolve those three directories in its own copy of build.sh's logic, and \
	   the copy HAD already drifted: it pointed at Frameworks-dev/Modules, the \
	   vendored copy of the QueenUILib interface, while a dev build compiles \
	   against SwiftPM's .build/.../debug/Modules.  Same bytes that day, two \
	   directories, and nothing would have said so.  \
	   The printed set is passed to swiftc WHOLE - -L, -lsqlcipher and \
	   -lQueenUILib included.  The reader used to keep the -I pairs and drop the \
	   link flags, on the ARGUMENT that a typecheck wants search paths and not \
	   libraries.  Measured instead, on this tree, both sets over the same 185 \
	   sources: exit 0 either way and BYTE-IDENTICAL diagnostics - 33 lines, the \
	   4 known warnings, diff clean - cold 17.9s with the full set against 19.1s \
	   with the -I-only set, warm 0.53s against 0.52s.  swiftc accepts -L and -l \
	   under -typecheck, links nothing, and does not even warn about an unused \
	   argument.  The filter bought nothing measurable, and it was the last place \
	   where this reader decided something about the set instead of consuming it: \
	   a flag added to build.sh that is not a -I used to be dropped here in \
	   silence, and now reaches the compiler, where a set swiftc rejects turns \
	   the pristine typecheck red and every row REFUSES by name.  \
	   The -I pairs are still read out below, but only to be CHECKED - that the \
	   list pairs up and that every directory exists - which is a question asked \
	   about the printed set, not a decision about what is passed.  The one thing \
	   still duplicated, named exactly rather than implied: the variant, which is \
	   WARN_VARIANT, the same symbol that picked the output-file-map above.  \
	   Where any of these directories ARE is no longer written in this file."; \
	incfile="$$backup/include-flags.txt"; \
	incerr="$$backup/include-flags.err"; \
	if ! TRIOS_VARIANT=$(WARN_VARIANT) TRIOS_PRINT_FLAGS=1 "$(ROOT)/build.sh" \
		> "$$incfile" 2> "$$incerr"; then \
		echo "[FAIL] build.sh could not resolve the app module's flag set:"; \
		head -10 "$$incerr" | sed 's/^/       | /'; \
		echo "       That is the same resolution the real build performs, so this"; \
		echo "       tree cannot compile either. No row was run: guessing an include"; \
		echo "       set here is the silent divergence reading it removed."; \
		exit 1; \
	fi; \
	if ! awk '$$0=="-I"{if((getline d)<=0){exit 2} print d}' "$$incfile" \
		> "$$backup/include-dirs.txt"; then \
		echo "[FAIL] build.sh printed a -I with no directory after it."; \
		echo "       The flag list is malformed; no row was run."; \
		exit 1; \
	fi; \
	: > "$$backup/include-bad.txt"; \
	ninc=0; \
	while IFS= read -r incdir; do \
		[ -n "$$incdir" ] || continue; \
		ninc=$$((ninc + 1)); \
		[ -d "$$incdir" ] || printf '%s\n' "$$incdir" >> "$$backup/include-bad.txt"; \
	done < "$$backup/include-dirs.txt"; \
	nbadinc=$$(wc -l < "$$backup/include-bad.txt" | tr -d ' '); \
	if [ "$$ninc" -eq 0 ] || [ "$$nbadinc" -ne 0 ]; then \
		echo "[FAIL] the include set build.sh printed is not usable:"; \
		[ "$$ninc" -ne 0 ] || echo "       it named no -I directory at all"; \
		sed 's/^/       missing directory: /' "$$backup/include-bad.txt"; \
		echo "       These are the -I directories build.sh passes to the real"; \
		echo "       compile, read from it rather than resolved a second time here."; \
		echo "       Without them a typecheck cannot see the module, and no row"; \
		echo "       was run."; \
		exit 1; \
	fi; \
	nflag=$$(wc -l < "$$incfile" | tr -d ' '); \
	: "The flag file is byte-stable on purpose: swiftc throws the incremental \
	   state away when the flags change, and a run that rebuilds its flags \
	   differently each time is a gate that is never warm - measured at 17s \
	   instead of 0.5s."; \
	tcstate="$(TYPE_STATE)"; tcargs="$$tcstate/typecheck.args"; \
	modlist="$$tcstate/module-files.txt"; \
	tccold=no; [ -f "$$tcstate/master.priors" ] || tccold=yes; \
	mkdir -p "$$tcstate"; \
	tf="$$backup/tc-setup.py"; \
	printf '%s\n' \
		'import json, os, sys' \
		'st = os.environ["MG_STATE"]' \
		'files = sorted(k for k in json.load(open(os.environ["MG_OFM"])) if k)' \
		'if not files:' \
		'    sys.stderr.write("it names no sources")' \
		'    sys.exit(1)' \
		'gone = [f for f in files if not os.path.exists(f)]' \
		'if gone:' \
		'    sys.stderr.write("%d of its %d sources no longer exist, first: %s" % (len(gone), len(files), gone[0]))' \
		'    sys.exit(1)' \
		'm = {"": {"swift-dependencies": st + "/master.swiftdeps"}}' \
		'for f in files:' \
		'    m[f] = {"swift-dependencies": st + "/" + os.path.basename(f)[:-6] + ".swiftdeps"}' \
		'open(st + "/output-file-map.json", "w").write(json.dumps(m, indent=1))' \
		'flags = ["-typecheck", "-incremental", "-output-file-map",' \
		'         st + "/output-file-map.json", "-j", "1", "-enable-batch-mode"]' \
		'for a in open(os.environ["MG_FLAGS"]).read().splitlines():' \
		'    if a:' \
		'        flags.append(a)' \
		'open(st + "/typecheck.args", "w").write("\n".join(flags + files) + "\n")' \
		'open(st + "/module-files.txt", "w").write("\n".join(files) + "\n")' \
		'sys.stdout.write(str(len(files)))' \
	> $$tf; \
	if ! tcn=$$(MG_OFM="$$ofm" MG_STATE="$$tcstate" \
		MG_FLAGS="$$incfile" python3 $$tf 2>&1); then \
		echo "[FAIL] the dev output-file-map is not usable as a source list: $$tcn"; \
		echo "       It is stale with respect to the tree. Run 'make dev' and try again;"; \
		echo "       no row was run."; \
		exit 1; \
	fi; \
	tcheck() { swiftc @"$$tcargs" 2>&1; }; \
	if [ "$$tccold" = yes ]; then \
		echo "  note - typecheck state is empty; the first module pass fills it (~17s)"; \
	fi; \
	echo "  ok   - app module borrowed from the $(WARN_VARIANT) build: $$tcn sources, $$nflag flags printed by build.sh, passed whole ($$ninc are -I dirs, all present)"; \
	: "Rows are separated by a literal ~, the way GUARDS does it, not by \
	   guessing a record boundary from the leading path. That guess had a \
	   fixed list - rings/, BR-OUTPUT/, tests/ - so a row naming main.swift \
	   would have been swallowed by its predecessor, and a row whose LABEL \
	   happened to read ' main.swift' would have been split in two. Both are \
	   live hazards the moment a guard row points at the boot file."; \
	while IFS= read -r raw; do \
		entry=$$(printf '%s' "$$raw" | sed 's/^[[:space:]]*//; s/[[:space:]]*$$//'); \
		[ -n "$$entry" ] || continue; \
		src=$$(echo "$$entry" | awk -F'@@' '{print $$1}'); \
		needle=$$(echo "$$entry" | awk -F'@@' '{print $$2}'); \
		repl=$$(echo "$$entry" | awk -F'@@' '{print $$3}'); \
		guard=$$(echo "$$entry" | awk -F'@@' '{print $$4}'); \
		parse=$$(echo "$$entry" | awk -F'@@' '{print $$5}'); \
		name=$$(echo "$$entry" | awk -F'@@' '{print $$6}'); \
		n=$$((n + 1)); \
		: "The machine before the mutation. An already-red target would go \
		   red again for its own reason and forge a catch, so a row that \
		   cannot show a green baseline is not allowed to score at all."; \
		pre=$$($(MAKE) --no-print-directory $$guard 2>&1); prerc=$$?; \
		if [ $$prerc -ne 0 ] || ! echo "$$pre" | grep -qF "[OK]"; then \
			echo "  REFUSED - $$name: make $$guard is not green BEFORE the mutation (exit $$prerc)"; \
			echo "            no mutation was applied; a red machine cannot prove a catch"; \
			echo "$$pre" | head -5 | sed 's/^/         | /'; \
			fail=1; continue; \
		fi; \
		: "And the source before it is touched. If it does not parse already, \
		   the mutant's parse below would blame this row for somebody else's \
		   broken edit."; \
		if ! preparse=$$(swiftc -parse "$(ROOT)/$$src" 2>&1); then \
			echo "  REFUSED - $$name: $$src does not parse BEFORE the mutation"; \
			echo "            no mutation was applied; a mutant's parse proves nothing"; \
			echo "            on a source that was already broken"; \
			echo "$$preparse" | grep 'error:' | head -3 | sed 's/^/         | /'; \
			fail=1; continue; \
		fi; \
		: "The declared expectation, checked against the module BEFORE anything \
		   is written. A row does not get to choose the weaker instrument: a \
		   file the app build compiles must make a claim about types - either \
		   way round - and a file it does not compile may not, because there \
		   is no module in which to answer. Both directions are read off the \
		   dev build's source list, not off the row's prose."; \
		case "$$parse" in \
			typechecks|must-not-typecheck) want_mod=yes ;; \
			parses|must-not-parse) want_mod=no ;; \
			*) echo "  BROKEN ROW - $$name: the row declares expectation '$$parse'; want"; \
			   echo "               typechecks, must-not-typecheck, parses or must-not-parse"; \
			   echo "               no mutation was applied"; \
			   fail=1; continue ;; \
		esac; \
		in_mod=no; grep -qxF "$(ROOT)/$$src" "$$modlist" && in_mod=yes; \
		if [ "$$in_mod" != "$$want_mod" ]; then \
			if [ "$$in_mod" = yes ]; then \
				echo "  BROKEN ROW - $$name: $$src IS compiled into the app module, so"; \
				echo "               '$$parse' asks less of the mutant than can be measured"; \
				echo "               here - declare 'typechecks', or 'must-not-typecheck'"; \
				echo "               if the mutation plants a type error on purpose"; \
			else \
				echo "  BROKEN ROW - $$name: $$src is NOT compiled into the app module, so"; \
				echo "               its mutant cannot be typechecked in one - declare"; \
				echo "               'parses' or 'must-not-parse'"; \
			fi; \
			echo "               no mutation was applied"; \
			fail=1; continue; \
		fi; \
		: "And the module before it is touched, for the same reason the parse \
		   above runs on the pristine source: a module somebody else broke - \
		   another agent mid-edit, or a source list stale since the last dev \
		   build - must be REFUSED, never charged to this row."; \
		if [ "$$parse" = typechecks ] || [ "$$parse" = must-not-typecheck ]; then \
			pretc=$$(tcheck); pretcrc=$$?; \
			if [ $$pretcrc -ne 0 ]; then \
				echo "  REFUSED - $$name: the app module does not typecheck BEFORE the mutation"; \
				echo "            no mutation was applied; a mutant's typecheck proves nothing"; \
				echo "            on a module that was already broken. Either another edit in"; \
				echo "            the tree, or a source list stale since the last 'make dev'."; \
				echo "$$pretc" | grep 'error:' | head -3 | sed 's/^/         | /'; \
				fail=1; continue; \
			fi; \
		fi; \
		cp "$(ROOT)/$$src" "$$backup/$$n.bak"; echo "$$src" > "$$backup/$$n.bak.path"; \
		shasum "$(ROOT)/$$src" | cut -d" " -f1 > "$$backup/$$n.bak.sha"; \
		case "$$repl" in \
		"<DELETE-BLOCK>"*) \
			: "A deletion has no replacement text, so the leftover-mutation \
			   branch below cannot apply to it: there is nothing to look for \
			   in the file. It is not needed either. A deletion left behind \
			   by a killed run leaves the guard MISSING, so make guard-shapes \
			   is red and the green-baseline check above has already REFUSED \
			   this row by name. That is also why exit 1 here means a stale \
			   table and not a leftover: a leftover never reaches this line."; \
			bop=deletion; \
			dberr=$$(DB_SRC="$(ROOT)/$$src" DB_NEEDLE="$$needle" \
				DB_ANCHOR="$${repl#<DELETE-BLOCK>}" python3 $$df 2>&1); rc=$$?; \
			;; \
		"<UNWRAP-BLOCK>"*) \
			: "The third operation, and the one guards 1, 4 and 5 need. The \
			   dev-only if-line and its matching closing brace go, the \
			   BODY stays, so the block runs unconditionally - the accident \
			   guard-shapes was built for. Deleting those blocks instead takes \
			   the guard-shapes ANCHOR with them, since all three anchors sit \
			   INSIDE the block, and the target then answers NOANCHOR - a \
			   stale table - rather than the missing guard the row names. \
			   Same lookup, same lexical matcher, same refusals, plus three \
			   of its own: a one-line block, code before the closing brace, \
			   and an anchor outside the block all eat code if unwrapped."; \
			bop=unwrap; \
			dberr=$$(DB_OP=unwrap DB_SRC="$(ROOT)/$$src" DB_NEEDLE="$$needle" \
				DB_ANCHOR="$${repl#<UNWRAP-BLOCK>}" python3 $$df 2>&1); rc=$$?; \
			;; \
		*) \
			: "dberr and bop belong to the row being run, not to the last block \
			   row that set them; a stale value here would attach one row's \
			   reason to another row's verdict."; \
			dberr=; bop=; \
			MUT_SRC="$(ROOT)/$$src" MUT_OLD="$$needle" MUT_NEW="$$repl" python3 -c \
				'import os,sys; p=os.environ["MUT_SRC"]; s=open(p).read(); o=os.environ["MUT_OLD"]; n=os.environ["MUT_NEW"]; open(p,"w").write(s.replace(o,n,1)) if o in s else (open(p,"w").write(s.replace(n,o,1)),sys.exit(2))[1] if n in s else sys.exit(1)'; rc=$$?; \
			;; \
		esac; \
		case $$rc in \
			3) echo "  BROKEN ROW - $$name: the block $$bop refused: $$dberr"; \
			   echo "               nothing was written; the row names a shape this"; \
			   echo "               operation does not handle, and a guess would have"; \
			   echo "               left a source nobody can compile"; \
			   fail=1; cp "$$backup/$$n.bak" "$(ROOT)/$$src"; continue ;; \
			2) echo "  LEFTOVER MUTATION - $$name (repaired: replacement was in $$src without its needle)"; \
			   cp "$(ROOT)/$$src" "$$backup/$$n.bak"; shasum "$(ROOT)/$$src" | cut -d" " -f1 > "$$backup/$$n.bak.sha"; \
			   MUT_SRC="$(ROOT)/$$src" MUT_OLD="$$needle" MUT_NEW="$$repl" python3 -c \
			   'import os,sys; p=os.environ["MUT_SRC"]; s=open(p).read(); o=os.environ["MUT_OLD"]; open(p,"w").write(s.replace(o,os.environ["MUT_NEW"],1))' ;; \
			1) echo "  STALE - $$name (its needle is no longer in $$src)$${dberr:+ - $$dberr}"; fail=1; \
			   cp "$$backup/$$n.bak" "$(ROOT)/$$src"; continue ;; \
		esac; \
		shasum "$(ROOT)/$$src" | cut -d" " -f1 > "$$backup/$$n.mut.sha"; \
		: "The mutant itself, before the target is consulted. A replacement \
		   that does not compile sends the target red for a reason that is \
		   not the guard noticing, and these targets never build anything, \
		   so nothing else in this loop would catch it. Syntax first: a parse \
		   tells a dropped keyword from a name that is not there, and it is \
		   the only instrument available to a row whose file is in no module."; \
		mutparse=$$(swiftc -parse "$(ROOT)/$$src" 2>&1); mutrc=$$?; broken=; \
		mutdiag=$$mutparse; \
		: "The four values were validated before the mutation, so these arms \
		   are exhaustive and a default would be dead. Three of them want a \
		   mutant that parses; only must-not-parse wants one that does not. \
		   A must-not-typecheck row is in the first group on purpose: a \
		   replacement that fails to PARSE plants a syntax error, which is a \
		   different event from the type error the row claims, and scoring it \
		   under this name would be the same forgery the fifth field exists \
		   to stop."; \
		case "$$parse" in \
			parses|typechecks) if [ $$mutrc -ne 0 ]; then broken="the mutant does not parse"; fi ;; \
			must-not-typecheck) if [ $$mutrc -ne 0 ]; then broken="the mutant does not parse, so it plants a syntax error and not the type error this row claims"; fi ;; \
			must-not-parse) if [ $$mutrc -eq 0 ]; then broken="the mutant parses, and this row exists to plant a syntax error"; fi ;; \
		esac; \
		: "And the type floor, read in whichever direction the row declared. \
		   typechecks is the arm that scores a replacement using an identifier \
		   that is not there: it PARSES, so everything above is satisfied, and \
		   it would send the target red for a reason that is not the guard \
		   noticing. must-not-typecheck is the same measurement with the \
		   opposite premise - the row's whole subject is a type-level mistake, \
		   so a mutant that TYPECHECKS has failed to plant it, and the target \
		   must not be consulted about a mutation that did not happen."; \
		case "$$parse" in \
		typechecks|must-not-typecheck) \
			if [ -z "$$broken" ]; then \
				muttc=$$(tcheck); muttcrc=$$?; \
				if [ "$$parse" = typechecks ] && [ $$muttcrc -ne 0 ]; then \
					broken="the mutant parses but does not typecheck"; mutdiag=$$muttc; \
				elif [ "$$parse" = must-not-typecheck ] && [ $$muttcrc -eq 0 ]; then \
					broken="the mutant typechecks, and this row exists to plant a type error"; \
				fi; \
			fi ;; \
		esac; \
		if [ -n "$$broken" ]; then \
			echo "  BROKEN ROW - $$name: $$broken"; \
			echo "               make $$guard was NOT consulted: when the mutant is not"; \
			echo "               the code the row claims it is, a red target says nothing"; \
			echo "               about the guard - a broken row, not a catch"; \
			echo "$$mutdiag" | grep 'error:' | head -3 | sed 's/^/         | /'; \
			fail=1; \
		else \
			post=$$($(MAKE) --no-print-directory $$guard 2>&1); postrc=$$?; \
			if [ $$postrc -ne 0 ] && echo "$$post" | grep -qF "[FAIL]"; then \
				echo "  ok   - caught by $$guard: $$name"; \
			elif [ $$postrc -eq 0 ] && echo "$$post" | grep -qF "[OK]"; then \
				echo "  SURVIVED - $$name"; fail=1; \
			else \
				echo "  ERROR - make $$guard neither passed nor failed: $$name (exit $$postrc)"; fail=1; \
				echo "$$post" | head -5 | sed 's/^/         | /'; \
			fi; \
		fi; \
		if [ -f "$$backup/$$n.mut.sha" ]; then \
			now_sha=$$(shasum "$(ROOT)/$$src" | cut -d" " -f1); \
			if [ "$$now_sha" != "$$(cat "$$backup/$$n.mut.sha")" ]; then \
				echo "  [FAIL] $$src changed while the harness held it mutated."; \
				echo "         Restoring the backup would silently revert whoever wrote to it."; \
				echo "         The mutation is left in place; resolve by hand. Backup: $$backup/$$n.bak"; \
				fail=1; continue; \
			fi; \
		fi; \
		cp "$$backup/$$n.bak" "$(ROOT)/$$src"; \
	done < <(printf '%s\n' '$(MUTANTS_GUARD)' | tr '~' '\n'); \
	if [ $$fail -eq 0 ]; then echo "[OK] every guard mutation was caught by its own check ($$n)"; \
	else echo "[FAIL] a guard mutation survived, went stale, did not compile, was not measured, or ran against a red machine"; exit 1; fi

# --- Mutation (working tree only) ---------------------------------------
#
# `mutants` runs every mutation every time, which is slow.  This target
# selects mutations only for guarded files that are dirty in the working
# tree — uncommitted edits, staged or unstaged.  It no longer compares
# against a base branch, because a wide diff (rebase, merge, branch switch)
# selected every mutation and ran for twenty minutes on a change to one file.
#
# A sanity valve refuses to run when more than half the known mutations are
# selected.  That is the signature of a wide working tree, not a focused
# edit, and the valve keeps the target honest about what it is for.
#
# Removed from `check`: the selection is still broader than the guard it
# exists to test.  Add it back when the set is narrow enough to run on every
# build without surprise.
#
# Shares the harness lock and the backup-and-restore trap with `mutants` and
# `mutants-logic` so the safety contract is identical: every file is restored
# with a checksum verification on any exit path.

mutants-changed:
	@backup=$$(mktemp -d); \
	: "ONE POLICY FOR ONE LOCK, 2026-08-25 (second pass). Six targets use"; \
	: "this lock. cassettes waited; the other five refused instantly and"; \
	: "exited 1 while printing Nothing here is broken - a gate that fails"; \
	: "for a scheduling collision while announcing it is not a failure."; \
	: "The first pass fixed ONE of the five, because I counted two users"; \
	: "and never counted the rest. Waiting is right for all of them: the"; \
	: "runs are legitimate, neither agent knows about the other, and these"; \
	: "targets mutate real source files. Exiting 0 would be worse - check"; \
	: "green without the coverage having run is UNCHECKED read as agreed."; \
	waited=0; \
	while :; do \
		owner_pid=$$(cat "$(HARNESS_LOCK)/pid" 2>/dev/null || true); \
		if mkdir "$(HARNESS_LOCK)" 2>/dev/null; then break; fi; \
		if [ -n "$$owner_pid" ] && ! kill -0 $$owner_pid 2>/dev/null; then \
			echo "[INFO] reclaiming harness lock from dead PID $$owner_pid"; \
			rm -rf "$(HARNESS_LOCK)"; continue; \
		fi; \
		if [ $$waited -ge $(HARNESS_LOCK_WAIT) ]; then \
			echo "[FAIL] another harness run has held $(HARNESS_LOCK) for $(HARNESS_LOCK_WAIT)s"; \
			echo "       (owner PID $$owner_pid). Not waiting further."; \
			rm -rf $$backup; exit 1; \
		fi; \
		if [ $$waited = 0 ]; then \
			echo "[harness] another run holds the lock (PID $$owner_pid); waiting"; \
		fi; \
		sleep 5; waited=$$((waited + 5)); \
	done; \
	[ $$waited -gt 0 ] && echo "[harness] acquired the lock after $${waited}s" || true; \
	echo $$$$ > "$(HARNESS_LOCK)/pid"; \
	trap 'for f in $$backup/*.bak; do [ -e "$$f" ] || continue; \
	      target=$$(cat "$$f.path"); \
	      cp "$$f" "$(ROOT)/$$target"; \
	      expected=$$(cat "$${f}.sha" 2>/dev/null); \
	      if [ -n "$$expected" ]; then \
		      actual=$$(shasum "$(ROOT)/$$target" | cut -d" " -f1); \
		      if [ "$$actual" != "$$expected" ]; then \
			      echo "[FAIL] restore checksum mismatch for $$target" >&2; \
		      fi; \
	      fi; done; \
	      rm -rf $$backup; \
	      rm -rf "$(HARNESS_LOCK)" 2>/dev/null' EXIT INT TERM; \
	changed=$$(git -C "$(ROOT)" diff --name-only --relative HEAD); \
	total=0; selected=0; \
	: "Count total and selected mutations before running anything"; \
	IFS='~'; for entry in $$(echo '$(MUTANTS) $(MUTANTS_LOGIC)' | sed 's/ rings\//~rings\//g; s/ BR-OUTPUT\//~BR-OUTPUT\//g'); do \
		unset IFS; \
		[ -z "$$entry" ] && continue; \
		src=$$(echo "$$entry" | awk -F'@@' '{print $$1}'); \
		total=$$((total + 1)); \
		echo "$$changed" | grep -qxF "$$src" && selected=$$((selected + 1)) || true; \
	done; \
	echo "[INFO] working tree: $$selected of $$total mutations selected"; \
	half=$$((total / 2)); \
	if [ $$selected -gt $$half ]; then \
		echo "[FAIL] sanity valve: $$selected mutations selected, more than half of $$total (ceiling $$half)."; \
		echo "       Narrow your working-tree changes or run 'make mutants' directly."; \
		exit 1; \
	fi; \
	if [ $$selected -eq 0 ]; then \
		echo "[OK] no guarded file changed in the working tree (0 of $$total mutations selected)"; exit 0; \
	fi; \
	fail=0; n=0; \
	: "SSE-harness mutations whose source is dirty in the working tree"; \
	IFS='~'; for entry in $$(echo '$(MUTANTS)' | sed 's/ rings\//~rings\//g; s/ BR-OUTPUT\//~BR-OUTPUT\//g'); do \
		unset IFS; \
		src=$$(echo "$$entry" | awk -F'@@' '{print $$1}'); \
		needle=$$(echo "$$entry" | awk -F'@@' '{print $$2}'); \
		repl=$$(echo "$$entry" | awk -F'@@' '{print $$3}'); \
		name=$$(echo "$$entry" | awk -F'@@' '{print $$4}'); \
		echo "$$changed" | grep -qxF "$$src" || continue; \
		n=$$((n + 1)); \
		cp "$(ROOT)/$$src" "$$backup/$$n.bak"; echo "$$src" > "$$backup/$$n.bak.path"; \
		shasum "$(ROOT)/$$src" | cut -d" " -f1 > "$$backup/$$n.bak.sha"; \
		MUT_SRC="$(ROOT)/$$src" MUT_OLD="$$needle" MUT_NEW="$$repl" python3 -c \
			'import os,sys; p=os.environ["MUT_SRC"]; s=open(p).read(); o=os.environ["MUT_OLD"]; n=os.environ["MUT_NEW"]; open(p,"w").write(s.replace(o,n,1)) if o in s else (open(p,"w").write(s.replace(n,o,1)),sys.exit(2))[1] if n in s else sys.exit(1)'; rc=$$?; \
		case $$rc in \
			2) echo "  LEFTOVER MUTATION - $$name (repaired: replacement was in $$src without its needle)"; \
			   cp "$(ROOT)/$$src" "$$backup/$$n.bak"; shasum "$(ROOT)/$$src" | cut -d" " -f1 > "$$backup/$$n.bak.sha"; \
			   MUT_SRC="$(ROOT)/$$src" MUT_OLD="$$needle" MUT_NEW="$$repl" python3 -c \
			   'import os,sys; p=os.environ["MUT_SRC"]; s=open(p).read(); o=os.environ["MUT_OLD"]; open(p,"w").write(s.replace(o,os.environ["MUT_NEW"],1))' ;; \
			1) echo "  STALE - $$name (its needle is no longer in $$src)"; fail=1; \
			   cp "$$backup/$$n.bak" "$(ROOT)/$$src"; continue ;; \
		esac; \
		shasum "$(ROOT)/$$src" | cut -d" " -f1 > "$$backup/$$n.mut.sha"; \
		out=$$(bash "$(ROOT)/tests/swift/run_chat_sse_e2e.sh" 2>&1 || true); \
		if echo "$$out" | grep -qF "test(s) failed"; then \
			: "One failure could be the suite's own flake. Confirm it with a \
			   second run, mutation still applied."; \
			out2=$$(bash "$(ROOT)/tests/swift/run_chat_sse_e2e.sh" 2>&1 || true); \
			if echo "$$out2" | grep -qF "test(s) failed"; then \
				echo "  ok   - caught: $$name (failed twice)"; \
			elif echo "$$out2" | grep -qF "All ChatSSEEndToEnd tests passed"; then \
				echo "  FLAKY - the suite failed once and passed once with the mutation applied: $$name"; fail=1; \
			else \
				echo "  ERROR - the confirmation run never ran: $$name"; fail=1; \
				echo "$$out2" | head -5 | sed 's/^/         | /'; \
			fi; \
		elif echo "$$out" | grep -qF "All ChatSSEEndToEnd tests passed"; then \
			echo "  SURVIVED - $$name"; fail=1; \
		else \
			echo "  ERROR - the suite never ran: $$name"; fail=1; \
			echo "$$out" | head -5 | sed 's/^/         | /'; \
		fi; \
		if [ -f "$$backup/$$n.mut.sha" ]; then \
			now_sha=$$(shasum "$(ROOT)/$$src" | cut -d" " -f1); \
			if [ "$$now_sha" != "$$(cat "$$backup/$$n.mut.sha")" ]; then \
				echo "  [FAIL] $$src changed while the harness held it mutated."; \
				echo "         Restoring the backup would silently revert whoever wrote to it."; \
				echo "         The mutation is left in place; resolve by hand. Backup: $$backup/$$n.bak"; \
				fail=1; continue; \
			fi; \
		fi; \
		cp "$$backup/$$n.bak" "$(ROOT)/$$src"; \
	done; \
	: "logic-suite mutations whose source is dirty in the working tree"; \
	IFS='~'; for entry in $$(echo '$(MUTANTS_LOGIC)' | sed 's/ rings\//~rings\//g; s/ BR-OUTPUT\//~BR-OUTPUT\//g'); do \
		unset IFS; \
		src=$$(echo "$$entry" | awk -F'@@' '{print $$1}'); \
		needle=$$(echo "$$entry" | awk -F'@@' '{print $$2}'); \
		repl=$$(echo "$$entry" | awk -F'@@' '{print $$3}'); \
		suite=$$(echo "$$entry" | awk -F'@@' '{print $$4}'); \
		name=$$(echo "$$entry" | awk -F'@@' '{print $$5}'); \
		echo "$$changed" | grep -qxF "$$src" || continue; \
		n=$$((n + 1)); \
		cp "$(ROOT)/$$src" "$$backup/$$n.bak"; echo "$$src" > "$$backup/$$n.bak.path"; \
		shasum "$(ROOT)/$$src" | cut -d" " -f1 > "$$backup/$$n.bak.sha"; \
		MUT_SRC="$(ROOT)/$$src" MUT_OLD="$$needle" MUT_NEW="$$repl" python3 -c \
			'import os,sys; p=os.environ["MUT_SRC"]; s=open(p).read(); o=os.environ["MUT_OLD"]; n=os.environ["MUT_NEW"]; open(p,"w").write(s.replace(o,n,1)) if o in s else (open(p,"w").write(s.replace(n,o,1)),sys.exit(2))[1] if n in s else sys.exit(1)'; rc=$$?; \
		case $$rc in \
			2) echo "  LEFTOVER MUTATION - $$name (repaired: replacement was in $$src without its needle)"; \
			   cp "$(ROOT)/$$src" "$$backup/$$n.bak"; shasum "$(ROOT)/$$src" | cut -d" " -f1 > "$$backup/$$n.bak.sha"; \
			   MUT_SRC="$(ROOT)/$$src" MUT_OLD="$$needle" MUT_NEW="$$repl" python3 -c \
			   'import os,sys; p=os.environ["MUT_SRC"]; s=open(p).read(); o=os.environ["MUT_OLD"]; open(p,"w").write(s.replace(o,os.environ["MUT_NEW"],1))' ;; \
			1) echo "  STALE - $$name (its needle is no longer in $$src)"; fail=1; \
			   cp "$$backup/$$n.bak" "$(ROOT)/$$src"; continue ;; \
		esac; \
		: "clade-e2e prints the report path on stdout and its own summary on \
		   stderr AFTER it, so the two streams are captured separately: \
		   merging them would make tail -1 the summary, not the path."; \
		e2e_out="$$backup/$$n.clade-e2e.out"; e2e_err="$$backup/$$n.clade-e2e.err"; \
		(cd "$(ROOT)" && cargo run --quiet --bin clade-e2e) >"$$e2e_out" 2>"$$e2e_err" || true; \
		report=$$(tail -1 "$$e2e_out"); \
		if [ -f "$$report" ] && grep -qF "[FAIL] Swift logic tests ($$suite) FAILED" "$$report"; then \
			: "One failure could be the suite's own flake. Confirm it with a \
			   second run, mutation still applied."; \
			e2e_out2="$$backup/$$n.clade-e2e.confirm.out"; e2e_err2="$$backup/$$n.clade-e2e.confirm.err"; \
			(cd "$(ROOT)" && cargo run --quiet --bin clade-e2e) >"$$e2e_out2" 2>"$$e2e_err2" || true; \
			report2=$$(tail -1 "$$e2e_out2"); \
			if [ -f "$$report2" ] && grep -qF "[FAIL] Swift logic tests ($$suite) FAILED" "$$report2"; then \
				echo "  ok   - caught by $$suite: $$name (failed twice)"; \
			elif [ -f "$$report2" ] && grep -qF "[OK] Swift logic tests ($$suite): passed" "$$report2"; then \
				echo "  FLAKY - the suite failed once and passed once with the mutation applied: $$name"; fail=1; \
			else \
				echo "  ERROR - the confirmation run of $$suite never ran: $$name"; fail=1; \
				cat "$$e2e_err2" "$$e2e_out2" | head -5 | sed 's/^/         | /'; \
			fi; \
		elif [ -f "$$report" ] && grep -qF "[OK] Swift logic tests ($$suite): passed" "$$report"; then \
			echo "  SURVIVED - $$name"; fail=1; \
		else \
			echo "  ERROR - the $$suite suite never ran: $$name"; fail=1; \
			cat "$$e2e_err" "$$e2e_out" | head -5 | sed 's/^/         | /'; \
		fi; \
		if [ -f "$$backup/$$n.mut.sha" ]; then \
			now_sha=$$(shasum "$(ROOT)/$$src" | cut -d" " -f1); \
			if [ "$$now_sha" != "$$(cat "$$backup/$$n.mut.sha")" ]; then \
				echo "  [FAIL] $$src changed while the harness held it mutated."; \
				echo "         Restoring the backup would silently revert whoever wrote to it."; \
				echo "         The mutation is left in place; resolve by hand. Backup: $$backup/$$n.bak"; \
				fail=1; continue; \
			fi; \
		fi; \
		cp "$$backup/$$n.bak" "$(ROOT)/$$src"; \
	done; \
	if [ $$fail -eq 0 ]; then echo "[OK] every working-tree mutation was caught ($$n of $$total mutations selected)"; \
	else echo "[FAIL] a working-tree mutation survived, went stale, failed only once, or was not measured ($$n of $$total mutations selected)"; exit 1; fi

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

# --- Backlog audit ------------------------------------------------------
#
# The backlog the Queen chooses from is never reconciled with the tree, and an
# issue finished cycles ago was still proposed at every launch (#1228).  This
# target reads the open sub-issues of epic #1090 from the GitHub timeline API
# and, for each one, prints one line: the issue number, whether every file
# named under its Границы heading exists, whether identifiers from its Готово
# когда section appear in those files, and a verdict.
#
#   looks-done    files exist and every identifier is found in them — the
#                 suspicious case the audit exists to surface.
#   looks-open    files listed under Границы are absent, or identifiers from
#                 Готово когда are not found in the files.
#   cannot-tell   the issue has no Границы heading (no files to check) or no
#                 backtick-quoted identifiers in its Готово когда section.
#
# It only reports — it never closes an issue, writes to the forge, or fails the
# build.  Authentication uses GITHUB_TOKEN, GH_TOKEN, or gh auth token in that
# order; without any of them the call is unauthenticated and may hit the rate
# limit.
#
# A REPORT, and now it says so in its own first line, because that sentence
# above lives in the Makefile where only its author reads it.  Two reasons no
# threshold belongs here, and neither is squeamishness:
#
#   Its subject is not the tree.  The input is the GitHub timeline, so the
#   verdicts move when an issue is edited, when the token is missing, and when
#   the rate limit bites - and a gate that goes red because a network call was
#   throttled is a gate that gets switched off in a week.  `make mutants`
#   already records the same fact from the other side: no tree mutation has any
#   lever on this target at all.
#
#   And its verdicts are not claims about correctness.  looks-done means "an
#   identifier that appears in the issue also appears in the file", which is a
#   grep, not a proof; the audit exists to make a human LOOK at that issue.
#   Failing a build on a grep-shaped suspicion would teach everyone to phrase
#   issues so the grep misses.
.PHONY: backlog-audit
backlog-audit:
	@f=$$(mktemp /tmp/trios_backlog.XXXXXX); \
	printf '%s\n' \
		'import json, subprocess, re, os, sys' \
		'' \
		'print("-- REPORT: suspicions to look at, not a verdict. This target reads the GitHub")' \
		'print("   timeline and the tree, never writes to either, and always exits 0.")' \
		'print("")' \
		'' \
		'ROOT = os.environ.get("ROOT", ".")' \
		'headers = ["-H", "Accept: application/vnd.github+json"]' \
		'token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")' \
		'if not token:' \
		'    try:' \
		'        r = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=5)' \
		'        if r.returncode == 0 and r.stdout.strip():' \
		'            token = r.stdout.strip()' \
		'    except Exception:' \
		'        pass' \
		'if token:' \
		'    headers += ["-H", "Authorization: Bearer " + token]' \
		'' \
		'def fetch(url):' \
		'    r = subprocess.run(["curl", "-s"] + headers + [url], capture_output=True, text=True)' \
		'    return json.loads(r.stdout)' \
		'' \
		'def fetch_timeline(base):' \
		'    results = []' \
		'    page = 1' \
		'    while True:' \
		'        sep = "&" if "?" in base else "?"' \
		'        items = fetch(base + sep + "page=" + str(page) + "&per_page=100")' \
		'        if not isinstance(items, list):' \
		'            return items' \
		'        results.extend(items)' \
		'        if len(items) < 100:' \
		'            break' \
		'        page += 1' \
		'    return results' \
		'' \
		'fixture = os.environ.get("BACKLOG_FIXTURE")' \
		'try:' \
		'    if fixture:' \
		'        timeline = json.loads(open(fixture).read())' \
		'    else:' \
		'        timeline = fetch_timeline("https://api.github.com/repos/gHashTag/trios/issues/1090/timeline")' \
		'except Exception:' \
		'    print("cannot-tell: timeline fetch failed")' \
		'    sys.exit(0)' \
		'' \
		'if not isinstance(timeline, list):' \
		'    print("cannot-tell: " + str(timeline.get("message", "unknown error")))' \
		'    sys.exit(0)' \
		'' \
		'issues = {}' \
		'for e in timeline:' \
		'    if e.get("event") != "cross-referenced":' \
		'        continue' \
		'    issue = e.get("source", {}).get("issue", {})' \
		'    n = issue.get("number")' \
		'    if n and n != 1090:' \
		'        issues[n] = issue' \
		'' \
		'for n in sorted(issues):' \
		'    issue = issues[n]' \
		'    if issue.get("state") != "open":' \
		'        continue' \
		'    body = issue.get("body", "") or ""' \
		'    sections = {}' \
		'    current = None' \
		'    for line in body.split("\n"):' \
		'        m = re.match(r"^##\s+(.+)", line)' \
		'        if m:' \
		'            current = m.group(1).strip()' \
		'            sections[current] = []' \
		'        elif current is not None:' \
		'            sections[current].append(line)' \
		'    files = []' \
		'    for heading in sections:' \
		'        if "\u0413\u0440\u0430\u043d\u0438\u0446\u044b" in heading or "Boundar" in heading:' \
		'            block = "\n".join(sections[heading])' \
		'            files = re.findall(r"`([^`]+)`", block)' \
		'            break' \
		'    idents = []' \
		'    for heading in sections:' \
		'        if "\u0413\u043e\u0442\u043e\u0432\u043e" in heading:' \
		'            block = "\n".join(sections[heading])' \
		'            raw = re.findall(r"`([^`]+)`", block)' \
		'            idents = [x for x in raw if re.match(r"^[A-Za-z_][\w.():]*$$", x)]' \
		'            break' \
		'    if not files:' \
		'        print("#" + str(n) + "  files=none  identifiers=n/a  verdict=cannot-tell")' \
		'        continue' \
		'    all_files_exist = all(os.path.exists(os.path.join(ROOT, f)) for f in files)' \
		'    if not all_files_exist:' \
		'        print("#" + str(n) + "  files=missing  identifiers=n/a  verdict=cannot-tell")' \
		'        continue' \
		'    if not idents:' \
		'        print("#" + str(n) + "  files=present  identifiers=none  verdict=judge-by-driving")' \
		'        continue' \
		'    all_found = True' \
		'    for ident in idents:' \
		'        hit = False' \
		'        for f in files:' \
		'            path = os.path.join(ROOT, f)' \
		'            if os.path.exists(path):' \
		'                content = open(path, errors="ignore").read()' \
		'                if ident in content:' \
		'                    hit = True' \
		'                    break' \
		'        if not hit:' \
		'            all_found = False' \
		'            break' \
		'    if all_found:' \
		'        print("#" + str(n) + "  files=present  identifiers=found  verdict=looks-done")' \
		'    else:' \
	'        print("#" + str(n) + "  files=present  identifiers=not-found  verdict=looks-open")' \
	'' \
	'print("")' \
	'print("cannot-tell: no boundary section or boundary files are missing -- nothing to read")' \
	'print("judge-by-driving: criteria are behavioural (no identifiers named) -- verify by running the feature")' \
	'print("looks-done: every named identifier was found in the boundary files")' \
	'print("looks-open: named identifiers are absent from the boundary files")' \
	> $$f; \
	ROOT="$(ROOT)" python3 $$f; \
	rc=$$?; rm -f $$f; exit $$rc

# --- Self-test of the guards ---------------------------------------------
#
# Both instruments here have misled me once each, and a check that has never
# been caught failing cannot be trusted passing.  This target makes each guard
# prove itself: plant what it forbids, watch it fail; remove it, watch it pass.
#
# Not in `make check`: it writes to a source file, and a self-test that runs on
# every build is one that gets switched off.
#
# The restores are not blind.  For the length of this recipe two files that
# other agents also write to - rings/SR-00/QueenObserver.swift and this
# Makefile - are held mutated, and a plain `cp backup file` at the end of that
# window reverts whatever they wrote inside it, silently, then reports success.
# So each file carries the checksum of the state THIS recipe last left on disk,
# and every further write re-reads the file first.  On a mismatch there is no
# safe move - restoring reverts their write, mutating overwrites it - so the
# recipe refuses to write at all, names the file and its pre-harness copy, and
# stops.  Verifying a restore against a checksum taken from the same file
# before it was backed up, which is what this used to do, cannot fail: it
# compares the copy with the thing it was copied from.  Same hole as `make
# mutants` had, same fix (b4d1946fe).
.PHONY: check-selftest
check-selftest:
	@fail=0; \
	victim="$(ROOT)/rings/SR-00/QueenObserver.swift"; \
	backup=$$(mktemp); \
	sf="$(ROOT)/.selftest_boundary.swift"; \
	ba=$$(mktemp /tmp/trios_selftest_ba.XXXXXX); \
	cp "$$victim" "$$backup"; \
	victim_sha=$$(shasum "$$victim" | cut -d" " -f1); \
	md_file="$(ROOT)/Makefile"; \
	md_backup=$$(mktemp); \
	cp "$$md_file" "$$md_backup"; \
	md_sha=$$(shasum "$$md_file" | cut -d" " -f1); \
	: "held_victim / held_md are the sha of the state this recipe last left on"; \
	: "disk.  claim_* re-reads the file and refuses when it no longer holds it."; \
	: "A held sha is never taken by reading the file back after writing to it:"; \
	: "a writer that lands between the write and that read is measured INTO the"; \
	: "expected state and then restored away.  Driven on #1266 - a poll loop beat"; \
	: "the shasum every time.  So each mutation is composed in a temp file first"; \
	: "and the sha comes from the bytes we are about to write, not from disk."; \
	vt=$$(mktemp); mt=$$(mktemp); \
	held_victim=$$victim_sha; held_md=$$md_sha; \
	lost_victim=0; lost_md=0; \
	still_held() { [ "$$(shasum "$$1" 2>/dev/null | cut -d" " -f1)" = "$$2" ]; }; \
	refuse() { \
		echo "  [FAIL] $$1 changed while check-selftest held it."; \
		echo "         Writing to it now would silently discard that change, so"; \
		echo "         the file is left exactly as it stands; resolve by hand."; \
		echo "         Pre-harness copy of the file: $$2"; \
		fail=1; \
	}; \
	claim_victim() { \
		still_held "$$victim" "$$held_victim" && return 0; \
		refuse "$$victim" "$$backup"; lost_victim=1; return 1; \
	}; \
	claim_md() { \
		still_held "$$md_file" "$$held_md" && return 0; \
		refuse "$$md_file" "$$md_backup"; lost_md=1; return 1; \
	}; \
	mutate_victim() { \
		claim_victim || return 1; \
		: "A real call, on a code line. This fixture used to be the comment"; \
		: "'// check-selftest SecItemAdd', so for its whole life it proved only"; \
		: "that the gate greps for a WORD - and a gate validated against prose"; \
		: "cannot tell prose from a door. That gap surfaced the moment a comment"; \
		: "in a test explained why the keychain must not be touched and the gate"; \
		: "called it a violation."; \
		{ cat "$$backup"; \
		  printf '\nimport Security\n'; \
		  printf 'private func checkSelftestKeychainDoor() {\n'; \
		  printf '    _ = SecItemAdd([:] as CFDictionary, nil)\n'; \
		  printf '}\n'; } > "$$vt"; \
		held_victim=$$(shasum "$$vt" | cut -d" " -f1); \
		cp "$$vt" "$$victim"; \
	}; \
	empty_victim() { \
		claim_victim || return 1; \
		held_victim=$$(printf '' | shasum | cut -d" " -f1); \
		: > "$$victim"; \
	}; \
	mutate_md() { \
		claim_md || return 1; \
		{ cat "$$md_backup"; printf '\techo "$$PLANTED_BUG"\n'; } > "$$mt"; \
		held_md=$$(shasum "$$mt" | cut -d" " -f1); \
		cp "$$mt" "$$md_file"; \
	}; \
	restore_victim() { \
		claim_victim || return 1; \
		cp "$$backup" "$$victim" || { \
			echo "  [FAIL] could not restore $$victim from $$backup"; fail=1; return 1; \
		}; \
		held_victim=$$victim_sha; \
	}; \
	restore_md() { \
		claim_md || return 1; \
		cp "$$md_backup" "$$md_file" || { \
			echo "  [FAIL] could not restore $$md_file from $$md_backup"; fail=1; return 1; \
		}; \
		held_md=$$md_sha; \
	}; \
	cleanup() { \
		crc=$$1; trap - EXIT INT TERM; \
		[ $$lost_victim -eq 0 ] && restore_victim; \
		[ $$lost_md -eq 0 ] && restore_md; \
		rm -f "$$sf" "$$ba" "$$vt" "$$mt" 2>/dev/null; \
		: "a refused file keeps its backup - that path is the only way back"; \
		[ $$lost_victim -eq 0 ] && rm -f "$$backup"; \
		[ $$lost_md -eq 0 ] && rm -f "$$md_backup"; \
		rm -rf "$(HARNESS_LOCK)" 2>/dev/null; \
		[ $$fail -ne 0 ] && crc=1; \
		exit $$crc; \
	}; \
	: "ONE POLICY FOR ONE LOCK, 2026-08-25 (second pass). Six targets use"; \
	: "this lock. cassettes waited; the other five refused instantly and"; \
	: "exited 1 while printing Nothing here is broken - a gate that fails"; \
	: "for a scheduling collision while announcing it is not a failure."; \
	: "The first pass fixed ONE of the five, because I counted two users"; \
	: "and never counted the rest. Waiting is right for all of them: the"; \
	: "runs are legitimate, neither agent knows about the other, and these"; \
	: "targets mutate real source files. Exiting 0 would be worse - check"; \
	: "green without the coverage having run is UNCHECKED read as agreed."; \
	waited=0; \
	while :; do \
		owner_pid=$$(cat "$(HARNESS_LOCK)/pid" 2>/dev/null || true); \
		if mkdir "$(HARNESS_LOCK)" 2>/dev/null; then break; fi; \
		if [ -n "$$owner_pid" ] && ! kill -0 $$owner_pid 2>/dev/null; then \
			echo "[INFO] reclaiming harness lock from dead PID $$owner_pid"; \
			rm -rf "$(HARNESS_LOCK)"; continue; \
		fi; \
		if [ $$waited -ge $(HARNESS_LOCK_WAIT) ]; then \
			echo "[FAIL] another harness run has held $(HARNESS_LOCK) for $(HARNESS_LOCK_WAIT)s"; \
			echo "       (owner PID $$owner_pid). Not waiting further."; \
			rm -f "$$backup" "$$sf" "$$ba" "$$md_backup"; exit 1; \
		fi; \
		if [ $$waited = 0 ]; then \
			echo "[harness] another run holds the lock (PID $$owner_pid); waiting"; \
		fi; \
		sleep 5; waited=$$((waited + 5)); \
	done; \
	[ $$waited -gt 0 ] && echo "[harness] acquired the lock after $${waited}s" || true; \
	echo $$$$ > "$(HARNESS_LOCK)/pid"; \
	trap 'rc=$$?; cleanup $$rc' EXIT INT TERM; \
	mutate_victim || exit 1; \
	if $(MAKE) --no-print-directory keychain-doors >/dev/null 2>&1; then \
		kd_caught=0; \
	else \
		kd_caught=1; \
	fi; \
	restore_victim || exit 1; \
	if $(MAKE) --no-print-directory keychain-doors >/dev/null 2>&1; then \
		kd_clean=1; \
	else \
		kd_clean=0; \
	fi; \
	restore_victim || exit 1; \
	if [ $$kd_caught -eq 1 ] && [ $$kd_clean -eq 1 ]; then \
		echo "keychain-doors: caught the bad case and passed the good one"; \
	else \
		echo "keychain-doors: FAILED (caught=$$kd_caught clean=$$kd_clean)"; fail=1; \
	fi; \
	ba_good=$$(BACKLOG_FIXTURE="$(ROOT)/tests/fixtures/backlog-good.json" $(MAKE) --no-print-directory backlog-audit 2>&1); \
	ba_bad=$$(BACKLOG_FIXTURE="$(ROOT)/tests/fixtures/backlog-bad.json" $(MAKE) --no-print-directory backlog-audit 2>&1); \
	if echo "$$ba_good" | grep -q "verdict=looks-done" && echo "$$ba_bad" | grep -q "verdict=looks-open"; then \
		echo "backlog-audit: distinguished good fixture (looks-done) from bad (looks-open)"; \
	else \
		echo "backlog-audit: FAILED"; fail=1; \
	fi; \
	mutate_md || exit 1; \
	if $(MAKE) --no-print-directory make-dollars >/dev/null 2>&1; then \
		md_caught=0; \
	else \
		md_caught=1; \
	fi; \
	restore_md || exit 1; \
	if $(MAKE) --no-print-directory make-dollars >/dev/null 2>&1; then \
		md_clean=1; \
	else \
		md_clean=0; \
	fi; \
	restore_md || exit 1; \
	if [ $$md_caught -eq 1 ] && [ $$md_clean -eq 1 ]; then \
		echo "make-dollars: caught the bad case and passed the good one"; \
	else \
		echo "make-dollars: FAILED (caught=$$md_caught clean=$$md_clean)"; fail=1; \
	fi; \
	restore_victim || exit 1; \
	empty_victim || exit 1; \
	if $(MAKE) --no-print-directory empty-sources >/dev/null 2>&1; then \
		es_caught=0; \
	else \
		es_caught=1; \
	fi; \
	restore_victim || exit 1; \
	if $(MAKE) --no-print-directory empty-sources >/dev/null 2>&1; then \
		es_clean=1; \
	else \
		es_clean=0; \
	fi; \
	restore_victim || exit 1; \
	if [ $$es_caught -eq 1 ] && [ $$es_clean -eq 1 ]; then \
		echo "empty-sources: caught the bad case and passed the good one"; \
	else \
		echo "empty-sources: FAILED (caught=$$es_caught clean=$$es_clean)"; fail=1; \
	fi; \
	if [ $$fail -ne 0 ]; then exit 1; fi

