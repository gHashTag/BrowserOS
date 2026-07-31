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
            "rings/SR-00/QueenCriterionVerdict.swift",
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
        label: "CladeGuard",
        bin: "/tmp/trios_clade_guard_test",
        sources: &[
            "tests/swift/clade_guard_test.swift",
            "BR-OUTPUT/CladeGuard.swift",
            "rings/SR-00/SafeFilePath.swift",
        ],
    },
    SwiftLogicSuite {
        label: "SessionRecoveryExport",
        bin: "/tmp/trios_session_recovery_export_test",
        sources: &[
            "tests/swift/session_recovery_export_test.swift",
            "rings/SR-00/SessionRecoveryExport.swift",
            "rings/SR-01/SessionRecoveryPackageWriter.swift",
            "rings/SR-00/TriOSEncryption.swift",
            "rings/SR-00/KeychainSymmetricKeyStore.swift",
            "rings/SR-00/DevSecretStore.swift",
            "BR-OUTPUT/ProjectPaths.swift",
            "rings/SR-00/BuildVariantPolicy.swift",
        ],
    },
    SwiftLogicSuite {
        label: "SessionRecoveryResilience",
        bin: "/tmp/trios_session_recovery_resilience_test",
        sources: &[
            "tests/swift/session_recovery_resilience_test.swift",
            "rings/SR-00/SessionRecoveryExport.swift",
            "rings/SR-01/SessionRecoveryPackageReader.swift",
            "rings/SR-01/SessionRecoveryPackageWriter.swift",
            "rings/SR-00/TriOSEncryption.swift",
            "rings/SR-00/KeychainSymmetricKeyStore.swift",
            "rings/SR-00/DevSecretStore.swift",
            "BR-OUTPUT/ProjectPaths.swift",
            "rings/SR-00/BuildVariantPolicy.swift",
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
/// Focused suites that exist on disk and are deliberately not run.
///
/// Empty, and that is the point of keeping it. Thirty of the forty-five files
/// under `tests/swift/` were once reachable by nobody - not this list, not the
/// Makefile, not CI. They looked like coverage and were not, which is worse
/// than an obvious gap: three separate types were investigated as "tested but
/// never called" when the truth was that their tests had never executed either.
///
/// All forty-five run now. This list stays because the guard below reads it:
/// add a `*_test.swift` without wiring it and clade-e2e names the file instead
/// of letting it join a silent majority. An empty allowlist is the strongest
/// state it can be in - every future orphan is a failure, not an entry.
///
/// What the thirty cost, for whoever reads this before adding a suite. None was
/// merely unwired. One asserted seven workspaces after Skills made eight; one
/// demanded a `.zip` name the product stopped writing when packages became
/// encrypted; one stubbed ProjectPaths and never grew the member CladeGuard
/// started calling; two shelled out to `ditto` against ciphertext; two hung on
/// the Keychain rather than failing, which would have frozen this runner had
/// they been wired on a successful compile. A suite nothing executes does not
/// hold one bug, it accumulates a stack of them, each hidden behind the last.
///
/// So: compile *and run* a candidate before adding it. Every one of those was
/// found by running, none by reading.
const KNOWN_UNWIRED_SWIFT_TESTS: &[&str] = &[
];

/// Fails when a focused Swift test exists that nothing runs and nothing admits
/// to skipping.
/// BR-OUTPUT files deliberately left out of the app.
///
/// build.sh's LEAN_BR_OUTPUT decides what the binary contains, and both dev and
/// release use it. A source can therefore sit in the tree looking entirely
/// present and never be compiled - which is not hypothetical: QueenStatusBadge
/// rendered nothing partly because it was absent from that list, and a
/// reference-count scan cannot tell "unused" from "not built".
///
/// The shelf is empty. Sixteen files sat here - a set of features nobody had
/// wired up, all of which compiled - until `939028c91` removed them for the
/// plain reason that we did not want them. Nothing was broken and nothing was
/// salvaged; the decision was the whole content of the change.
///
/// The list is kept, at zero, rather than deleted with them. It is the place
/// this repository writes down "present in the tree, absent from the binary",
/// and that state will occur again. Raising the budget is an edit someone has
/// to defend, which is the point of a budget.
const PROTOTYPE_BUDGET: usize = 0;

const KNOWN_PROTOTYPE_SOURCES: &[&str] = &[
];

/// Fails when a BR-OUTPUT source is neither compiled nor declared a prototype,
/// and when the build list names a file that no longer exists.
fn check_br_output_is_accounted_for(dir: &str, report: &mut String) -> bool {
    let build_sh = PathBuf::from(dir).join("build.sh");
    let script = match fs::read_to_string(&build_sh) {
        Ok(text) => text,
        Err(error) => {
            report.push_str(&format!(
                "\n- [FAIL] build-list check could not read {}: {error}\n",
                build_sh.display()
            ));
            return false;
        }
    };

    // Everything quoted between LEAN_BR_OUTPUT=( and its closing paren.
    let mut compiled: Vec<String> = Vec::new();
    if let Some(start) = script.find("LEAN_BR_OUTPUT=(") {
        let tail = &script[start..];
        let end = tail.find("\n    )").unwrap_or(tail.len());
        for line in tail[..end].lines() {
            let trimmed = line.trim();
            if let Some(name) = trimmed.strip_prefix('"').and_then(|r| r.strip_suffix('"')) {
                if name.ends_with(".swift") {
                    compiled.push(name.to_string());
                }
            }
        }
    }
    if compiled.is_empty() {
        // Parsing that silently yields nothing would pass every later check by
        // having nothing to disagree with. That is the bug this guard exists for.
        report.push_str("\n- [FAIL] build-list check parsed no entries from LEAN_BR_OUTPUT\n");
        return false;
    }

    let br_output = PathBuf::from(dir).join("BR-OUTPUT");
    let entries = match fs::read_dir(&br_output) {
        Ok(entries) => entries,
        Err(error) => {
            report.push_str(&format!(
                "\n- [FAIL] build-list check could not read {}: {error}\n",
                br_output.display()
            ));
            return false;
        }
    };

    let mut on_disk: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".swift") {
            on_disk.push(name);
        }
    }
    if on_disk.is_empty() {
        report.push_str("\n- [FAIL] build-list check found no Swift files in BR-OUTPUT\n");
        return false;
    }

    let mut unaccounted: Vec<String> = on_disk
        .iter()
        .filter(|n| !compiled.contains(n) && !KNOWN_PROTOTYPE_SOURCES.contains(&n.as_str()))
        .cloned()
        .collect();
    let mut phantom: Vec<String> = compiled
        .iter()
        .filter(|n| !on_disk.contains(n))
        .cloned()
        .collect();

    // A suppression that is no longer needed is worse than none: it reads as a
    // considered decision while describing a file that has moved on. Clippy's
    // `expect` warns on exactly this, and without it a baseline only ever grows
    // - the entry outlives the reason for it and nobody learns.
    let mut stale: Vec<String> = KNOWN_PROTOTYPE_SOURCES
        .iter()
        .filter(|n| !on_disk.contains(&n.to_string()))
        .map(|n| format!("{n} (no longer exists)"))
        .collect();
    stale.extend(
        KNOWN_PROTOTYPE_SOURCES
            .iter()
            .filter(|n| compiled.contains(&n.to_string()))
            .map(|n| format!("{n} (now compiled, so no longer a prototype)")),
    );

    unaccounted.sort();
    phantom.sort();
    stale.sort();

    // The list may shrink freely and may not grow. Without a ceiling the
    // cheapest way to silence this guard is to add a name to it, which turns a
    // failure into a record of a rule we stopped enforcing.
    let over_budget = KNOWN_PROTOTYPE_SOURCES.len() > PROTOTYPE_BUDGET;

    if unaccounted.is_empty() && phantom.is_empty() && stale.is_empty() && !over_budget {
        report.push_str(&format!(
            "\n- [OK] BR-OUTPUT accounted for: {} files, {} compiled, {} declared prototypes\n",
            on_disk.len(),
            compiled.len(),
            KNOWN_PROTOTYPE_SOURCES.len()
        ));
        return true;
    }
    if !unaccounted.is_empty() {
        report.push_str(&format!(
            "\n- [FAIL] BR-OUTPUT file(s) neither compiled nor declared a prototype: {}\n",
            unaccounted.join(", ")
        ));
    }
    if !phantom.is_empty() {
        report.push_str(&format!(
            "\n- [FAIL] build.sh compiles file(s) that do not exist: {}\n",
            phantom.join(", ")
        ));
    }
    if !stale.is_empty() {
        report.push_str(&format!(
            "\n- [FAIL] prototype exemption(s) no longer needed, delete them: {}\n",
            stale.join(", ")
        ));
    }
    if over_budget {
        report.push_str(&format!(
            "\n- [FAIL] {} prototype exemptions, budget is {}. This list may shrink, not grow.\n",
            KNOWN_PROTOTYPE_SOURCES.len(),
            PROTOTYPE_BUDGET
        ));
    }
    false
}

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
    let mut present: Vec<String> = Vec::new();
    let mut seen = 0usize;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with("_test.swift") {
            continue;
        }
        seen += 1;
        present.push(name.clone());
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

    // Same rule as the prototype list: an exemption naming a file that is gone,
    // or one that is now wired, has stopped describing anything true.
    let mut stale: Vec<String> = KNOWN_UNWIRED_SWIFT_TESTS
        .iter()
        .filter(|n| !present.contains(&n.to_string()))
        .map(|n| format!("{n} (no longer exists)"))
        .collect();
    stale.extend(
        KNOWN_UNWIRED_SWIFT_TESTS
            .iter()
            .filter(|n| wired.contains(&&***n))
            .map(|n| format!("{n} (now wired)")),
    );

    // A wired suite whose file is not in the repository is a green result that
    // exists only on this machine. Fifteen of these were found after a third of
    // the suites turned out to read untracked sources - the wiring check counted
    // files on disk and never asked whether anyone else could get them.
    let mut uncommitted: Vec<String> = Vec::new();
    for name in &wired {
        let path = format!("tests/swift/{name}");
        let tracked = Command::new("git")
            .args(["ls-files", "--error-unmatch", &path])
            .current_dir(dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !tracked {
            uncommitted.push((*name).to_string());
        }
    }

    orphans.sort();
    stale.sort();
    uncommitted.sort();
    if !uncommitted.is_empty() {
        report.push_str(&format!(
            "\n- [FAIL] {} wired suite(s) read files that are not committed: {}\n",
            uncommitted.len(),
            uncommitted.join(", ")
        ));
        return false;
    }
    if !stale.is_empty() {
        report.push_str(&format!(
            "\n- [FAIL] unwired exemption(s) no longer needed, delete them: {}\n",
            stale.join(", ")
        ));
        return false;
    }
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
    if !check_br_output_is_accounted_for(&dir, report) {
        all_passed = false;
    }
    for suite in SWIFT_LOGIC_SUITES {
        if !run_swift_logic_suite(&dir, suite, report) {
            all_passed = false;
        }
    }
    all_passed
}

/// Suites that must run as the dev variant, by label.
///
/// Anything touching TriOSEncryption reaches KeychainSymmetricKeyStore, where
/// `SecItemCopyMatching` blocks on a password dialog no unattended run can
/// answer - a hang, not a failure, which costs the runner's whole timeout and
/// reports nothing about the suites queued behind it. The dev variant reads
/// secrets from files instead.
///
/// Opt-in rather than applied to everything, which was tried and reverted:
/// RecursionGuard asserts the prod singleton lock path and prod bundle
/// identifier by name, so forcing dev globally turns a real passing suite red
/// to rescue a different one.
const DEV_VARIANT_SUITES: &[&str] =
    &["SessionRecoveryExport", "SessionRecoveryResilience"];

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

    let mut run = Command::new(suite.bin);
    if DEV_VARIANT_SUITES.contains(&suite.label) {
        run.env("TRIOS_VARIANT", "dev");
    }

    match compiled {
        Ok(out) if out.status.success() => match run.output() {
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
