use std::path::Path;
use std::time::{Duration, Instant};
use std::thread;

/// Probe order for the Chromium-based browser binary.
/// TRIOS.app is the target name after full rebuild.
/// BrowserOS.app is the current installed name until then.
const CANDIDATE_BINARIES: &[(&str, &str)] = &[
    ("/Applications/TRIOS.app/Contents/MacOS/TRIOS", "TRIOS.app"),
    ("/Applications/BrowserOS.app/Contents/MacOS/BrowserOS", "BrowserOS.app"),
];

/// Find the first existing browser binary or return an error.
pub fn find_binary() -> anyhow::Result<&'static str> {
    for (path, _label) in CANDIDATE_BINARIES {
        if Path::new(path).exists() {
            return Ok(path);
        }
    }
    anyhow::bail!(
        "Browser not found. Tried:\n{}",
        CANDIDATE_BINARIES
            .iter()
            .map(|(p, _)| format!("  {}", p))
            .collect::<Vec<_>>()
            .join("\n")
    )
}

pub struct BrowserArgs {
    pub root: String,
    pub cdp_port: u16,
    pub server_port: u16,
    pub extension_port: u16,
    pub user_data_dir: String,
    pub headless: bool,
    pub load_dev_extensions: bool,
}

/// Build the argv for launching the browser with CDP + dev extension.
pub fn build_args(cfg: &BrowserArgs) -> anyhow::Result<Vec<String>> {
    let binary = find_binary()?;
    let mut args = vec![binary.to_string()];

    if cfg.load_dev_extensions {
        args.push("--no-first-run".into());
        args.push("--no-default-browser-check".into());
    }

    args.extend([
        "--use-mock-keychain".into(),
        "--show-component-extension-options".into(),
        "--disable-browseros-server".into(),
    ]);

    if cfg.load_dev_extensions {
        args.push("--disable-browseros-extensions".into());
    } else {
        args.push("--enable-logging=stderr".into());
    }

    if cfg.headless {
        args.push("--headless=new".into());
    }

    args.push(format!("--remote-debugging-port={}", cfg.cdp_port));
    args.push(format!("--browseros-mcp-port={}", cfg.server_port));
    args.push(format!("--browseros-extension-port={}", cfg.extension_port));
    args.push(format!("--user-data-dir={}", cfg.user_data_dir));

    if cfg.load_dev_extensions {
        let ext_dir = format!("{}/apps/agent/dist/chrome-mv3-dev", cfg.root);
        args.push(format!("--load-extension={}", ext_dir));
        args.push("chrome://newtab".into());
    }

    Ok(args)
}

/// Block until CDP /json/version responds or timeout_secs elapses.
pub fn wait_for_cdp(cdp_port: u16, timeout_secs: u64) -> bool {
    let url = format!("http://127.0.0.1:{}/json/version", cdp_port);
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap_or_default();
    while Instant::now() < deadline {
        if client.get(&url).send().is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(500));
    }
    false
}

/// Verify no hardcoded old app paths remain in source.
/// Returns list of offending file:line strings.
pub fn check_rename(root: &str) -> Vec<String> {
    // Only flag absolute hardcoded paths — not the fallback list in this file
    let patterns = [
        "BrowserOS.app/Contents/MacOS",
        "TRIOS.app/Contents/MacOS",
    ];
    let skip_files = ["browser.rs"]; // this file intentionally lists both
    let mut issues = Vec::new();
    let exts = ["go", "ts", "tsx", "json", "toml"];

    walk_files(root, &exts, &skip_files, &mut |path, line_no, line| {
        for pat in &patterns {
            if line.contains(pat) {
                issues.push(format!("{}:{}: {}", path, line_no, line.trim()));
            }
        }
    });
    issues
}

fn walk_files(
    dir: &str,
    exts: &[&str],
    skip_files: &[&str],
    cb: &mut dyn FnMut(&str, usize, &str),
) {
    let skip_dirs = ["node_modules", "dist", "target", ".git", "out"];
    let path = Path::new(dir);
    walk_recursive(path, exts, &skip_dirs, skip_files, cb);
}

fn walk_recursive(
    path: &Path,
    exts: &[&str],
    skip_dirs: &[&str],
    skip_files: &[&str],
    cb: &mut dyn FnMut(&str, usize, &str),
) {
    let Ok(entries) = std::fs::read_dir(path) else { return };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if skip_dirs.contains(&name) {
                continue;
            }
            walk_recursive(&p, exts, skip_dirs, skip_files, cb);
        } else if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
            if exts.contains(&ext) {
                let fname = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if skip_files.contains(&fname) {
                    continue;
                }
                if let Ok(content) = std::fs::read_to_string(&p) {
                    let path_str = p.to_str().unwrap_or("");
                    for (i, line) in content.lines().enumerate() {
                        cb(path_str, i + 1, line);
                    }
                }
            }
        }
    }
}
