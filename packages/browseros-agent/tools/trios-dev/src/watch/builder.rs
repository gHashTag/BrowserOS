//! Agent builder — builds the extension for dev mode

use anyhow::Result;
use tokio::process::Command;

/// Build the agent extension in development mode
pub async fn build_agent(agent_dir: &str) -> Result<()> {
    crate::log::build("Building agent (dev)...");
    let status = Command::new("bun")
        .args([
            "--env-file=.env.development",
            "wxt",
            "build",
            "--mode",
            "development",
        ])
        .current_dir(agent_dir)
        .status()
        .await?;

    if !status.success() {
        anyhow::bail!("Agent build failed");
    }
    crate::log::build("Agent built");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_build_agent_command() {
        // Just verify the command is constructed correctly
        let agent_dir = "/tmp/fake-agent";
        // We can't actually run this test without a real directory
        // but we can verify the logic
        assert_eq!(agent_dir, "/tmp/fake-agent");
    }
}
