use anyhow::{bail, Context, Result};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

pub struct ManagedProc {
    pub tag: String,
    child: Arc<Mutex<Option<Child>>>,
    restart: bool,
}

impl ManagedProc {
    /// Spawn process; if restart=true, respawn on exit.
    pub fn start(tag: &str, dir: &str, cmd: &[String], env: &[(String, String)], restart: bool) -> Self {
        let tag = tag.to_string();
        let dir = dir.to_string();
        let cmd = cmd.to_vec();
        let env_vec = env.to_vec();
        let child_arc: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
        let child_arc2 = child_arc.clone();
        let tag2 = tag.clone();

        thread::spawn(move || {
            loop {
                crate::log::info(&tag2, &format!("Starting: {}", cmd.join(" ")));
                match spawn_proc(&tag2, &dir, &cmd, &env_vec) {
                    Ok(child) => {
                        *child_arc2.lock().unwrap() = Some(child);
                        if let Some(ref mut c) = *child_arc2.lock().unwrap() {
                            let _ = c.wait();
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
                thread::sleep(std::time::Duration::from_secs(1));
            }
        });

        Self { tag, child: child_arc, restart }
    }

    pub fn kill(&self) {
        if let Some(ref mut child) = *self.child.lock().unwrap() {
            let _ = child.kill();
        }
    }
}

fn spawn_proc(
    tag: &str,
    dir: &str,
    cmd: &[String],
    env: &[(String, String)],
) -> Result<Child> {
    let mut c = Command::new(&cmd[0]);
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
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().flatten() {
                crate::log::info(&tag_out, &line);
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().flatten() {
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
