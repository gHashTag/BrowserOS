//! Watch orchestrator — manages the full dev lifecycle

use anyhow::Result;

use crate::browser::{self, BrowserArgs};
use crate::infrastructure::http::HttpClient;
use crate::log;
use crate::ports::{self, DEFAULT_PORTS};
use crate::proc::{self, ManagedProc};

use super::builder::build_agent;
use super::cdp::wait_for_cdp_ready;

/// Start dev environment with HMR + browser + server
pub async fn run_watch(use_random: bool, manual: bool) -> Result<()> {
    let root = proc::find_monorepo_root()?;
    let http = HttpClient::new();

    let (ports, _l1, _l2, _l3) = if use_random {
        let (p, l1, l2, l3) = ports::reserve_random()?;
        log::info("info", &format!("Random ports: CDP={} Server={} Ext={}", p.cdp, p.server, p.extension));
        (p, l1, l2, l3)
    } else {
        log::info("info", "Killing processes on fixed ports...");
        ports::kill_defaults();
        let (l1, l2, l3) = ports::reserve_all_fixed()?;
        let p = DEFAULT_PORTS;
        log::info("info", "Ports cleared and reserved");
        (p, l1, l2, l3)
    };
    drop(_l1);
    drop(_l2);
    drop(_l3);

    log::info("info", &format!("Mode: {}", if manual { "manual" } else { "watch" }));
    log::info("info", &format!(
        "Ports: CDP={} Server={} Extension={}",
        ports.cdp, ports.server, ports.extension
    ));
    log::info("info", "Press Ctrl+C to stop");
    println!();

    let env = proc::build_env(ports.cdp, ports.server, ports.extension, "development");
    let agent_dir = format!("{}/apps/agent", root);
    let server_dir = format!("{}/apps/server", root);
    let user_data_dir = "/tmp/trios-dev".to_string();
    tokio::fs::create_dir_all(&user_data_dir).await.ok();

    let mut children: Vec<ManagedProc> = Vec::new();

    if manual {
        build_agent(&agent_dir).await?;

        let browser_args = browser::build_args(&BrowserArgs {
            root: root.clone(),
            cdp_port: ports.cdp,
            server_port: ports.server,
            extension_port: ports.extension,
            user_data_dir: user_data_dir.clone(),
            headless: false,
            load_dev_extensions: true,
        })?;
        children.push(ManagedProc::start(
            "browser", &root, &browser_args, &env, false,
        ));
    } else {
        let wxt_cmd = vec![
            "bun".to_string(),
            "--env-file=.env.development".to_string(),
            "wxt".to_string(),
        ];
        children.push(ManagedProc::start(
            "agent", &agent_dir, &wxt_cmd, &env, true,
        ));
    }

    // Wait for CDP before starting server
    if let Err(e) = wait_for_cdp_ready(&http, ports.cdp, 60).await {
        log::warn("server", &e.to_string());
    }

    let server_cmd = vec![
        "bun".to_string(),
        "--watch".to_string(),
        "--env-file=.env.development".to_string(),
        "src/index.ts".to_string(),
    ];
    children.push(ManagedProc::start(
        "server", &server_dir, &server_cmd, &env, true,
    ));

    ctrlc_wait().await;

    log::info("info", "Shutting down...");
    for c in &children {
        c.kill();
    }
    Ok(())
}

/// Run test environment: start server + browser, run bun test, clean up
pub async fn run_test(keep: bool, headless: bool, extra_args: Vec<String>) -> Result<()> {
    let root = proc::find_monorepo_root()?;
    let http = HttpClient::new();

    log::info("info", "Killing test ports...");
    ports::kill_defaults();
    let (l1, l2, l3) = ports::reserve_all_fixed()?;
    let p = DEFAULT_PORTS;
    drop(l1); drop(l2); drop(l3);

    let env = proc::build_env(p.cdp, p.server, p.extension, "test");
    let server_dir = format!("{}/apps/server", root);
    let server_cmd = vec![
        "bun".to_string(),
        format!("{}/src/index.ts", server_dir),
        "--cdp-port".to_string(), p.cdp.to_string(),
        "--server-port".to_string(), p.server.to_string(),
    ];
    let server_proc = ManagedProc::start("server", &root, &server_cmd, &env, false);

    let health_url = format!("http://127.0.0.1:{}/health", p.server);
    let ready = http.wait_for_url(&health_url, 30).await;
    if !ready {
        server_proc.kill();
        anyhow::bail!("Server failed to start on port {}", p.server);
    }
    log::server("Server ready");

    let tmp_dir = std::env::temp_dir().join("trios-test");
    tokio::fs::create_dir_all(&tmp_dir).await.ok();
    let user_data_dir = tmp_dir.to_str().unwrap_or("/tmp/trios-test").to_string();

    let browser_args = browser::build_args(&BrowserArgs {
        root: root.clone(),
        cdp_port: p.cdp,
        server_port: p.server,
        extension_port: p.extension,
        user_data_dir: user_data_dir.clone(),
        headless,
        load_dev_extensions: false,
    })?;
    let browser_proc = ManagedProc::start("browser", &root, &browser_args, &env, false);

    if !browser::wait_for_cdp(&http, p.cdp, 60).await {
        server_proc.kill();
        browser_proc.kill();
        anyhow::bail!("CDP failed on port {}", p.cdp);
    }
    log::browser("CDP ready");

    let mut bun_args = vec!["test".to_string()];
    bun_args.extend(extra_args);
    log::test_log(&format!("Running: bun {}", bun_args.join(" ")));

    let status = tokio::process::Command::new("bun")
        .args(&bun_args)
        .current_dir(&root)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .status()
        .await?;

    server_proc.kill();
    browser_proc.kill();

    if !keep {
        let _ = tokio::fs::remove_dir_all(&user_data_dir).await;
    }

    if !status.success() {
        log::error("test", "Tests FAILED");
        std::process::exit(1);
    }
    log::test_log("Tests PASSED");
    Ok(())
}

async fn ctrlc_wait() {
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(())));
    let tx2 = tx.clone();
    ctrlc::set_handler(move || {
        if let Ok(mut guard) = tx2.lock() {
            *guard = None;
        }
    }).ok();

    // Spin until ctrlc sets the flag to None
    loop {
        {
            let guard = tx.lock().unwrap();
            if guard.is_none() {
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}
