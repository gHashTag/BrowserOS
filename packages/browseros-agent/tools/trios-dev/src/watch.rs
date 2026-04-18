use anyhow::Result;
use std::path::PathBuf;
use std::{thread, time};

use crate::browser::{self, BrowserArgs};
use crate::log;
use crate::ports::{self, DEFAULT_PORTS};
use crate::proc::{self, ManagedProc};

pub fn run(use_random: bool, manual: bool) -> Result<()> {
    let root = proc::find_monorepo_root()?;

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
    // listeners dropped here — ports released for child processes
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
    std::fs::create_dir_all(&user_data_dir).ok();

    let mut children: Vec<ManagedProc> = Vec::new();

    if manual {
        // Static build then launch browser with extension loaded
        log::build("Building agent (dev)...");
        let status = std::process::Command::new("bun")
            .args(["--env-file=.env.development", "wxt", "build", "--mode", "development"])
            .current_dir(&agent_dir)
            .status()?;
        if !status.success() {
            anyhow::bail!("Agent build failed");
        }
        log::build("Agent built");

        let browser_args = browser::build_args(&BrowserArgs {
            root: root.clone(),
            cdp_port: ports.cdp,
            server_port: ports.server,
            extension_port: ports.extension,
            user_data_dir: user_data_dir.clone(),
            headless: false,
            load_dev_extensions: true,
        });
        children.push(ManagedProc::start(
            "browser", &root, &browser_args, &env, false,
        ));
    } else {
        // HMR mode — WXT dev server, browser loads extension manually
        let wxt_cmd = vec![
            "bun".to_string(),
            "--env-file=.env.development".to_string(),
            "wxt".to_string(),
        ];
        children.push(ManagedProc::start(
            "agent", &agent_dir, &wxt_cmd, &env, true,
        ));
    }

    // Wait for CDP
    log::server("Waiting for CDP...");
    if browser::wait_for_cdp(ports.cdp, 60) {
        log::server("CDP ready");
    } else {
        log::warn("server", "CDP not available, starting server in degraded mode");
    }

    // Start server
    let server_cmd = vec![
        "bun".to_string(),
        "--watch".to_string(),
        "--env-file=.env.development".to_string(),
        "src/index.ts".to_string(),
    ];
    children.push(ManagedProc::start(
        "server", &server_dir, &server_cmd, &env, true,
    ));

    // Block until Ctrl+C
    ctrlc_wait();

    log::info("info", "Shutting down...");
    for c in &children {
        c.kill();
    }
    Ok(())
}

pub fn run_test(keep: bool, headless: bool, extra_args: Vec<String>) -> Result<()> {
    let root = proc::find_monorepo_root()?;

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

    // Wait for server health
    let health_url = format!("http://127.0.0.1:{}/health", p.server);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap_or_default();
    let mut ready = false;
    for _ in 0..30 {
        if client.get(&health_url).send().is_ok() {
            ready = true;
            break;
        }
        thread::sleep(time::Duration::from_secs(1));
    }
    if !ready {
        server_proc.kill();
        anyhow::bail!("Server failed to start on port {}", p.server);
    }
    log::server("Server ready");

    // Launch browser with temp profile
    let tmp_dir = std::env::temp_dir().join("trios-test");
    std::fs::create_dir_all(&tmp_dir).ok();
    let user_data_dir = tmp_dir.to_str().unwrap_or("/tmp/trios-test").to_string();

    let browser_args = browser::build_args(&BrowserArgs {
        root: root.clone(),
        cdp_port: p.cdp,
        server_port: p.server,
        extension_port: p.extension,
        user_data_dir: user_data_dir.clone(),
        headless,
        load_dev_extensions: false,
    });
    let browser_proc = ManagedProc::start("browser", &root, &browser_args, &env, false);

    if !browser::wait_for_cdp(p.cdp, 60) {
        server_proc.kill();
        browser_proc.kill();
        anyhow::bail!("CDP failed on port {}", p.cdp);
    }
    log::browser("CDP ready");

    // Run bun test
    let mut bun_args = vec!["test".to_string()];
    bun_args.extend(extra_args);
    log::test_log(&format!("Running: bun {}", bun_args.join(" ")));

    let status = std::process::Command::new("bun")
        .args(&bun_args)
        .current_dir(&root)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .status()?;

    server_proc.kill();
    browser_proc.kill();

    if !keep {
        let _ = std::fs::remove_dir_all(&user_data_dir);
    }

    if !status.success() {
        log::error("test", "Tests FAILED");
        std::process::exit(1);
    }
    log::test_log("Tests PASSED");
    Ok(())
}

fn ctrlc_wait() {
    let (tx, rx) = std::sync::mpsc::channel();
    ctrlc::set_handler(move || { let _ = tx.send(()); }).ok();
    let _ = rx.recv();
}
