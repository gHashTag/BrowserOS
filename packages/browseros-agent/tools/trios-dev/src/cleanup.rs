use anyhow::Result;
use std::fs;

use crate::log;
use crate::ports;

pub fn run() -> Result<()> {
    log::info("cleanup", "Killing dev ports...");
    ports::kill_defaults();
    log::info("cleanup", "Ports cleared");

    let tmp = std::env::temp_dir();
    let prefixes = ["trios-dev", "trios-test", "browseros-dev", "browseros-test"];
    let mut removed = 0usize;

    if let Ok(entries) = fs::read_dir(&tmp) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_str().unwrap_or("");
            if prefixes.iter().any(|p| name_str.starts_with(p)) {
                if entry.path().is_dir() {
                    if fs::remove_dir_all(entry.path()).is_ok() {
                        removed += 1;
                    }
                }
            }
        }
    }

    if removed > 0 {
        log::info("cleanup", &format!("Removed {} temp directories", removed));
    } else {
        log::info("cleanup", "No temp directories to clean");
    }
    Ok(())
}
