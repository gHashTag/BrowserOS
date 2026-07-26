use std::env;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn project_dir() -> String { trios_config::project_dir() }

struct Variant {
    name: &'static str,
    output: PathBuf,
    app_bundle: PathBuf,
    bundle_id: &'static str,
    mcp_port: &'static str,
    a2a_port: &'static str,
    mesh_port: &'static str,
    canary_mcp_port: &'static str,
    build_root: PathBuf,
}

fn main() {
    let variant_name = env::var("TRIOS_VARIANT").unwrap_or_else(|_| "prod".into());
    let variant = resolve_variant(&variant_name);

    println!(
        "[CladeBuild] Variant={}, output={}",
        variant.name,
        variant.output.display()
    );

    // Collect Swift files — match build.sh: all rings, only the lean BR-OUTPUT
    // whitelist so untracked prototypes cannot break the app build.
    let mut swift_files = vec![variant.build_root.join("main.swift")];
    collect_swift_files(&variant.build_root.join("rings"), &mut swift_files);
    collect_lean_br_output(&variant.build_root.join("BR-OUTPUT"), &mut swift_files);

    let file_count = swift_files.len();

    // Build Trinity QueenUILib dependency first so the trios sources can import it.
    let queen_bin_dir = match build_queen_lib() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[FAIL] {}", e);
            std::process::exit(1);
        }
    };
    let queen_modules_dir = format!("{}/Modules", queen_bin_dir);

    // SQLCipher is required for the encrypted agent-memory store. Discover the
    // Homebrew-installed library and CSQLCipher module map (sibling to trios).
    let sqlcipher = match resolve_sqlcipher(&variant.build_root) {
        Ok(s) => s,
        Err(e) => { eprintln!("[FAIL] {}", e); std::process::exit(1); }
    };

    // Build
    let mut cmd = Command::new("swiftc");
    cmd.arg("-O")
        .arg("-o")
        .arg(&variant.output)
        .arg("-framework")
        .arg("SwiftUI")
        .arg("-framework")
        .arg("AppKit")
        .arg("-framework")
        .arg("WebKit")
        .arg("-framework")
        .arg("Combine")
        .arg("-framework")
        .arg("Security")
        .arg("-I")
        .arg(&sqlcipher.csqlcipher_modulemap_dir)
        .arg("-I")
        .arg(&sqlcipher.include_dir)
        .arg("-L")
        .arg(&sqlcipher.lib_dir)
        .arg("-lsqlcipher")
        .arg("-I")
        .arg(&queen_modules_dir)
        .arg("-L")
        .arg(&queen_bin_dir)
        .arg("-lQueenUILib")
        .arg("-Xlinker")
        .arg("-rpath")
        .arg("-Xlinker")
        .arg("@executable_path/Frameworks")
        .arg("-Xlinker")
        .arg("-rpath")
        .arg("-Xlinker")
        .arg("@executable_path/../Frameworks");

    for f in &swift_files {
        cmd.arg(f);
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let output = match cmd.output() {
        Ok(o) => o,
        Err(e) => { eprintln!("[FAIL] swiftc failed to start: {}", e); std::process::exit(1); }
    };
    let log_path = format!("{}/.trinity/logs/clade-build_{}.log", project_dir(), variant.name);
    if let Err(e) = fs::write(&log_path, &output.stderr) {
        eprintln!("[build] Failed to write build log {}: {}", log_path, e);
    }

    if !output.status.success() {
        eprintln!("[FAIL] Build failed for variant={}", variant.name);
        eprintln!("{}", String::from_utf8_lossy(&output.stderr));
        std::process::exit(1);
    }

    println!("[OK] Build successful: {}", variant.output.display());
    if let Err(e) = fs::set_permissions(&variant.output, std::fs::Permissions::from_mode(0o755)) {
        eprintln!("[CladeBuild] Failed to set binary permissions: {}", e);
    }

    // Ensure .app bundle structure
    let macos = variant.app_bundle.join("Contents/MacOS");
    let resources = variant.app_bundle.join("Contents/Resources");
    if let Err(e) = fs::create_dir_all(&macos) {
        eprintln!("[CladeBuild] Failed to create MacOS dir: {}", e);
    }
    if let Err(e) = fs::create_dir_all(&resources) {
        eprintln!("[CladeBuild] Failed to create Resources dir: {}", e);
    }

    // Generate Info.plist
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>trios</string>
    <key>CFBundleIdentifier</key><string>{}</string>
    <key>CFBundleName</key><string>Trios {}</string>
    <key>CFBundleVersion</key><string>1.0.0</string>
    <key>CFBundleShortVersionString</key><string>1.0.0</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>TRIOS_VARIANT</key><string>{}</string>
    <key>TRIOS_MCP_PORT</key><string>{}</string>
    <key>TRIOS_A2A_PORT</key><string>{}</string>
    <key>TRIOS_MESH_PORT</key><string>{}</string>
    <key>TRIOS_CANARY_MCP_PORT</key><string>{}</string>
</dict>
</plist>"#,
        variant.bundle_id,
        capitalize(variant.name),
        variant.name,
        variant.mcp_port,
        variant.a2a_port,
        variant.mesh_port,
        variant.canary_mcp_port
    );
    if let Err(e) = fs::write(variant.app_bundle.join("Contents/Info.plist"), plist) {
        eprintln!("[FAIL] Failed to write Info.plist: {}", e);
        std::process::exit(1);
    }

    // Bundle the SQLCipher dynamic library so the .app is runnable on its own.
    let frameworks = variant.app_bundle.join("Contents/Frameworks");
    if let Err(e) = fs::create_dir_all(&frameworks) {
        eprintln!("[CladeBuild] Failed to create Frameworks dir: {}", e);
    }
    let bundled_dylib = frameworks.join(&sqlcipher.dylib_name);
    if let Err(e) = bundle_sqlcipher_dylib(&sqlcipher.dylib_source, &bundled_dylib, &variant.output
    ) {
        eprintln!("[CladeBuild] Failed to bundle SQLCipher dylib: {}", e);
    }

    println!(
        "[OK] Copied to .app bundle: {} (files={}, ports MCP={} A2A={} MESH={} CANARY={})",
        variant.app_bundle.display(),
        file_count,
        variant.mcp_port,
        variant.a2a_port,
        variant.mesh_port,
        variant.canary_mcp_port
    );
}

struct SQLCipherPaths {
    include_dir: String,
    lib_dir: String,
    csqlcipher_modulemap_dir: String,
    dylib_source: PathBuf,
    dylib_name: String,
}

fn resolve_sqlcipher(build_root: &Path) -> Result<SQLCipherPaths, String> {
    let include_dir = run_pkg_config("--variable=includedir")?;
    let lib_dir = run_pkg_config("--variable=libdir")?;
    let csqlcipher_modulemap_dir = build_root
        .parent()
        .map(|p| p.join("Sources/CSQLCipher"))
        .ok_or_else(|| "Cannot locate Sources/CSQLCipher".to_string())?
        .to_string_lossy()
        .to_string();
    let dylib_source = find_sqlcipher_dylib(&lib_dir)?;
    Ok(SQLCipherPaths {
        include_dir,
        lib_dir,
        csqlcipher_modulemap_dir,
        dylib_source,
        dylib_name: "libsqlcipher.dylib".to_string(),
    })
}

fn run_pkg_config(arg: &str) -> Result<String, String> {
    let output = Command::new("pkg-config")
        .arg(arg)
        .arg("sqlcipher")
        .output()
        .map_err(|e| format!("pkg-config failed: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "pkg-config {} sqlcipher failed: {}",
            arg,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    String::from_utf8(output.stdout)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("invalid utf8 from pkg-config: {}", e))
}

fn find_sqlcipher_dylib(lib_dir: &str) -> Result<PathBuf, String> {
    let entries = fs::read_dir(lib_dir)
        .map_err(|e| format!("read SQLCipher lib dir {}: {}", lib_dir, e))?;
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        // Use the real versioned file (e.g. libsqlcipher.3.53.3.dylib), not symlinks.
        if name.starts_with("libsqlcipher.") && name.ends_with(".dylib") {
            if path.symlink_metadata()
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
            {
                continue;
            }
            return Ok(path);
        }
    }
    Err(format!("No SQLCipher dynamic library found in {}", lib_dir))
}

fn bundle_sqlcipher_dylib(source: &Path, dest: &Path, binary: &Path) -> Result<(), String> {
    let _ = fs::remove_file(dest);
    fs::copy(source, dest).map_err(|e| {
        format!(
            "copy {} to {}: {}",
            source.display(),
            dest.display(),
            e
        )
    })?;
    let mut perms = fs::metadata(dest)
        .map_err(|e| format!("metadata {}: {}", dest.display(), e))?
        .permissions();
    perms.set_mode(0o755);
    fs::set_permissions(dest, perms)
        .map_err(|e| format!("chmod {}: {}", dest.display(), e))?;
    run_install_name_tool(&[
        "-id",
        "@rpath/libsqlcipher.dylib",
        dest.to_str().unwrap_or_default(),
    ],
    "set dylib id")?;
    run_install_name_tool(
        &[
            "-change",
            "/opt/homebrew/opt/sqlcipher/lib/libsqlcipher.dylib",
            "@rpath/libsqlcipher.dylib",
            binary.to_str().unwrap_or_default(),
        ],
        "patch binary rpath",
    )?;
    Ok(())
}

fn run_install_name_tool(args: &[&str], context: &str) -> Result<(), String> {
    let output = Command::new("install_name_tool")
        .args(args)
        .output()
        .map_err(|e| format!("install_name_tool {} failed: {}", context, e))?;
    if !output.status.success() {
        return Err(format!(
            "install_name_tool {}: {}",
            context,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

fn resolve_variant(name: &str) -> Variant {
    if name == "staging" {
        Variant {
            name: "staging",
            output: PathBuf::from(format!("{}/.worktrees/staging/trios_app", &project_dir())),
            app_bundle: PathBuf::from(format!("{}/.worktrees/staging/trios-staging.app", &project_dir())),
            bundle_id: "com.browseros.trios.staging",
            mcp_port: "9205",
            a2a_port: "9300",
            mesh_port: "9505",
            canary_mcp_port: "9205",
            build_root: PathBuf::from(format!("{}/.worktrees/staging/trios", &project_dir())),
        }
    } else {
        Variant {
            name: "prod",
            output: PathBuf::from(format!("{}/trios_app", &project_dir())),
            app_bundle: PathBuf::from(format!("{}/trios.app", &project_dir())),
            bundle_id: "com.browseros.trios",
            mcp_port: "9105",
            a2a_port: "9200",
            mesh_port: "9505",
            canary_mcp_port: "9205",
            build_root: PathBuf::from(&project_dir()),
        }
    }
}

fn collect_swift_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_dir() {
            collect_swift_files(&path, out);
        } else if path.extension().map(|e| e == "swift").unwrap_or(false) {
            out.push(path);
        }
    }
}

/// Only include the production BR-OUTPUT files that build.sh compiles.
/// Untracked BR-OUTPUT prototypes must not break the app build.
fn collect_lean_br_output(dir: &Path, out: &mut Vec<PathBuf>) {
    const LEAN_BR_OUTPUT: &[&str] = &[
        "A2AMessageRouter.swift",
        "BrowserOSChatViewModel.swift",
        "ChatLogic.swift",
        "ChatPanelView.swift",
        "ChatSidebarView.swift",
        "CladeGuard.swift",
        "FullscreenChatWorkspace.swift",
        "GitButlerPanelView.swift",
        "GitButlerViewModel.swift",
        "GitHubAPIClient.swift",
        "GitHubDashboardView.swift",
        "GitHubModels.swift",
        "GitWorkspaceView.swift",
        "GlassmorphismBackground.swift",
        "HotkeyBar.swift",
        "LLMClient.swift",
        "MenuBuilder.swift",
        "MeshAuth.swift",
        "MeshChatListView.swift",
        "MeshChatModels.swift",
        "MeshChatThreadView.swift",
        "MeshChatView.swift",
        "MeshChatViewModel.swift",
        "MeshModels.swift",
        "MeshStatusViewModel.swift",
        "MeshTabView.swift",
        "MessageBubbleView.swift",
        "ModelsTabView.swift",
        "ProjectPaths.swift",
        "QueenStatusViewModel.swift",
        "QueenTabView.swift",
        "RecursionGuard.swift",
        "RichTextRenderer.swift",
        "ServerManager.swift",
        "SessionGuard.swift",
        "SmoothStreamingEnhancements.swift",
        "TODOAnimations.swift",
        "TODOListView.swift",
        "TerminalTabView.swift",
        "ToolCallCardView.swift",
        "TriosMCPClient.swift",
        "TriosTabView.swift",
        "TriosTheme.swift",
        "TypingIndicatorView.swift",
        "WindowManager.swift",
    ];
    for name in LEAN_BR_OUTPUT {
        let path = dir.join(name);
        if path.is_file() {
            out.push(path);
        }
    }
}

fn queen_package_root() -> Result<PathBuf, String> {
    let project = PathBuf::from(project_dir());
    let trinity_root = if let Ok(root) = env::var("TRINITY_ROOT") {
        PathBuf::from(root)
    } else {
        let ancestor = project
            .parent()
            .and_then(|p| p.parent())
            .ok_or_else(|| "Cannot derive TRINITY_ROOT from project directory; set TRINITY_ROOT".to_string())?;
        ancestor.join("trinity")
    };
    let queen_pkg = trinity_root.join("apps/queen");
    if !queen_pkg.join("Package.swift").is_file() {
        return Err(format!(
            "Canonical Queen package not found: {}. Set TRINITY_ROOT to the gHashTag/trinity checkout.",
            queen_pkg.display()
        ));
    }
    Ok(queen_pkg)
}

fn build_queen_lib() -> Result<String, String> {
    let queen_pkg = queen_package_root()?;

    if env::var("TRIOS_REUSE_QUEEN_BUILD").is_err() {
        println!("[CladeBuild] Building QueenUILib at {}", queen_pkg.display());
        let output = Command::new("swift")
            .arg("build")
            .arg("--package-path")
            .arg(&queen_pkg)
            .arg("--product")
            .arg("QueenUILib")
            .output()
            .map_err(|e| format!("swift build failed to start: {}", e))?;
        if !output.status.success() {
            return Err(format!(
                "QueenUILib build failed:\n{}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    } else {
        println!("[CladeBuild] Reusing existing QueenUILib build");
    }

    let output = Command::new("swift")
        .arg("build")
        .arg("--package-path")
        .arg(&queen_pkg)
        .arg("--show-bin-path")
        .output()
        .map_err(|e| format!("swift build --show-bin-path failed to start: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "swift build --show-bin-path failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let bin_path = String::from_utf8(output.stdout)
        .map_err(|e| format!("invalid UTF-8 from swift build: {}", e))?;
    let bin_path = bin_path.trim();
    let dylib = Path::new(bin_path).join("libQueenUILib.dylib");
    if !dylib.is_file() {
        return Err(format!("QueenUILib was not produced: {}", dylib.display()));
    }
    Ok(bin_path.to_string())
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capitalize_empty() {
        assert_eq!(capitalize(""), "");
    }

    #[test]
    fn capitalize_single_char() {
        assert_eq!(capitalize("a"), "A");
    }

    #[test]
    fn capitalize_word() {
        assert_eq!(capitalize("staging"), "Staging");
    }

    #[test]
    fn capitalize_already_upper() {
        assert_eq!(capitalize("Prod"), "Prod");
    }

    #[test]
    fn resolve_variant_prod() {
        let v = resolve_variant("prod");
        assert_eq!(v.name, "prod");
        assert_eq!(v.mcp_port, "9105");
        assert_eq!(v.a2a_port, "9200");
        assert_eq!(v.mesh_port, "9505");
        assert_eq!(v.canary_mcp_port, "9205");
        assert_eq!(v.bundle_id, "com.browseros.trios");
    }

    #[test]
    fn resolve_variant_staging() {
        let v = resolve_variant("staging");
        assert_eq!(v.name, "staging");
        assert_eq!(v.mcp_port, "9205");
        assert_eq!(v.a2a_port, "9300");
        assert_eq!(v.mesh_port, "9505");
        assert_eq!(v.canary_mcp_port, "9205");
        assert_eq!(v.bundle_id, "com.browseros.trios.staging");
    }

    #[test]
    fn resolve_variant_unknown_defaults_to_prod() {
        let v = resolve_variant("anything");
        assert_eq!(v.name, "prod");
    }
}
