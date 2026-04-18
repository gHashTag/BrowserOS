use std::path::Path;

use crate::infrastructure::http::HttpClient;

/// App candidates in probe order.
/// find_binary() checks /Applications then ~/Applications for each.
const APP_CANDIDATES: &[(&str, &str)] = &[
    ("TRIOS.app",     "TRIOS"),
    ("BrowserOS.app", "BrowserOS"),
];

/// Build full binary path: <prefix>/<app>/Contents/MacOS/<bin>
fn candidate_path(prefix: &str, app: &str, bin: &str) -> String {
    format!("{}/{}/Contents/MacOS/{}", prefix, app, bin)
}

/// Find the first existing Chromium browser binary.
/// Only checks standard macOS install locations — NOT ~/Desktop.
/// (~/Desktop/TRIOS.app may be a shell-script launcher, not a Mach-O binary)
pub fn find_binary() -> anyhow::Result<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    // NOTE: ~/Desktop intentionally excluded — may contain shell-script launchers
    let prefixes: Vec<String> = vec![
        "/Applications".to_string(),
        format!("{}/Applications", home),
    ];

    for (app, bin) in APP_CANDIDATES {
        for prefix in &prefixes {
            let path = candidate_path(prefix, app, bin);
            if Path::new(&path).exists() {
                return Ok(path);
            }
        }
    }

    let tried: Vec<String> = APP_CANDIDATES
        .iter()
        .flat_map(|(app, bin)| {
            prefixes.iter().map(move |p| format!("  {}", candidate_path(p, app, bin)))
        })
        .collect();
    anyhow::bail!(
        "Chromium browser not found. Install BrowserOS.app or TRIOS.app to /Applications.\nTried:\n{}",
        tried.join("\n")
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
    let mut args = vec![binary];

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

/// Async version: Block until CDP /json/version responds or timeout_secs elapses.
pub async fn wait_for_cdp(http: &HttpClient, cdp_port: u16, timeout_secs: u64) -> bool {
    let url = format!("http://127.0.0.1:{}/json/version", cdp_port);
    http.wait_for_url(&url, timeout_secs).await
}

/// Verify no hardcoded app paths remain in source (excluding this file).
pub fn check_rename(root: &str) -> Vec<String> {
    let patterns = [
        "BrowserOS.app/Contents/MacOS",
        "TRIOS.app/Contents/MacOS",
    ];
    let skip_files = ["browser.rs"];
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
    walk_recursive(Path::new(dir), exts, &skip_dirs, skip_files, cb);
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
            if !skip_dirs.contains(&name) {
                walk_recursive(&p, exts, skip_dirs, skip_files, cb);
            }
        } else if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
            if exts.contains(&ext) {
                let fname = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !skip_files.contains(&fname) {
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_args_full_mode() {
        let args = build_args(&BrowserArgs {
            root: "/tmp/test".into(),
            cdp_port: 9000,
            server_port: 9105,
            extension_port: 9305,
            user_data_dir: "/tmp/test-data".into(),
            headless: false,
            load_dev_extensions: true,
        })
        .unwrap();

        // Check CDP port
        assert!(args.iter().any(|a| a.contains("--remote-debugging-port=9000")));
        // Check MCP ports
        assert!(args.iter().any(|a| a.contains("--browseros-mcp-port=9105")));
        assert!(args.iter().any(|a| a.contains("--browseros-extension-port=9305")));
        // Check user data dir
        assert!(args.iter().any(|a| a.contains("--user-data-dir=/tmp/test-data")));
        // Check dev extension is loaded
        assert!(args.iter().any(|a| a.contains("--load-extension=/tmp/test/apps/agent/dist/chrome-mv3-dev")));
    }

    #[test]
    fn test_build_args_headless() {
        let args = build_args(&BrowserArgs {
            root: "/tmp/test".into(),
            cdp_port: 9000,
            server_port: 9105,
            extension_port: 9305,
            user_data_dir: "/tmp/test-data".into(),
            headless: true,
            load_dev_extensions: false,
        })
        .unwrap();

        assert!(args.iter().any(|a| a.contains("--headless=new")));
        // In non-dev mode, logging is enabled instead of extension
        assert!(args.iter().any(|a| a.contains("--enable-logging=stderr")));
        assert!(!args.iter().any(|a| a.contains("--load-extension=")));
    }

    #[test]
    fn test_candidate_path() {
        assert_eq!(
            candidate_path("/Applications", "TRIOS.app", "TRIOS"),
            "/Applications/TRIOS.app/Contents/MacOS/TRIOS"
        );
        assert_eq!(
            candidate_path("~/Applications", "BrowserOS.app", "BrowserOS"),
            "~/Applications/BrowserOS.app/Contents/MacOS/BrowserOS"
        );
    }
}
