use anyhow::{bail, Context, Result};
use rand::Rng;
use std::net::TcpListener;
use std::process::Command;
use std::thread;
use std::time::Duration;

/// Maximum number of retry attempts when reserving a fixed port
const MAX_RETRY_ATTEMPTS: u32 = 5;
/// Base delay between retry attempts in milliseconds
const BASE_RETRY_DELAY_MS: u64 = 600;

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

/// Kill whatever is on the port, wait for OS release with exponential backoff, then bind.
/// FATAL if port is still in use after MAX_RETRY_ATTEMPTS retries.
pub fn reserve_fixed(port: u16) -> Result<TcpListener> {
    reserve_fixed_with_retry(port, MAX_RETRY_ATTEMPTS)
}

/// Kill whatever is on the port, wait for OS release with exponential backoff, then bind.
/// Retries up to `max_retries` times with increasing delay.
pub fn reserve_fixed_with_retry(port: u16, max_retries: u32) -> Result<TcpListener> {
    for attempt in 0..max_retries {
        kill_port(port);
        // Exponential backoff: 600ms, 1200ms, 1800ms, ...
        let delay_ms = BASE_RETRY_DELAY_MS * (attempt + 1) as u64;
        thread::sleep(Duration::from_millis(delay_ms));
        match TcpListener::bind(format!("127.0.0.1:{}", port)) {
            Ok(listener) => return Ok(listener),
            Err(_) if attempt < max_retries - 1 => {
                // Port still in use, retry
                continue;
            }
            Err(e) => bail!(
                "Port {} unavailable after {} retries: {}",
                port,
                max_retries,
                e
            ),
        }
    }
    unreachable!()
}

pub fn reserve_all_fixed() -> Result<(TcpListener, TcpListener, TcpListener)> {
    let p = DEFAULT_PORTS;
    let cdp = reserve_fixed(p.cdp).with_context(|| format!("CDP port {}", p.cdp))?;
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

/// Kill any process using the specified port.
pub fn kill_port(port: u16) {
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

/// Check if a port is free without reserving it.
/// Used by check subcommand and diagnostics.
#[allow(dead_code)]
pub fn is_port_free(port: u16) -> bool {
    TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok()
}

/// Random ports for --new mode (parallel test runs).
/// Uses cryptographically secure random number generator.
pub fn reserve_random() -> Result<(Ports, TcpListener, TcpListener, TcpListener)> {
    let mut rng = rand::thread_rng();

    for _ in 0..100 {
        let cdp = random_port_in_range(&mut rng, 9200, 9900)?;
        let server = random_port_in_range(&mut rng, 9200, 9900)?;
        let ext = random_port_in_range(&mut rng, 9200, 9900)?;

        // Ensure all ports are unique
        if cdp == server || cdp == ext || server == ext {
            continue;
        }

        if let (Ok(l1), Ok(l2), Ok(l3)) = (
            TcpListener::bind(format!("127.0.0.1:{}", cdp)),
            TcpListener::bind(format!("127.0.0.1:{}", server)),
            TcpListener::bind(format!("127.0.0.1:{}", ext)),
        ) {
            return Ok((Ports { cdp, server, extension: ext }, l1, l2, l3));
        }
    }
    bail!("Could not find 3 free random ports after 100 attempts")
}

/// Generate a random port in the given range [lo, hi).
/// Uses cryptographically secure random number generator.
fn random_port_in_range<R: Rng>(rng: &mut R, lo: u16, hi: u16) -> Result<u16> {
    if lo >= hi {
        bail!("Invalid port range: {} >= {}", lo, hi);
    }
    Ok(rng.gen_range(lo..hi))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reserve_fixed_with_retry_success() {
        // Find a free port and verify we can reserve it
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let result = reserve_fixed_with_retry(port, 3);
        assert!(result.is_ok(), "Should succeed on free port");
    }

    #[test]
    fn test_random_ports_no_collision() {
        let (ports, _, _, _) = reserve_random().unwrap();
        assert_ne!(ports.cdp, ports.server, "CDP and server ports must differ");
        assert_ne!(ports.cdp, ports.extension, "CDP and extension ports must differ");
        assert_ne!(ports.server, ports.extension, "Server and extension ports must differ");

        // Verify ports are in expected range
        assert!(ports.cdp >= 9200 && ports.cdp < 9900, "CDP port out of range");
        assert!(ports.server >= 9200 && ports.server < 9900, "Server port out of range");
        assert!(ports.extension >= 9200 && ports.extension < 9900, "Extension port out of range");
    }

    #[test]
    fn test_random_port_in_range() {
        let mut rng = rand::thread_rng();
        for _ in 0..10 {
            let port = random_port_in_range(&mut rng, 1000, 2000).unwrap();
            assert!(port >= 1000 && port < 2000, "Port out of range");
        }
    }

    #[test]
    fn test_random_port_in_range_invalid() {
        let mut rng = rand::thread_rng();
        let result = random_port_in_range(&mut rng, 2000, 1000);
        assert!(result.is_err(), "Should fail for invalid range");
    }

    #[test]
    fn test_default_ports() {
        assert_eq!(DEFAULT_PORTS.cdp, 9000);
        assert_eq!(DEFAULT_PORTS.server, 9105);
        assert_eq!(DEFAULT_PORTS.extension, 9305);
    }
}
