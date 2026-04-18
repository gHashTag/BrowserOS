use anyhow::{bail, Context, Result};
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::sync::Mutex;
use tokio::time::sleep;

pub struct ManagedProc {
    #[allow(dead_code)]
    pub tag: String,
    child: Arc<Mutex<Option<tokio::process::Child>>>,
    #[allow(dead_code)]
    restart: bool,
}

impl ManagedProc {
    /// Spawn process; if restart=true, respawn on exit.
    pub fn start(tag: &str, dir: &str, cmd: &[String], env: &[(String, String)], restart: bool) -> Self {
        let tag = tag.to_string();
        let dir = dir.to_string();
        let cmd = cmd.to_vec();
        let env_vec = env.to_vec();
        let child_arc: Arc<Mutex<Option<tokio::process::Child>>> = Arc::new(Mutex::new(None));
        let child_arc2 = child_arc.clone();
        let tag2 = tag.clone();

        tokio::spawn(async move {
            loop {
                crate::log::info(&tag2, &format!("Starting: {}", cmd.join(" ")));
                match spawn_proc_async(&tag2, &dir, &cmd, &env_vec).await {
                    Ok(child) => {
                        // Store the child
                        *child_arc2.lock().await = Some(child);

                        // Wait for child to exit - take it out first to avoid holding lock across await
                        let child_opt = child_arc2.lock().await.take();
                        if let Some(mut child) = child_opt {
                            let _ = child.wait().await;
                        }
                        crate::log::info(&tag2, "Process exited");
                    }
                    Err(e) => {
                        crate::log::error(&tag2, &format!("Failed to start: {}", e));
                    }
                }
                if !restart {
                    break;
                }
                crate::log::warn(&tag2, "Restarting in 1s...");
                sleep(Duration::from_secs(1)).await;
            }
        });

        Self { tag, child: child_arc, restart }
    }

    /// Kill the managed process
    pub fn kill(&self) {
        let handle = tokio::runtime::Handle::try_current()
            .expect("no tokio runtime running; kill() must be called from within a tokio runtime");
        handle.block_on(async {
            if let Some(mut child) = self.child.lock().await.take() {
                let _ = child.kill().await;
            }
        });
    }
}

/// Async version of spawn_proc
async fn spawn_proc_async(
    tag: &str,
    dir: &str,
    cmd: &[String],
    env: &[(String, String)],
) -> Result<tokio::process::Child> {
    let mut c = TokioCommand::new(&cmd[0]);
    if cmd.len() > 1 {
        c.args(&cmd[1..]);
    }
    c.current_dir(dir);
    for (k, v) in env {
        c.env(k, v);
    }
    c.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().context("spawn failed")?;

    let tag_out = tag.to_string();
    let tag_err = tag.to_string();

    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                crate::log::info(&tag_out, &line);
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                crate::log::info(&tag_err, &line);
            }
        });
    }
    Ok(child)
}

/// Find monorepo root by walking up from cwd looking for package.json + apps/
pub fn find_monorepo_root() -> Result<String> {
    let cwd = std::env::current_dir().context("cannot get cwd")?;
    let mut dir: &Path = &cwd;
    loop {
        let pkg = dir.join("package.json");
        let apps = dir.join("apps");
        if pkg.exists() && apps.exists() {
            return Ok(dir.to_str().unwrap_or("").to_string());
        }
        match dir.parent() {
            Some(p) => dir = p,
            None => bail!("Cannot find monorepo root from {}", cwd.display()),
        }
    }
}

/// Build environment variables for child processes.
/// config.ts reads lowercase prefix: trios_CDP_PORT, trios_SERVER_PORT, trios_EXTENSION_PORT
/// wxt.config.ts requires VITE_PUBLIC_trios_API (non-null assertion — crashes if missing)
pub fn build_env(cdp: u16, server: u16, ext: u16, node_env: &str) -> Vec<(String, String)> {
    vec![
        // === Server config (config.ts reads these) ===
        ("trios_CDP_PORT".into(),            cdp.to_string()),
        ("trios_SERVER_PORT".into(),         server.to_string()),
        ("trios_EXTENSION_PORT".into(),      ext.to_string()),
        ("trios_ALLOW_NO_CDP".into(),        "0".into()),

        // === Agent build (wxt.config.ts requires these) ===
        // VITE_PUBLIC_trios_API: required, non-null assertion in wxt.config.ts
        ("VITE_PUBLIC_trios_API".into(),     "https://api.browseros.com".into()),
        ("VITE_TRIOS_SERVER_PORT".into(),    server.to_string()),
        ("VITE_BROWSEROS_SERVER_PORT".into(), server.to_string()),

        // === Legacy uppercase (Go tool compat) ===
        ("TRIOS_CDP_PORT".into(),            cdp.to_string()),
        ("TRIOS_SERVER_PORT".into(),         server.to_string()),
        ("TRIOS_EXTENSION_PORT".into(),      ext.to_string()),
        ("BROWSEROS_CDP_PORT".into(),        cdp.to_string()),
        ("BROWSEROS_SERVER_PORT".into(),     server.to_string()),
        ("BROWSEROS_EXTENSION_PORT".into(),  ext.to_string()),

        ("NODE_ENV".into(),                  node_env.to_string()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_env_lowercase() {
        let env = build_env(9000, 9105, 9305, "development");

        // Server config (lowercase, used by config.ts)
        assert_eq!(
            env.iter().find(|(k, _)| k == "trios_CDP_PORT").unwrap().1,
            "9000"
        );
        assert_eq!(
            env.iter().find(|(k, _)| k == "trios_SERVER_PORT").unwrap().1,
            "9105"
        );
        assert_eq!(
            env.iter().find(|(k, _)| k == "trios_EXTENSION_PORT").unwrap().1,
            "9305"
        );
    }

    #[test]
    fn test_build_env_legacy_compat() {
        let env = build_env(9000, 9105, 9305, "development");

        // Legacy uppercase (Go tool compat)
        assert!(env.iter().any(|(k, _)| k == "TRIOS_CDP_PORT"));
        assert!(env.iter().any(|(k, _)| k == "BROWSEROS_CDP_PORT"));

        // Verify values match
        assert_eq!(
            env.iter().find(|(k, _)| k == "TRIOS_CDP_PORT").unwrap().1,
            "9000"
        );
        assert_eq!(
            env.iter().find(|(k, _)| k == "BROWSEROS_SERVER_PORT").unwrap().1,
            "9105"
        );
    }

    #[test]
    fn test_build_env_vite_config() {
        let env = build_env(9000, 9105, 9305, "development");

        // VITE_PUBLIC_trios_API is required by wxt.config.ts
        assert!(env.iter().any(|(k, v)| {
            k == "VITE_PUBLIC_trios_API" && v == "https://api.browseros.com"
        }));
        assert_eq!(
            env.iter().find(|(k, _)| k == "VITE_TRIOS_SERVER_PORT").unwrap().1,
            "9105"
        );
    }

    #[test]
    fn test_build_env_node_env() {
        let env = build_env(1234, 5678, 9012, "test");
        assert_eq!(env.iter().find(|(k, _)| k == "NODE_ENV").unwrap().1, "test");
    }
}
