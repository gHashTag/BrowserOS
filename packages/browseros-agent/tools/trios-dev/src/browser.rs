use std::path::Path;
use std::time::{Duration, Instant};
use std::thread;

/// Canonical TRIOS binary path.
const TRIOS_BINARY: &str = "/Applications/TRIOS.app/Contents/MacOS/TRIOS";

pub struct BrowserArgs {
    pub root: String,
    pub cdp_port: u16,
    pub server_port: u16,
    pub extension_port: u16,
    pub user_data_dir: String,
    pub headless: bool,
    pub load_dev_extensions: bool,
}

/// Build the argv for launching TRIOS with CDP + dev extension.
pub fn build_args(cfg: &BrowserArgs) -> Vec<String> {
    let mut args = vec![TRIOS_BINARY.to_string()];

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

    args
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

/// Verify no "BrowserOS.app" or hardcoded old paths remain in source.
/// Returns list of offending file:line strings.
pub fn check_rename(root: &str) -> Vec<String> {
    let patterns = [
        "BrowserOS.app",
        "/Applications/BrowserOS",
        "Contents/MacOS/BrowserOS",
    ];
    let mut issues = Vec::new();
    let exts = ["go", "ts", "tsx", "rs", "json", "toml"];

    walk_files(root, &exts, &mut |path, line_no, line| {
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
    cb: &mut dyn FnMut(&str, usize, &str),
) {
    let skip_dirs = ["node_modules", "dist", "target", ".git", "out"];
    let path = Path::new(dir);
    walk_recursive(path, exts, &skip_dirs, cb);
}

fn walk_recursive(
    path: &Path,
    exts: &[&str],
    skip_dirs: &[&str],
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
            walk_recursive(&p, exts, skip_dirs, cb);
        } else if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
            if exts.contains(&ext) {
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
