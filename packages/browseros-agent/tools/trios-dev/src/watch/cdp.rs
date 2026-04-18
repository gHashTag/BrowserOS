//! CDP (Chrome DevTools Protocol) waiter — waits for browser to be ready

use crate::browser;
use crate::infrastructure::http::HttpClient;
use anyhow::Result;

/// Wait for CDP to become available on the specified port
pub async fn wait_for_cdp_ready(http: &HttpClient, cdp_port: u16, timeout_secs: u64) -> Result<()> {
    crate::log::server("Waiting for CDP...");
    if browser::wait_for_cdp(http, cdp_port, timeout_secs).await {
        crate::log::server("CDP ready");
        Ok(())
    } else {
        Err(anyhow::anyhow!(
            "CDP not available after {}s — check TRIOS.app/BrowserOS.app is installed",
            timeout_secs
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_wait_for_cdp_ready_timeout() {
        let http = HttpClient::new();
        let result = wait_for_cdp_ready(&http, 9999, 1).await;
        assert!(result.is_err());
    }
}
