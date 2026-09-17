use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::process::{Command, Stdio};
use std::time::Instant;

fn project_dir() -> String { trios_config::project_dir() }

#[derive(Serialize, Deserialize, Debug)]
struct AuditFinding {
    file: String,
    line: u32,
    severity: String,
    category: String,
    message: String,
    fingerprint: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct BuildCheckResult {
    passed: bool,
    swift_ok: bool,
    rust_ok: bool,
    swift_errors: Vec<String>,
    rust_errors: Vec<String>,
    duration_ms: u128,
}

#[derive(Serialize, Deserialize, Debug)]
struct SecurityCheckResult {
    passed: bool,
    findings: Vec<AuditFinding>,
    scanned_files: usize,
    duration_ms: u128,
}

#[derive(Serialize, Deserialize, Debug)]
struct AuditReport {
    build_check: BuildCheckResult,
    security_check: SecurityCheckResult,
    shell_safety_check: SecurityCheckResult,
    error_handling_check: SecurityCheckResult,
    concurrency_check: SecurityCheckResult,
    todo_check: SecurityCheckResult,
    unused_code_check: SecurityCheckResult,
    retain_cycle_check: SecurityCheckResult,
}

#[derive(Serialize, Deserialize, Debug)]
struct SealCell {
    name: String,
    passed: bool,
    detail: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct SealArtifact {
    generated_at: String,
    git_head: Option<String>,
    passed: bool,
    cells: Vec<SealCell>,
}

/// Fingerprints of TODOs that are explicitly allowed because they represent
/// tracked feature dependencies, not unowned debt. Use sparingly and review
/// each cycle.
const ALLOWED_TODO_FINGERPRINTS: &[&str] = &[];

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dry_run = args.iter().any(|a| a == "--dry-run");
    let verbose = args.iter().any(|a| a == "--verbose" || a == "-v");

    println!("===========================================================");
    println!("  CLADE-SEAL: Trinity Promotion Seal");
    println!("  Dry run: {} | Project: {}", dry_run, project_dir());
    println!("===========================================================");

    let mut cells: Vec<SealCell> = vec![];

    // Cell 1: clade-audit
    let audit_cell = run_audit_cell(verbose);
    cells.push(audit_cell);

    // Cell 2: cargo test
    let test_cell = run_cargo_cell("cargo test --workspace", "Test", verbose);
    cells.push(test_cell);

    // Cell 3: cargo clippy
    let clippy_cell = run_cargo_cell("cargo clippy --workspace", "Clippy", verbose);
    cells.push(clippy_cell);

    let all_passed = cells.iter().all(|c| c.passed);

    let seal = SealArtifact {
        generated_at: Utc::now().to_rfc3339(),
        git_head: current_git_head(),
        passed: all_passed,
        cells,
    };

    if !dry_run {
        write_seal(&seal);
    } else {
        println!("   [DRY-RUN] Would write seal artifact");
    }

    if verbose || !all_passed {
        println!("\nSeal cells:");
        for c in &seal.cells {
            println!("   {} {}: {}", if c.passed { "[OK]" } else { "[FAIL]" }, c.name, c.detail);
        }
    }

    if all_passed {
        println!("\n[OK] SEAL VALID");
        std::process::exit(0);
    } else {
        println!("\n[REJECT] SEAL INVALID");
        std::process::exit(1);
    }
}

fn run_audit_cell(verbose: bool) -> SealCell {
    println!("   Running clade-audit...");
    let start = Instant::now();
    let output = match Command::new("cargo")
        .args(["run", "--bin", "clade-audit", "--", "--json"])
        .current_dir(project_dir())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            return SealCell {
                name: "Audit".to_string(),
                passed: false,
                detail: format!("failed to spawn: {}", e),
            };
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let report: AuditReport = match serde_json::from_str(&stdout) {
        Ok(r) => r,
        Err(e) => {
            return SealCell {
                name: "Audit".to_string(),
                passed: false,
                detail: format!("JSON parse error: {} (stdout len={})", e, stdout.len()),
            };
        }
    };

    let hard_gates = [
        ("Build", report.build_check.passed),
        ("Security", report.security_check.passed),
        ("ShellSafety", report.shell_safety_check.passed),
        ("ErrorHandling", report.error_handling_check.passed),
        ("Concurrency", report.concurrency_check.passed),
        ("UnusedCode", report.unused_code_check.passed),
        ("RetainCycle", report.retain_cycle_check.passed),
    ];

    let mut failures: Vec<String> = vec![];
    for (name, passed) in &hard_gates {
        if !passed {
            failures.push(name.to_string());
        }
    }

    // Fail only on TODO findings not in the explicit allow-list.
    let mut disallowed_todos: Vec<String> = vec![];
    for f in &report.todo_check.findings {
        if !ALLOWED_TODO_FINGERPRINTS.contains(&f.fingerprint.as_str()) {
            disallowed_todos.push(format!("{}:{} - {}", f.file, f.line, f.message));
        }
    }
    if !disallowed_todos.is_empty() {
        failures.push(format!("TODO({})", disallowed_todos.len()));
    }

    let passed = failures.is_empty();
    let detail = if passed {
        format!("{}ms, all hard gates green, {} allowed TODO", start.elapsed().as_millis(), report.todo_check.findings.len())
    } else {
        format!("{}ms, failures: {}", start.elapsed().as_millis(), failures.join(", "))
    };

    if verbose {
        if !report.build_check.swift_errors.is_empty() {
            println!("      Swift errors: {}", report.build_check.swift_errors.len());
        }
        if !report.build_check.rust_errors.is_empty() {
            println!("      Rust errors: {}", report.build_check.rust_errors.len());
        }
        for f in &disallowed_todos {
            println!("      Disallowed TODO: {}", f);
        }
    }

    SealCell {
        name: "Audit".to_string(),
        passed,
        detail,
    }
}

fn run_cargo_cell(command: &str, name: &str, verbose: bool) -> SealCell {
    println!("   Running {}...", name.to_lowercase());
    let start = Instant::now();
    let parts: Vec<&str> = command.split_whitespace().collect();
    if parts.is_empty() {
        return SealCell {
            name: name.to_string(),
            passed: false,
            detail: "empty command".to_string(),
        };
    }
    let mut cmd = Command::new(parts[0]);
    for arg in &parts[1..] {
        cmd.arg(arg);
    }
    let status = cmd
        .current_dir(project_dir())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();

    let passed = status.as_ref().map(|s| s.success()).unwrap_or(false);
    if verbose && !passed {
        if let Err(ref e) = status {
            println!("      {} spawn failed: {}", name, e);
        }
    }

    SealCell {
        name: name.to_string(),
        passed,
        detail: format!("{}ms", start.elapsed().as_millis()),
    }
}

fn write_seal(seal: &SealArtifact) {
    let state_dir = format!("{}/.trinity/state", project_dir());
    if let Err(e) = std::fs::create_dir_all(&state_dir) {
        eprintln!("[seal] Failed to create state dir: {}", e);
        return;
    }
    let path = format!("{}/seal.json", state_dir);
    match serde_json::to_string_pretty(seal) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                eprintln!("[seal] Failed to write {}: {}", path, e);
            } else {
                println!("   [SAVE] Seal artifact: {}", path);
            }
        }
        Err(e) => eprintln!("[seal] Failed to serialize seal: {}", e),
    }
}

fn current_git_head() -> Option<String> {
    Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(project_dir())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })
}
