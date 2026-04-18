//! Async HTTP client for health checks and CDP polling

use reqwest::Client;
use tokio::time::{timeout, Duration};

/// Async HTTP client with timeout support
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct HttpClient {
    client: Client,
    default_timeout: Duration,
}

#[allow(dead_code)]
impl HttpClient {
    /// Create a new HTTP client with default 2-second timeout
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap_or_default(),
            default_timeout: Duration::from_secs(2),
        }
    }

    /// Create a new HTTP client with custom timeout
    pub fn with_timeout(timeout_secs: u64) -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(timeout_secs))
                .build()
                .unwrap_or_default(),
            default_timeout: Duration::from_secs(timeout_secs),
        }
    }

    /// Wait for a URL to become available
    ///
    /// Returns true if the URL responds successfully within timeout_secs
    /// Polls every 500ms by default
    pub async fn wait_for_url(&self, url: &str, timeout_secs: u64) -> bool {
        self.wait_for_url_with_interval(url, timeout_secs, Duration::from_millis(500))
            .await
    }

    /// Wait for a URL with custom poll interval
    pub async fn wait_for_url_with_interval(
        &self,
        url: &str,
        timeout_secs: u64,
        interval: Duration,
    ) -> bool {
        let deadline = Duration::from_secs(timeout_secs);
        let mut ticker = tokio::time::interval(interval);
        ticker.tick().await; // Skip first immediate tick

        timeout(deadline, async {
            loop {
                ticker.tick().await;
                if self.client.get(url).send().await.is_ok() {
                    return true;
                }
            }
        })
        .await
        .is_ok()
    }

    /// Check if a URL is available immediately (no polling)
    pub async fn is_available(&self, url: &str) -> bool {
        self.client
            .get(url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// Get the underlying reqwest client
    pub fn client(&self) -> &Client {
        &self.client
    }
}

impl Default for HttpClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_http_client_creation() {
        let client = HttpClient::new();
        assert_eq!(client.default_timeout.as_secs(), 2);
    }

    #[tokio::test]
    async fn test_http_client_with_custom_timeout() {
        let client = HttpClient::with_timeout(10);
        assert_eq!(client.default_timeout.as_secs(), 10);
    }

    #[tokio::test]
    async fn test_is_available_invalid_url() {
        let client = HttpClient::new();
        assert!(!client.is_available("http://127.0.0.1:99999").await);
    }
}
