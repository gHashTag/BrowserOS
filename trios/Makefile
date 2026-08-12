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
# The harness lock records its owner's PID.  An interrupted run leaves a
# lock behind; the next run reads the PID, checks whether the owner is
# still alive, and reclaims a dead owner's lock with a word about it.
HARNESS_LOCK := /tmp/trios_harness.lock

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
	@echo "  make doctor     - report the state of both variants"
	@echo "  make chat-probe - send a real message and report whether the agent answered"
	@echo "  make verify     - build, relaunch, and prove the chat answers (use after every change)"
	@echo "  make clean      - remove build products for both variants"
	@echo "  make mutants    - break known guards and require the SSE suite to notice"
	@echo "  make mutants-logic - the same, for guards a clade-e2e logic suite owns"
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
WARNING_CEILING := 4

# Where the per-file warning cache lives. Inside the dev object directory on
# purpose: its lifetime is the objects' lifetime.
WARN_BUILD_DIR := $(ROOT)/.trinity/build/dev
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
KEYCHAIN_ALLOWLIST := rings/SR-00/KeychainSecrets.swift rings/SR-00/KeychainSymmetricKeyStore.swift rings/SR-00/ModelConfigurationStore.swift BR-OUTPUT/ProjectPaths.swift
KEYCHAIN_ALLOW_PATTERNS := $(addprefix -e ,$(KEYCHAIN_ALLOWLIST))

.PHONY: keychain-doors
keychain-doors:
	@offending=$$(/usr/bin/grep -rlE 'SecItem(CopyMatching|Add|Update|Delete)' \
		--include='*.swift' --exclude-dir='.build' --exclude-dir='.git' \
		--exclude-dir='.worktrees' --exclude-dir='trios_dev_app' --exclude-dir='trios_app' \
		"$(ROOT)" \
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
MAKE_DOLLAR_VARS := ROOT DEV_APP RELEASE_APP WARNING_CEILING CASSETTE_DIR \
	WARN_BUILD_DIR WARN_OFM WARN_LIST WARN_SEEN WARN_LOG WARN_LOG_DIR \
	WARN_LOG_LAST WARN_BUILD_ID WARN_FULL_ROOT WARN_FULL_CACHE DEV_BUILD_LOCK \
	CASSETTE_BRANCHES SWEEP_CANARY LOG KEYCHAIN_ALLOW_PATTERNS MAKE VARIANT \
	MSG ISSUE WORKER TASK PATHS CRITERIA SECOND REVIEW AUTONOMY CASSETTE \
	SECOND_TURN QUEEN_COMMAND MUTANTS MUTANTS_LOGIC MAKE_DOLLAR_VARS HARNESS_LOCK GUARDS \
	VENDOR_SRC VENDOR_BEGIN VENDOR_END VENDOR_ANCHOR VENDOR_HALVES

.PHONY: make-dollars
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
	if [ $$fail -ne 0 ]; then exit 1; fi

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
	rings/SR-02/ChatViewModel.swift@@queenInboxPollTask = Task@@if ProjectPaths.isDevVariant {@@8@@guards/inbox-poller-unguarded.swift@@a release build polls the dev Queen inbox (1150)~ \
	rings/SR-02/ChatViewModel.swift@@let path = Self.queenInboxPath@@guard ProjectPaths.isDevVariant else { return }@@3@@guards/inbox-read-unguarded.swift@@a release build reads the dev Queen inbox from any caller (1090)~ \
	rings/SR-02/ChatViewModel.swift@@let entry = QueenInboxEntry(@@guard ProjectPaths.isDevVariant else {@@10@@guards/inbox-enqueue-unguarded.swift@@a release build queues delegations into the dev Queen inbox (1090)~ \
	rings/SR-00/KeychainSecrets.swift@@DevSecretStore.read(service: service, account: account)@@if ProjectPaths.isDevVariant {@@4@@guards/dev-secret-store-unguarded.swift@@a release build reads secrets from the plaintext dev store~ \
	rings/SR-00/TriOSEncryption.swift@@return try loadOrCreateTestKey()@@if ProcessInfo.processInfo.environment["TRIOS_E2E_DISABLE_KEYCHAIN"] == "1" {@@4@@guards/test-key-unguarded.swift@@every build derives its data key from a volatile test file~ \
	rings/SR-02/ChatViewModel.swift@@if connectivityFailedTasks.contains(task.id), let runner = workerRunner {@@guard !QueenDelegationPolicy.isStreamOpen(current) else { continue }@@8@@guards/reaper-unguarded.swift@@the reaper stops consulting the stream-open predicate and takes live workers mid-answer~ \
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

check: check-selftest keychain-doors make-dollars empty-sources finish-mark-order guard-shapes parse-tests vendor-step dev warnings test cassettes mutants-changed

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
	@if pgrep -f "trios-dev.app/Contents/MacOS" >/dev/null 2>&1; then \
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
# The smallest extension that WOULD fit the rest (described, not built):
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
	owner_pid=$$(cat "$(HARNESS_LOCK)/pid" 2>/dev/null || true); \
	if ! mkdir "$(HARNESS_LOCK)" 2>/dev/null; then \
		if [ -n "$$owner_pid" ] && ! kill -0 $$owner_pid 2>/dev/null; then \
			echo "[INFO] reclaiming harness lock from dead PID $$owner_pid"; \
			rm -rf "$(HARNESS_LOCK)"; \
		fi; \
		if ! mkdir "$(HARNESS_LOCK)" 2>/dev/null; then \
			if [ -n "$$owner_pid" ]; then \
				echo "[FAIL] a harness run is already in progress ($(HARNESS_LOCK), owner PID $$owner_pid)"; \
			else \
				echo "[FAIL] a harness run is already in progress ($(HARNESS_LOCK))"; \
			fi; \
			rm -rf $$backup; exit 1; \
		fi; \
	fi; \
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
	owner_pid=$$(cat "$(HARNESS_LOCK)/pid" 2>/dev/null || true); \
	if ! mkdir "$(HARNESS_LOCK)" 2>/dev/null; then \
		if [ -n "$$owner_pid" ] && ! kill -0 $$owner_pid 2>/dev/null; then \
			echo "[INFO] reclaiming harness lock from dead PID $$owner_pid"; \
			rm -rf "$(HARNESS_LOCK)"; \
		fi; \
		if ! mkdir "$(HARNESS_LOCK)" 2>/dev/null; then \
			if [ -n "$$owner_pid" ]; then \
				echo "[FAIL] a harness run is already in progress ($(HARNESS_LOCK), owner PID $$owner_pid)"; \
			else \
				echo "[FAIL] a harness run is already in progress ($(HARNESS_LOCK))"; \
			fi; \
			rm -rf $$backup; exit 1; \
		fi; \
	fi; \
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
	owner_pid=$$(cat "$(HARNESS_LOCK)/pid" 2>/dev/null || true); \
	if ! mkdir "$(HARNESS_LOCK)" 2>/dev/null; then \
		if [ -n "$$owner_pid" ] && ! kill -0 $$owner_pid 2>/dev/null; then \
			echo "[INFO] reclaiming harness lock from dead PID $$owner_pid"; \
			rm -rf "$(HARNESS_LOCK)"; \
		fi; \
		if ! mkdir "$(HARNESS_LOCK)" 2>/dev/null; then \
			if [ -n "$$owner_pid" ]; then \
				echo "[FAIL] a harness run is already in progress ($(HARNESS_LOCK), owner PID $$owner_pid)"; \
			else \
				echo "[FAIL] a harness run is already in progress ($(HARNESS_LOCK))"; \
			fi; \
			rm -rf $$backup; exit 1; \
		fi; \
	fi; \
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
.PHONY: backlog-audit
backlog-audit:
	@f=$$(mktemp /tmp/trios_backlog.XXXXXX); \
	printf '%s\n' \
		'import json, subprocess, re, os, sys' \
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
		{ cat "$$backup"; printf '\n// check-selftest SecItemAdd\n'; } > "$$vt"; \
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
	owner_pid=$$(cat "$(HARNESS_LOCK)/pid" 2>/dev/null || true); \
	if ! mkdir "$(HARNESS_LOCK)" 2>/dev/null; then \
		if [ -n "$$owner_pid" ] && ! kill -0 $$owner_pid 2>/dev/null; then \
			echo "[INFO] reclaiming harness lock from dead PID $$owner_pid"; \
			rm -rf "$(HARNESS_LOCK)"; \
		fi; \
		if ! mkdir "$(HARNESS_LOCK)" 2>/dev/null; then \
			if [ -n "$$owner_pid" ]; then \
				echo "[FAIL] a harness run is already in progress ($(HARNESS_LOCK), owner PID $$owner_pid)"; \
			else \
				echo "[FAIL] a harness run is already in progress ($(HARNESS_LOCK))"; \
			fi; \
			rm -f "$$backup" "$$sf" "$$ba" "$$md_backup"; exit 1; \
		fi; \
	fi; \
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

