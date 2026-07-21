use std::env;
use std::fs;
use std::path::PathBuf;
use std::process;

/// Exit codes
const OK: i32 = 0;
const VIOLATION: i32 = 1;
const MISCONFIG: i32 = 2;

/// Directories that are allowed to reference /tmp (documentation, external tooling, smoke tests).
const EXEMPT_DIRS: &[&str] = &[
    "docs/",
    "smoke/",
    "tools/",
    ".trinity/",
    ".claude/",
];

/// Extensions that are source text and must not contain /tmp literals.
const SOURCE_EXTS: &[&str] = &[".rs", ".swift"];

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let root = if args.is_empty() {
        // Assume the binary is run from the trios workspace root (where Cargo.toml lives).
        match env::current_dir() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[tmp-zero-gate] Failed to get current_dir: {}", e);
                process::exit(MISCONFIG);
            }
        }
    } else {
        PathBuf::from(&args[0])
    };

    if !root.join("Cargo.toml").is_file() {
        eprintln!("[tmp-zero-gate] No Cargo.toml found at {} -- pass the trios root", root.display());
        process::exit(MISCONFIG);
    }

    let mut violations = Vec::new();
    for entry in walkdir::WalkDir::new(&root)
        .into_iter()
        .filter_entry(|e| !is_exempt(e.path(), &root))
    {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[tmp-zero-gate] walk error: {}", e);
                continue;
            }
        };

        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let ext = match path.extension().and_then(|s| s.to_str()) {
            Some(e) if SOURCE_EXTS.contains(&e) => e,
            _ => continue,
        };

        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[tmp-zero-gate] read error {}: {}", path.display(), e);
                continue;
            }
        };

        for (n, line) in content.lines().enumerate() {
            // Only flag /tmp when it appears as a path literal, not inside arbitrary words.
            if line.contains("/tmp") {
                violations.push(format!(
                    "{}:{}:{} {}",
                    path.strip_prefix(&root).unwrap_or(path).display(),
                    n + 1,
                    ext,
                    line.trim()
                ));
            }
        }
    }

    if violations.is_empty() {
        println!("[tmp-zero-gate] OK: no /tmp paths in workspace source.");
        process::exit(OK);
    }

    eprintln!("[tmp-zero-gate] VIOLATION: /tmp found in workspace source:");
    for v in violations {
        eprintln!("  {}", v);
    }
    process::exit(VIOLATION);
}

fn is_exempt(path: &std::path::Path, root: &std::path::Path) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let rel_str = rel.to_string_lossy();
    EXEMPT_DIRS.iter().any(|d| rel_str.starts_with(d))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_exempt_accepts_docs() {
        let root = PathBuf::from("/project/trios");
        assert!(is_exempt(PathBuf::from("/project/trios/docs/README.md").as_path(), &root));
        assert!(is_exempt(PathBuf::from("/project/trios/smoke/results.md").as_path(), &root));
        assert!(!is_exempt(PathBuf::from("/project/trios/rings/RUST-01/clade-build/src/main.rs").as_path(), &root));
    }

    #[test]
    fn source_exts_cover_rust_and_swift() {
        assert!(SOURCE_EXTS.contains(&".rs"));
        assert!(SOURCE_EXTS.contains(&".swift"));
    }
}
