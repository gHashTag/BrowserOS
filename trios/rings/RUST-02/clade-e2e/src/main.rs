use chrono::Local;
use reqwest::blocking::get;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const MAX_RESPONSE_BYTES: usize = 1024 * 1024; // 1MB - matches clade-diff

/// Cap an HTTP response body so a misbehaving/oversized response can't blow up
/// the report (consistency with clade-diff's MAX_RESPONSE_BYTES guard).
fn cap_body(body: String) -> String {
    if body.len() > MAX_RESPONSE_BYTES {
        format!("error: response too large ({}KB)", body.len() / 1024)
    } else {
        body
    }
}

struct Variant {
    name: &'static str,
    mcp_port: &'static str,
    app_pattern: &'static str,
    log_process: &'static str,
}

fn main() {
    let variant_name = env::var("TRIOS_VARIANT").unwrap_or_else(|_| "prod".into());
    let v = resolve_variant(&variant_name);
    let log_dir = PathBuf::from(format!("{}/.trinity/e2e", trios_config::project_dir()));
    fs::create_dir_all(&log_dir).ok();

    let ts = Local::now().timestamp();
    let report_path = log_dir.join(format!("report_{}_{}.md", v.name, ts));
    let screenshot_path = log_dir.join(format!("screenshot_{}_{}.png", v.name, ts));

    let mut report = format!(
        "# TRIOS E2E Report {} - Variant: {}\n\n",
        Local::now().to_rfc2822(),
        v.name
    );
    let mut failures = 0u32;

    // 0. Swift logic unit tests (pre-flight, no running app required)
    if !run_swift_logic_tests(&mut report) {
        failures += 1;
    }

    // 1. Server Health
    let health_url = format!("http://127.0.0.1:{}/health", v.mcp_port);
    match get(&health_url) {
        Ok(resp) => {
            let body = cap_body(resp.text().unwrap_or_default());
            if body.contains("\"status\":\"ok\"") {
                report.push_str(&format!(
                    "- [OK] BrowserOS Server ({}): OK ({})\n",
                    v.name, body
                ));
            } else {
                report.push_str(&format!(
                    "- [FAIL] BrowserOS Server ({}): DOWN ({})\n",
                    v.name, body
                ));
                failures += 1;
            }
        }
        Err(e) => {
            report.push_str(&format!(
                "- [FAIL] BrowserOS Server ({}): DOWN ({})\n",
                v.name, e
            ));
            failures += 1;
        }
    }

    // 2. App Running
    let pid = Command::new("pgrep")
        .args(["-f", v.app_pattern])
        .stdout(Stdio::piped())
        .output()
        .ok()
        .and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        });

    if let Some(ref p) = pid {
        report.push_str(&format!("- [OK] Trios App ({}): PID {}\n", v.name, p));
    } else {
        report.push_str(&format!("- [FAIL] Trios App ({}): NOT RUNNING\n", v.name));
        failures += 1;
    }

    // 3. Screenshot
    let _ = Command::new("screencapture")
        .args([
            "-x",
            screenshot_path
                .to_str()
                .unwrap_or("trios_screenshot.png"),
        ])
        .output();
    report.push_str(&format!(
        "- [IMG] Screenshot ({}): {}\n",
        v.name,
        screenshot_path.display()
    ));

    // 4. Log Errors (last 5 min)
    let log_output = Command::new("log")
        .args([
            "show",
            "--predicate",
            &format!("process == \"{}\"", v.log_process),
            "--last",
            "5m",
            "--style",
            "compact",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok();

    let errors: Vec<String> = log_output
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
        .lines()
        .filter(|l| {
            let lower = l.to_lowercase();
            lower.contains("timed out")
                || lower.contains("transporterror")
                || lower.contains("crash")
                || lower.contains("fatal")
                || lower.contains("error")
        })
        .take(5)
        .map(|s| s.to_string())
        .collect();

    if errors.is_empty() {
        report.push_str(&format!(
            "- [OK] No critical errors in last 5m ({})\n",
            v.name
        ));
    } else {
        report.push_str(&format!("- [U+26A0][U+FE0F] Recent Errors ({})\n", v.name));
        report.push_str("```\n");
        for e in errors {
            report.push_str(&e);
            report.push('\n');
        }
        report.push_str("```\n");
    }

    // 5. UI Anomaly Checklist
    report.push_str(&format!("\n## UI Anomaly Checklist ({})\n", v.name));
    report.push_str("- [ ] Title bar shows correct status (Online green dot, A2A blue dot)\n");
    report.push_str(
        "- [ ] Tab bar icons visible and not duplicated (Chat/Git/Terminal/Queen/Settings)\n",
    );
    report
        .push_str("- [ ] Chat input field visible at bottom with placeholder 'Ask anything...'\n");
    report.push_str("- [ ] No overlapping views, no black rectangles, no glitched rendering\n");
    report.push_str("- [ ] Glassmorphism blur visible behind panel content\n");
    report.push_str("- [ ] Messages scroll correctly without cutting off bubbles\n");
    report.push_str("- [ ] No duplicate headers or buttons outside tab bar\n");

    if let Err(e) = fs::write(&report_path, &report) {
        eprintln!("[e2e] Failed to write report: {}", e);
    }
    println!("{}", report_path.display());

    if failures > 0 {
        eprintln!("[e2e] {} check(s) failed", failures);
        std::process::exit(1);
    }
}

/// One standalone Swift logic suite: the test file plus the sources it needs.
/// Each suite compiles on its own, so a suite only pulls in the ring files it
/// actually exercises rather than the whole app.
struct SwiftLogicSuite {
    label: &'static str,
    bin: &'static str,
    sources: &'static [&'static str],
}

const SWIFT_LOGIC_SUITES: &[SwiftLogicSuite] = &[
    SwiftLogicSuite {
        label: "ChatLogic",
        bin: "/tmp/trios_chat_logic_test",
        sources: &["tests/swift/chat_logic_test.swift", "BR-OUTPUT/ChatLogic.swift"],
    },
    SwiftLogicSuite {
        label: "OpenRouterCreditsParser",
        bin: "/tmp/trios_openrouter_credits_parser_test",
        sources: &[
            "tests/swift/openrouter_credits_parser_test.swift",
            "rings/SR-00/OpenRouterCreditsParser.swift",
        ],
    },
    SwiftLogicSuite {
        label: "ZAIErrorParser",
        bin: "/tmp/trios_zai_error_parser_test",
        sources: &[
            "tests/swift/zai_error_parser_test.swift",
            "rings/SR-00/ZAIErrorParser.swift",
        ],
    },
    SwiftLogicSuite {
        label: "TriosLogBus",
        bin: "/tmp/trios_log_bus_test",
        sources: &[
            "tests/swift/trios_log_bus_test.swift",
            "tests/swift/TriosLogBusTestStubs.swift",
            "rings/SR-01/TriosLogBus.swift",
            "rings/SR-01/TriosOTLPExporter.swift",
        ],
    },
    SwiftLogicSuite {
        label: "PlanStepNaming",
        bin: "/tmp/trios_plan_step_naming_test",
        sources: &[
            "tests/swift/plan_step_naming_test.swift",
            "rings/SR-00/PlanStepNaming.swift",
        ],
    },
    SwiftLogicSuite {
        label: "ReleasePromotion",
        bin: "/tmp/trios_release_promotion_test",
        sources: &[
            "tests/swift/release_promotion_test.swift",
            "rings/SR-00/ReleasePromotionPolicy.swift",
        ],
    },
    SwiftLogicSuite {
        label: "BuildVariant",
        bin: "/tmp/trios_build_variant_test",
        sources: &[
            "tests/swift/build_variant_test.swift",
            "rings/SR-00/BuildVariantPolicy.swift",
        ],
    },
    SwiftLogicSuite {
        label: "QueenDelegation",
        bin: "/tmp/trios_queen_delegation_test",
        sources: &[
            "tests/swift/queen_delegation_test.swift",
            "rings/SR-00/QueenDelegation.swift",
            "rings/SR-00/ModelPricing.swift",
            "rings/SR-00/QueenSalience.swift",
        ],
    },
    SwiftLogicSuite {
        label: "PlanNestingRevision",
        bin: "/tmp/trios_plan_nesting_revision_test",
        sources: &[
            "tests/swift/plan_nesting_revision_test.swift",
            "rings/SR-00/TODOPlanState.swift",
            "rings/SR-00/PlanNesting.swift",
            "rings/SR-00/PlanRevision.swift",
        ],
    },
    SwiftLogicSuite {
        label: "ChatPaneLayout",
        bin: "/tmp/trios_chat_pane_layout_test",
        sources: &[
            "tests/swift/chat_pane_layout_test.swift",
            "rings/SR-00/ChatPaneLayout.swift",
        ],
    },
    SwiftLogicSuite {
        label: "TODOPlannerState",
        bin: "/tmp/trios_todo_planner_state_test",
        sources: &[
            "tests/swift/todo_planner_state_test.swift",
            "rings/SR-00/TODOPlanState.swift",
            "rings/SR-00/TODOPlanDeriver.swift",
        ],
    },
    SwiftLogicSuite {
        label: "TODOPlanDeriver",
        bin: "/tmp/trios_todo_plan_deriver_test",
        sources: &[
            "tests/swift/todo_plan_deriver_test.swift",
            "rings/SR-00/TODOPlanDeriver.swift",
        ],
    },
    SwiftLogicSuite {
        label: "ChatDiagnostics",
        bin: "/tmp/trios_chat_diagnostics_test",
        sources: &[
            "tests/swift/chat_diagnostics_test.swift",
            "rings/SR-00/ChatDiagnostics.swift",
            "rings/SR-00/ZAIErrorParser.swift",
        ],
    },
    SwiftLogicSuite {
        label: "ModelKeyRotation",
        bin: "/tmp/trios_model_key_rotation_test",
        sources: &[
            "tests/swift/model_key_rotation_test.swift",
            "rings/SR-00/ModelKeyRotation.swift",
            "rings/SR-00/ZAIErrorParser.swift",
        ],
    },
    SwiftLogicSuite {
        label: "LogParserTriosApp",
        bin: "/tmp/trios_log_parser_app_test",
        sources: &[
            "tests/swift/log_parser_trios_app_test.swift",
            "tests/swift/TriosLogBusTestStubs.swift",
            "rings/SR-01/TriosLogBus.swift",
            "rings/SR-01/TriosOTLPExporter.swift",
            "rings/SR-02/LogParser.swift",
        ],
    },
    SwiftLogicSuite {
        label: "AssistantActionBarPolicy",
        bin: "/tmp/trios_assistant_action_bar_policy_test",
        sources: &[
            "tests/swift/assistant_action_bar_policy_test.swift",
            "rings/SR-00/AssistantActionBarPolicy.swift",
        ],
    },
    SwiftLogicSuite {
        label: "ChatEditingShortcutPolicy",
        bin: "/tmp/trios_chat_editing_shortcut_policy_test",
        sources: &[
            "tests/swift/chat_editing_shortcut_policy_test.swift",
            "rings/SR-00/ChatEditingShortcutPolicy.swift",
        ],
    },
    SwiftLogicSuite {
        label: "ChatLoadingIndicatorLayout",
        bin: "/tmp/trios_chat_loading_indicator_layout_test",
        sources: &[
            "tests/swift/chat_loading_indicator_layout_test.swift",
            "rings/SR-00/ChatLoadingIndicatorLayout.swift",
        ],
    },
    SwiftLogicSuite {
        label: "ChatScrollRestorationPolicy",
        bin: "/tmp/trios_chat_scroll_restoration_policy_test",
        sources: &[
            "tests/swift/chat_scroll_restoration_policy_test.swift",
            "rings/SR-00/ChatScrollRestorationPolicy.swift",
        ],
    },
    SwiftLogicSuite {
        label: "ChatWorkspaceLayout",
        bin: "/tmp/trios_chat_workspace_layout_test",
        sources: &[
            "tests/swift/chat_workspace_layout_test.swift",
            "rings/SR-00/ChatWorkspaceLayout.swift",
        ],
    },
    SwiftLogicSuite {
        label: "CompanionServerConfig",
        bin: "/tmp/trios_companion_server_config_test",
        sources: &[
            "tests/swift/companion_server_config_test.swift",
            "rings/SR-00/CompanionServerConfig.swift",
        ],
    },
    SwiftLogicSuite {
        label: "MarkdownBlockParser",
        bin: "/tmp/trios_markdown_block_parser_test",
        sources: &[
            "tests/swift/markdown_block_parser_test.swift",
            "rings/SR-00/MarkdownBlockParser.swift",
        ],
    },
    SwiftLogicSuite {
        label: "ModelCatalogReconciler",
        bin: "/tmp/trios_model_catalog_reconciler_test",
        sources: &[
            "tests/swift/model_catalog_reconciler_test.swift",
            "rings/SR-00/ModelCatalogReconciler.swift",
        ],
    },
    SwiftLogicSuite {
        label: "ModelProvider",
        bin: "/tmp/trios_model_provider_test",
        sources: &[
            "tests/swift/model_provider_test.swift",
            "rings/SR-00/ModelProvider.swift",
        ],
    },
    SwiftLogicSuite {
        label: "ReasoningPresentationPolicy",
        bin: "/tmp/trios_reasoning_presentation_policy_test",
        sources: &[
            "tests/swift/reasoning_presentation_policy_test.swift",
            "rings/SR-00/ReasoningPresentationPolicy.swift",
        ],
    },
    SwiftLogicSuite {
        label: "StructuredDetailParser",
        bin: "/tmp/trios_structured_detail_parser_test",
        sources: &[
            "tests/swift/structured_detail_parser_test.swift",
            "rings/SR-00/StructuredDetailParser.swift",
        ],
    },
    SwiftLogicSuite {
        label: "TriNetRepositoryStatus",
        bin: "/tmp/trios_tri_net_repository_status_test",
        sources: &[
            "tests/swift/tri_net_repository_status_test.swift",
            "rings/SR-00/TriNetRepositoryStatus.swift",
        ],
    },
    SwiftLogicSuite {
        label: "TrinityQueenEmbedding",
        bin: "/tmp/trios_trinity_queen_embedding_test",
        sources: &[
            "tests/swift/trinity_queen_embedding_test.swift",
            "rings/SR-00/TrinityQueenEmbedding.swift",
        ],
    },
    SwiftLogicSuite {
        label: "TriosBranding",
        bin: "/tmp/trios_trios_branding_test",
        sources: &[
            "tests/swift/trios_branding_test.swift",
            "rings/SR-00/TriosBranding.swift",
        ],
    },
    SwiftLogicSuite {
        label: "Trinity999TabMap",
        bin: "/tmp/trios_trinity_999_tab_map_test",
        sources: &[
            "tests/swift/trinity_999_tab_map_test.swift",
            "rings/SR-00/Trinity999TabMap.swift",
        ],
    },
    SwiftLogicSuite {
        label: "TriosVisualTheme",
        bin: "/tmp/trios_trios_visual_theme_test",
        sources: &[
            "tests/swift/trios_visual_theme_test.swift",
            "rings/SR-00/TriosVisualTheme.swift",
        ],
    },
    SwiftLogicSuite {
        label: "AssistantTimelineBuilder",
        bin: "/tmp/trios_assistant_timeline_builder_test",
        sources: &[
            "tests/swift/assistant_timeline_builder_test.swift",
            "rings/SR-00/AssistantTimelineBuilder.swift",
            "rings/SR-00/ChatMessage.swift",
            "rings/SR-01/A2AMessage.swift",
            "rings/SR-00/AgentIdentity.swift",
        ],
    },
    SwiftLogicSuite {
        label: "ChatAttachmentImporter",
        bin: "/tmp/trios_chat_attachment_importer_test",
        sources: &[
            "tests/swift/chat_attachment_importer_test.swift",
            "rings/SR-01/ChatAttachmentImporter.swift",
            "rings/SR-00/ChatComposerAttachment.swift",
            "rings/SR-00/SafeFilePath.swift",
            "rings/SR-00/TriOSEncryption.swift",
            "rings/SR-00/KeychainSymmetricKeyStore.swift",
            "rings/SR-00/DevSecretStore.swift",
            "BR-OUTPUT/ProjectPaths.swift",
            "rings/SR-00/BuildVariantPolicy.swift",
        ],
    },
    SwiftLogicSuite {
        label: "ChatComposerAttachment",
        bin: "/tmp/trios_chat_composer_attachment_test",
        sources: &[
            "tests/swift/chat_composer_attachment_test.swift",
            "rings/SR-00/ChatComposerAttachment.swift",
            "rings/SR-00/TriOSEncryption.swift",
            "rings/SR-00/KeychainSymmetricKeyStore.swift",
            "rings/SR-00/DevSecretStore.swift",
            "BR-OUTPUT/ProjectPaths.swift",
            "rings/SR-00/BuildVariantPolicy.swift",
        ],
    },
    SwiftLogicSuite {
        label: "ChatComposerStatusStyle",
        bin: "/tmp/trios_chat_composer_status_style_test",
        sources: &[
            "tests/swift/chat_composer_status_style_test.swift",
            "rings/SR-00/ChatComposerStatusStyle.swift",
            "rings/SR-00/ChatWorkspaceLayout.swift",
        ],
    },
    SwiftLogicSuite {
        label: "ChatComposerStyle",
        bin: "/tmp/trios_chat_composer_style_test",
        sources: &[
            "tests/swift/chat_composer_style_test.swift",
            "rings/SR-00/ChatComposerStyle.swift",
            "rings/SR-00/ChatWorkspaceLayout.swift",
            "rings/SR-00/TriosVisualTheme.swift",
        ],
    },
    SwiftLogicSuite {
        label: "ChatGlassStyle",
        bin: "/tmp/trios_chat_glass_style_test",
        sources: &[
            "tests/swift/chat_glass_style_test.swift",
            "rings/SR-00/ChatGlassStyle.swift",
            "rings/SR-00/ChatWorkspaceLayout.swift",
            "rings/SR-00/TriosVisualTheme.swift",
        ],
    },
    SwiftLogicSuite {
        label: "ChatStatusBarStyle",
        bin: "/tmp/trios_chat_status_bar_style_test",
        sources: &[
            "tests/swift/chat_status_bar_style_test.swift",
            "rings/SR-00/ChatStatusBarStyle.swift",
            "rings/SR-00/ChatComposerStyle.swift",
            "rings/SR-00/ChatWorkspaceLayout.swift",
            "rings/SR-00/TriosVisualTheme.swift",
        ],
    },
    SwiftLogicSuite {
        label: "CodeDiffParser",
        bin: "/tmp/trios_code_diff_parser_test",
        sources: &[
            "tests/swift/code_diff_parser_test.swift",
            "rings/SR-00/CodeDiffParser.swift",
            "rings/SR-00/StructuredDetailParser.swift",
        ],
    },
    SwiftLogicSuite {
        label: "LlmClientOptionalKey",
        bin: "/tmp/trios_llm_client_optional_key_test",
        sources: &[
            "tests/swift/llm_client_optional_key_test.swift",
            "BR-OUTPUT/LLMClient.swift",
        ],
    },
    SwiftLogicSuite {
        label: "ModelCatalogParser",
        bin: "/tmp/trios_model_catalog_parser_test",
        sources: &[
            "tests/swift/model_catalog_parser_test.swift",
            "rings/SR-00/ModelCatalogService.swift",
            "rings/SR-00/ModelProvider.swift",
        ],
    },
    SwiftLogicSuite {
        label: "RecursionGuard",
        bin: "/tmp/trios_recursion_guard_test",
        sources: &[
            "tests/swift/recursion_guard_test.swift",
            "BR-OUTPUT/RecursionGuard.swift",
            "BR-OUTPUT/ProjectPaths.swift",
            "rings/SR-00/BuildVariantPolicy.swift",
        ],
    },
];

/// Compile and run every standalone Swift logic suite. This is the
/// L7-compliant replacement for a shell test step - invoked from Rust, no .sh.
/// Returns true only when all suites pass; appends a line per suite either way.
/// Focused suites that exist on disk and are deliberately not run yet.
///
/// Thirty of the forty-five files under `tests/swift/` were reachable by nobody
/// - not this list, not the Makefile, not CI. They looked like coverage and
/// were not, which is worse than an obvious gap: three separate types were
/// investigated as "tested but never called" when the truth was that their
/// tests had never executed either.
///
/// Naming them here does not run them. It stops the set from growing quietly:
/// add a `*_test.swift` without wiring it and `clade-e2e` now says so, instead
/// of the file joining the silent others. Entries come off this list by being
/// added to SWIFT_LOGIC_SUITES, which needs each suite's own source list.
///
/// Twenty-seven of the original thirty are now wired. Every one was compiled
/// *and executed* before being added, never on the strength of a resolved
/// source list - which is what caught the three below.
///
/// Both `session_recovery_*` suites **hang** rather than fail. They reach
/// KeychainSymmetricKeyStore through TriOSEncryption.encrypt, and
/// `SecItemCopyMatching` blocks on a password dialog no unattended run can
/// answer. Wiring either on a successful compile would freeze clade-e2e until
/// its timeout, reporting nothing - strictly worse than the silence they are in
/// now.
///
/// `session_recovery_export_test` used to fail fast instead, on a stale
/// assertion that the package is named `.zip`. That assertion has been
/// corrected - the product writes `.triosrecovery` and has since it started
/// encrypting - and the reward for fixing it was execution reaching the
/// keychain and hanging like its sibling. The red assertion was hiding the
/// hang, not competing with it.
///
/// Both need the dev-variant secret store, and `TRIOS_VARIANT=dev` does not
/// currently reach them: ProjectPaths resolves the variant from
/// `Bundle.main.infoDictionary`, and a bare test binary has no bundle, so it
/// falls back to prod and takes the keychain path. Letting the environment
/// answer when there is no bundle would unblock both at once.
///
/// `clade_guard_test` will not compile: CladeGuard.swift wants
/// `ProjectPaths.root`, and something else in that suite's closure declares a
/// competing `ProjectPaths` without it. A name collision to untangle, not a
/// missing file.
const KNOWN_UNWIRED_SWIFT_TESTS: &[&str] = &[
    "clade_guard_test.swift",
    "session_recovery_export_test.swift",
    "session_recovery_resilience_test.swift",
];

/// Fails when a focused Swift test exists that nothing runs and nothing admits
/// to skipping.
fn check_swift_suites_are_wired(dir: &str, report: &mut String) -> bool {
    let test_dir = PathBuf::from(dir).join("tests/swift");
    let entries = match fs::read_dir(&test_dir) {
        Ok(entries) => entries,
        Err(error) => {
            // A check that cannot read its input must say so. Returning "no
            // orphans found" here would be the exact failure this guard exists
            // to catch, one level up.
            report.push_str(&format!(
                "\n- [FAIL] wiring check could not read {}: {error}\n",
                test_dir.display()
            ));
            return false;
        }
    };

    let mut wired: Vec<&str> = Vec::new();
    for suite in SWIFT_LOGIC_SUITES {
        for source in suite.sources {
            if let Some(name) = source.strip_prefix("tests/swift/") {
                if name.ends_with("_test.swift") {
                    wired.push(name);
                }
            }
        }
    }

    let mut orphans: Vec<String> = Vec::new();
    let mut seen = 0usize;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with("_test.swift") {
            continue;
        }
        seen += 1;
        if wired.contains(&name.as_str()) {
            continue;
        }
        if KNOWN_UNWIRED_SWIFT_TESTS.contains(&name.as_str()) {
            continue;
        }
        orphans.push(name);
    }

    if seen == 0 {
        report.push_str("\n- [FAIL] wiring check matched no test files at all\n");
        return false;
    }

    orphans.sort();
    if orphans.is_empty() {
        report.push_str(&format!(
            "\n- [OK] swift suite wiring: {} test files, {} run, {} listed as unwired\n",
            seen,
            wired.len(),
            KNOWN_UNWIRED_SWIFT_TESTS.len()
        ));
        return true;
    }

    report.push_str(&format!(
        "\n- [FAIL] {} swift test file(s) run by nothing and not listed as unwired: {}\n",
        orphans.len(),
        orphans.join(", ")
    ));
    false
}

fn run_swift_logic_tests(report: &mut String) -> bool {
    let dir = trios_config::project_dir();
    let mut all_passed = check_swift_suites_are_wired(&dir, report);
    for suite in SWIFT_LOGIC_SUITES {
        if !run_swift_logic_suite(&dir, suite, report) {
            all_passed = false;
        }
    }
    all_passed
}

fn run_swift_logic_suite(dir: &str, suite: &SwiftLogicSuite, report: &mut String) -> bool {
    let label = suite.label;
    let mut args: Vec<&str> = suite.sources.to_vec();
    args.push("-o");
    args.push(suite.bin);

    let compiled = Command::new("swiftc")
        .args(&args)
        .current_dir(dir)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output();

    match compiled {
        Ok(out) if out.status.success() => match Command::new(suite.bin).output() {
            Ok(run) if run.status.success() => {
                report.push_str(&format!("- [OK] Swift logic tests ({}): passed\n", label));
                true
            }
            Ok(run) => {
                let tail = cap_body(String::from_utf8_lossy(&run.stdout).to_string());
                report.push_str(&format!(
                    "- [FAIL] Swift logic tests ({}) FAILED\n```\n{}\n```\n",
                    label, tail
                ));
                false
            }
            Err(e) => {
                report.push_str(&format!(
                    "- [FAIL] Swift logic tests ({}): could not run ({})\n",
                    label, e
                ));
                false
            }
        },
        Ok(out) => {
            let tail = cap_body(String::from_utf8_lossy(&out.stderr).to_string());
            report.push_str(&format!(
                "- [FAIL] Swift logic tests ({}): compile failed\n```\n{}\n```\n",
                label, tail
            ));
            false
        }
        Err(e) => {
            report.push_str(&format!(
                "- [FAIL] Swift logic tests ({}): swiftc unavailable ({})\n",
                label, e
            ));
            false
        }
    }
}

fn resolve_variant(name: &str) -> Variant {
    if name == "staging" {
        Variant {
            name: "staging",
            mcp_port: "9205",
            app_pattern: "trios-staging.app/Contents/MacOS/trios",
            log_process: "trios-staging",
        }
    } else {
        Variant {
            name: "prod",
            mcp_port: "9105",
            app_pattern: "trios.app/Contents/MacOS/trios",
            log_process: "trios",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_body_passes_small() {
        assert_eq!(
            cap_body("{\"status\":\"ok\"}".to_string()),
            "{\"status\":\"ok\"}"
        );
    }

    #[test]
    fn cap_body_truncates_oversized() {
        let big = "x".repeat(MAX_RESPONSE_BYTES + 1);
        let out = cap_body(big);
        assert!(out.starts_with("error: response too large"));
    }

    #[test]
    fn resolve_variant_prod_defaults() {
        let v = resolve_variant("prod");
        assert_eq!(v.name, "prod");
        assert_eq!(v.mcp_port, "9105");
        assert!(v.app_pattern.contains("trios.app"));
        assert_eq!(v.log_process, "trios");
    }

    #[test]
    fn resolve_variant_staging_ports() {
        let v = resolve_variant("staging");
        assert_eq!(v.name, "staging");
        assert_eq!(v.mcp_port, "9205");
        assert!(v.app_pattern.contains("trios-staging"));
        assert_eq!(v.log_process, "trios-staging");
    }

    #[test]
    fn resolve_variant_unknown_is_prod() {
        let v = resolve_variant("dev");
        assert_eq!(v.name, "prod");
    }
}
