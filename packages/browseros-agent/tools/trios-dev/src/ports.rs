use anyhow::{Context, Result, bail};
use std::net::TcpListener;
use std::process::Command;
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ports {
    pub cdp: u16,
    pub server: u16,
    pub extension: u16,
}

/// Fixed canonical ports — never change unless intentional.
pub const DEFAULT_PORTS: Ports = Ports {
    cdp: 9000,
    server: 9105,
    extension: 9305,
};

/// Kill whatever is on the port, wait for OS release, then bind.
/// FATAL if port is still in use after kill — NO fallback.
pub fn reserve_fixed(port: u16) -> Result<TcpListener> {
    kill_port(port);
    thread::sleep(Duration::from_millis(600));
    TcpListener::bind(format!("127.0.0.1:{}", port))
        .with_context(|| format!("Port {} still in use after kill — free it manually", port))
}

pub fn reserve_all_fixed() -> Result<(TcpListener, TcpListener, TcpListener)> {
    let p = DEFAULT_PORTS;
    let cdp = reserve_fixed(p.cdp)
        .with_context(|| format!("CDP port {}", p.cdp))?;
    let server = reserve_fixed(p.server)
        .with_context(|| format!("Server port {}", p.server))?;
    let ext = reserve_fixed(p.extension)
        .with_context(|| format!("Extension port {}", p.extension))?;
    Ok((cdp, server, ext))
}

/// Kill all three default ports.
pub fn kill_defaults() {
    kill_port(DEFAULT_PORTS.cdp);
    kill_port(DEFAULT_PORTS.server);
    kill_port(DEFAULT_PORTS.extension);
}

pub fn kill_port(port: u16) {
    // lsof -ti:<port> | xargs kill -9
    let pids_out = Command::new("lsof")
        .args(["-ti", &format!(":{}", port)])
        .output();
    if let Ok(out) = pids_out {
        let pids = String::from_utf8_lossy(&out.stdout);
        for pid in pids.split_whitespace() {
            if let Ok(pid_num) = pid.trim().parse::<u32>() {
                let _ = Command::new("kill")
                    .args(["-9", &pid_num.to_string()])
                    .output();
            }
        }
    }
}

pub fn is_port_free(port: u16) -> bool {
    TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok()
}

/// Random ports for --new mode (parallel test runs)
pub fn reserve_random() -> Result<(Ports, TcpListener, TcpListener, TcpListener)> {
    for _ in 0..100 {
        let cdp = random_port_in_range(9200, 9900)?;
        let server = random_port_in_range(9200, 9900)?;
        let ext = random_port_in_range(9200, 9900)?;
        if cdp == server || cdp == ext || server == ext {
            continue;
        }
        if let (Ok(l1), Ok(l2), Ok(l3)) = (
            TcpListener::bind(format!("127.0.0.1:{}", cdp)),
            TcpListener::bind(format!("127.0.0.1:{}", server)),
            TcpListener::bind(format!("127.0.0.1:{}", ext)),
        ) {
            return Ok((
                Ports { cdp, server, extension: ext },
                l1, l2, l3,
            ));
        }
    }
    bail!("Could not find 3 free random ports after 100 attempts")
}

fn random_port_in_range(lo: u16, hi: u16) -> Result<u16> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    Ok(lo + (seed as u16 % (hi - lo)))
}
