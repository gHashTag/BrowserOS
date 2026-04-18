mod browser;
mod cleanup;
mod log;
mod ports;
mod proc;
mod watch;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "trios-dev",
    about = "TRIOS development runner (Rust)",
    version = "0.1.0"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start dev environment with HMR + browser + server
    Watch {
        /// Use random ports (for parallel runs)
        #[arg(long)]
        new: bool,
        /// Build agent statically instead of WXT HMR
        #[arg(long)]
        manual: bool,
    },
    /// Start test environment, run bun test, clean up
    Test {
        /// Keep processes alive after tests (debug)
        #[arg(long)]
        keep: bool,
        /// Run TRIOS headless
        #[arg(long)]
        headless: bool,
        /// Extra args passed to bun test
        #[arg(last = true)]
        args: Vec<String>,
    },
    /// Clean up orphaned temp dirs and kill dev ports
    Cleanup,
    /// Verify no BrowserOS references remain (run after any rename)
    Check,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Watch { new, manual } => watch::run(new, manual),
        Commands::Test { keep, headless, args } => watch::run_test(keep, headless, args),
        Commands::Cleanup => cleanup::run(),
        Commands::Check => {
            let root = proc::find_monorepo_root()?;
            let issues = browser::check_rename(&root);
            if issues.is_empty() {
                log::info("check", "\x1b[32m✔ No BrowserOS references found\x1b[0m");
                Ok(())
            } else {
                for i in &issues {
                    log::error("check", i);
                }
                anyhow::bail!("{} rename issue(s) found — fix before commit", issues.len())
            }
        }
    }
}
