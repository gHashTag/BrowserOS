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
.PHONY: help dev release build keychain-doors make-dollars empty-sources watch-empties check test cassettes e2e run run-release stop clean promote doctor chat-probe verify restart xctest delegate-probe drift-guard finish-mark-order guard-shapes parse-tests

help:
	@echo "TriOS targets:"
	@echo "  make            - build the DEV app (safe default; never touches the release)"
	@echo "  make dev        - same as above"
	@echo "  make release    - build the RELEASE app (deliberate; replaces trios.app)"
	@echo "  make check      - build dev and run every logic suite, including mutants-changed"
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
	@echo "  make mutants-changed - run mutations for guarded files dirty in the working tree"
	@echo "  make drift-guard - run the interface-drift compiling proof (slow; not in the fast suite)"
	@echo "  make finish-mark-order - check the completed-turn mark stays in the finish callback"
	@echo "  make guard-shapes - check the load-bearing guards are still in their files"

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
			| /usr/bin/grep -oE "^$(ROOT)/[^:]+\.swift:[0-9]+:[0-9]+: warning: " | sort -u | wc -l | tr -d ' '); \
		if [ "$$warnings" -gt $(WARNING_CEILING) ]; then \
			echo "[FAIL] $$warnings compiler warnings; the ceiling is $(WARNING_CEILING)."; \
			awk '/Copied and signed/{exit} {print}' /tmp/trios_build_dev.log \
				| /usr/bin/grep -oE "^$(ROOT)/[^:]+\.swift:[0-9]+:[0-9]+: warning: .*" \
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
	CASSETTE_BRANCHES SWEEP_CANARY LOG KEYCHAIN_ALLOW_PATTERNS MAKE VARIANT \
	MSG ISSUE WORKER TASK PATHS CRITERIA SECOND REVIEW AUTONOMY CASSETTE \
	SECOND_TURN QUEEN_COMMAND MUTANTS MUTANTS_LOGIC MAKE_DOLLAR_VARS HARNESS_LOCK GUARDS

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

check: check-selftest keychain-doors make-dollars empty-sources finish-mark-order guard-shapes parse-tests dev test cassettes mutants-changed

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
MUTANTS := \
	rings/SR-00/QueenObserver.swift@@lowered.contains("write") || lowered.contains("edit")@@lowered.contains("write")@@the boundary detector forgets edit-shaped tools \
	rings/SR-02/QueenDelegationRegistry.swift@@if criteria.contains(criterion) {@@if true {@@a verdict is accepted for a criterion the task never had \
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
	trap 'cp "$$backup" "$$victim" 2>/dev/null; vs=$$(shasum "$$victim" | cut -d" " -f1 2>/dev/null); if [ -n "$$victim_sha" ] && [ "$$vs" != "$$victim_sha" ]; then echo "[FAIL] restore checksum mismatch for $$victim" >&2; fi; cp "$$md_backup" "$$md_file" 2>/dev/null; ms=$$(shasum "$$md_file" | cut -d" " -f1 2>/dev/null); if [ -n "$$md_sha" ] && [ "$$ms" != "$$md_sha" ]; then echo "[FAIL] restore checksum mismatch for $$md_file" >&2; fi; rm -f "$$backup" "$$sf" "$$ba" "$$md_backup" 2>/dev/null; rm -rf "$(HARNESS_LOCK)" 2>/dev/null' EXIT INT TERM; \
	printf '\n// check-selftest SecItemAdd\n' >> "$$victim"; \
	if $(MAKE) --no-print-directory keychain-doors >/dev/null 2>&1; then \
		kd_caught=0; \
	else \
		kd_caught=1; \
	fi; \
	cp "$$backup" "$$victim"; \
	if $(MAKE) --no-print-directory keychain-doors >/dev/null 2>&1; then \
		kd_clean=1; \
	else \
		kd_clean=0; \
	fi; \
	cp "$$backup" "$$victim"; \
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
	printf '\techo "$$PLANTED_BUG"\n' >> "$$md_file"; \
	if $(MAKE) --no-print-directory make-dollars >/dev/null 2>&1; then \
		md_caught=0; \
	else \
		md_caught=1; \
	fi; \
	cp "$$md_backup" "$$md_file"; \
	if $(MAKE) --no-print-directory make-dollars >/dev/null 2>&1; then \
		md_clean=1; \
	else \
		md_clean=0; \
	fi; \
	cp "$$md_backup" "$$md_file"; \
	if [ $$md_caught -eq 1 ] && [ $$md_clean -eq 1 ]; then \
		echo "make-dollars: caught the bad case and passed the good one"; \
	else \
		echo "make-dollars: FAILED (caught=$$md_caught clean=$$md_clean)"; fail=1; \
	fi; \
	cp "$$backup" "$$victim"; \
	: > "$$victim"; \
	if $(MAKE) --no-print-directory empty-sources >/dev/null 2>&1; then \
		es_caught=0; \
	else \
		es_caught=1; \
	fi; \
	cp "$$backup" "$$victim"; \
	if $(MAKE) --no-print-directory empty-sources >/dev/null 2>&1; then \
		es_clean=1; \
	else \
		es_clean=0; \
	fi; \
	cp "$$backup" "$$victim"; \
	if [ $$es_caught -eq 1 ] && [ $$es_clean -eq 1 ]; then \
		echo "empty-sources: caught the bad case and passed the good one"; \
	else \
		echo "empty-sources: FAILED (caught=$$es_caught clean=$$es_clean)"; fail=1; \
	fi; \
	if [ $$fail -ne 0 ]; then exit 1; fi

