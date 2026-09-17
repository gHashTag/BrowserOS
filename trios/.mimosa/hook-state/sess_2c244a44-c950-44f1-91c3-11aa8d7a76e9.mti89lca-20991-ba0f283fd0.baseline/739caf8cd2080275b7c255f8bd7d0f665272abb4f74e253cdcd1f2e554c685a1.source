# 📋 TRIOS Installation TODO List — Another Computer

**Target**: Clean macOS installation on different machine  
**Source**: `/Users/playra/BrowserOS/trios/`  
**Author**: Dmitrii Vasilev (@gHashTag)  
**Date**: 2026-05-28

---

## ✅ Phase 1: Prerequisites (30 min)

### 1.1 System Requirements
- [ ] macOS 14.0+ (Sonoma or later)
- [ ] Xcode 15.0+ installed from App Store
- [ ] Command Line Tools: `xcode-select --install`
- [ ] Swift 5.9+: `swift --version`
- [ ] Homebrew: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`

### 1.2 Install Dependencies
```bash
# Tailscale (for remote access)
brew install tailscale

# Git (if not present)
brew install git

# Verify installations
tailscale --version
git --version
swift --version
```

### 1.3 Clone Repository
```bash
# Clone main repo
git clone https://github.com/gHashTag/BrowserOS.git
cd BrowserOS/trios

# Clone Trinity dependency (required for QueenUILib)
git clone https://github.com/gHashTag/trinity.git ~/trinity
export TRINITY_ROOT=~/trinity
```

---

## ✅ Phase 2: Build Trios (15 min)

### 2.1 Set Environment
```bash
cd /path/to/BrowserOS/trios
export TRIOS_ROOT=$(pwd)
export TRINITY_ROOT=~/trinity
```

### 2.2 Build Application
```bash
# Make build script executable
chmod +x build.sh

# Run build
./build.sh
```

**Expected output:**
```
Building canonical Trinity Queen interface...
Compiling 95 Swift files...
[OK] Build successful: ./trios_app
[OK] Copied and signed .app bundle (bundle ID: com.browseros.trios)
[OK] Chat integration tests passed
[OK] swift test passed
```

### 2.3 Verify Build Artifacts
```bash
# Check binary exists
ls -lh trios_app
# Should be ~13MB Mach-O executable

# Check .app bundle
ls -lh trios.app/Contents/MacOS/trios
ls -lh trios.app/Contents/Frameworks/libQueenUILib.dylib
ls -lh trios.app/Contents/Info.plist
```

---

## ✅ Phase 3: Install Application (5 min)

### 3.1 Copy to Applications
```bash
# Create Applications folder if needed
mkdir -p ~/Applications

# Copy trios.app
cp -R ./trios.app ~/Applications/

# Verify installation
ls -lh ~/Applications/trios.app
```

### 3.2 First Launch
```bash
# Launch via terminal (first time)
open ~/Applications/trios.app

# Or double-click in Finder → Applications → trios
```

### 3.3 Grant Permissions
**System Settings → Privacy & Security:**
- [ ] **Accessibility**: Enable for window shifting feature
  - Trios needs this to shift desktop windows left
  - Required for `WindowManager.swift` functionality
- [ ] **Screen Recording** (if using screen capture features)
- [ ] **Automation** (if controlling other apps)

**First launch checklist:**
- [ ] Status bar icon appears (top-right, next to Wi-Fi)
- [ ] Click icon → panel slides in from right
- [ ] Keyboard shortcut `Cmd+Shift+T` toggles panel
- [ ] No crash logs in Console.app

---

## ✅ Phase 4: Configure Backend Services (20 min)

### 4.1 Install Node.js & Bun (for BrowserOS Agent)
```bash
# Install Node.js 20+
brew install node@20

# Install Bun
curl -fsSL https://bun.sh/install | bash

# Verify
node --version
bun --version
```

### 4.2 Install Rust (for trios-server)
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# Verify
rustc --version
cargo --version
```

### 4.3 Install GitButler CLI (but)
```bash
cargo install but

# Verify
but --version
```

### 4.4 Setup Trinity Services
```bash
cd ~/trios  # or wherever trios-mcp-bridge lives

# Install PM2 globally
npm install -g pm2

# Install dependencies
cd browseros-mcp && bun install
cd ../trios-bridge && bun install
cd ../trios-server && cargo build --release
```

### 4.5 Start Services via PM2
```bash
cd ~/trios
pm2 start ecosystem.config.cjs

# Check status
pm2 status

# Expected:
# ┌────┬────────────────────┬──────────┬──────┬───────────┬──────────┬──────────┐
# │ id │ name               │ mode     │ ↺    │ status    │ cpu      │ memory   │
# ├────┼────────────────────┼──────────┼──────┼───────────┼──────────┼──────────┤
# │ 0  │ trios-server       │ fork     │ 0    │ online    │ 0%       │ 45.2mb   │
# │ 1  │ browseros-mcp      │ fork     │ 0    │ online    │ 0%       │ 32.1mb   │
# │ 2  │ trios-bridge       │ fork     │ 0    │ online    │ 0%       │ 28.7mb   │
# └────┴────────────────────┴──────────┴──────┴───────────┴──────────┴──────────┘
```

### 4.6 Verify Service Ports
```bash
# Check all ports are listening
lsof -i :9005  # trios-server
lsof -i :9105  # browseros-mcp
lsof -i :9203  # trios-bridge

# Or use health check script
~/trios/scripts/health-check.sh
```

---

## ✅ Phase 5: Configure Tailscale (Optional, 10 min)

### 5.1 Install & Authenticate
```bash
# Already installed via brew in Phase 1

# Authenticate
tailscale up

# This opens browser for OAuth login
```

### 5.2 Enable Funnel (Public Access)
```bash
# Start funnel for port 9105 (BrowserOS MCP)
tailscale funnel 9105

# Or use serve for tailnet-only access
tailscale serve --https=443 http://127.0.0.1:9105
```

### 5.3 Get Your Tailscale URL
```bash
# Get your machine's tailnet hostname
tailscale status

# Example output:
# 100.x.y.z  playras-macbook-pro  playras-macbook-pro.tail01804b.ts.net
```

**Your URL**: `https://<hostname>.tail01804b.ts.net`

### 5.4 Test Remote Access
```bash
# From another device on tailnet:
curl https://playras-macbook-pro-1.tail01804b.ts.net/health

# Expected: 200 OK
```

---

## ✅ Phase 6: Connect MCP Clients (10 min)

### 6.1 BrowserOS MCP Connection
1. Open BrowserOS Agent (usually at `http://localhost:9105`)
2. Go to **Settings → Connected Apps**
3. Add **Trios Bridge** at `http://127.0.0.1:9203/mcp`
4. Verify 17+ tools appear

### 6.2 GitButler Connection
```bash
# In trios-bridge config, ensure:
# - GitButler CLI path: ~/.cargo/bin/but
# - Mode: simple (not internal)
# - No lefthook hooks blocking commits
```

### 6.3 Test Tool Calls
```bash
# From BrowserOS chat, try:
- "List files in ~/trios"
- "Show git status"
- "Create a test commit"
```

---

## ✅ Phase 7: Verify Installation (15 min)

### 7.1 Trios App Tests
- [ ] Status bar icon visible
- [ ] Panel opens on click
- [ ] Keyboard shortcut `Cmd+Shift+T` works
- [ ] Chat tab functional
- [ ] Git tab shows repositories
- [ ] Terminal tab opens
- [ ] Settings tab accessible
- [ ] Right-click menu works (Start/Stop Server, etc.)

### 7.2 Backend Service Tests
```bash
# Health checks
curl http://127.0.0.1:9005/health
curl http://127.0.0.1:9105/health
curl http://127.0.0.1:9203/health

# All should return 200 OK
```

### 7.3 End-to-End Test
1. Open Trios panel (`Cmd+Shift+T`)
2. Type message: "Hello, list files in current directory"
3. Verify SSE streaming response
4. Check tool cards appear below message
5. Verify conversation persists after closing panel

### 7.4 Tailscale Test (if enabled)
- [ ] From another device: `curl https://<your-tailnet-url>/health`
- [ ] Returns 200 OK
- [ ] Can access BrowserOS Agent remotely

---

## ✅ Phase 8: Post-Installation Configuration (10 min)

### 8.1 Auto-Launch on Login
```bash
# Add to Login Items
osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/trios.app", hidden:false}'
```

### 8.2 PM2 Auto-Start on Boot
```bash
# Generate startup script
pm2 startup

# Run the generated command (varies by macOS version)
# Example:
# sudo env PATH="/opt/homebrew/bin:$PATH" PM2_HOME="/Users/youruser/.pm2" /opt/homebrew/lib/node_modules/pm2/bin/pm2 startup systemd -u youruser --hp /Users/youruser

# Save current process list
pm2 save
```

### 8.3 Configure Environment Variables
Add to `~/.zshrc`:
```bash
export TRINITY_ROOT=~/trinity
export TRIOS_ROOT=~/BrowserOS/trios
export TRIOS_MESH_PORT=9505
export TRIOS_MCP_PORT=9105
export TRIOS_A2A_PORT=9200
```

### 8.4 Backup Installation
```bash
# Create backup of working installation
cp -R ~/Applications/trios.app ~/Applications/trios.app.backup
cp -R ~/.pm2 ~/trios-pm2-backup
```

---

## 🚨 Troubleshooting

### Common Issues

#### "App won't launch"
```bash
# Check crash logs
log show --predicate 'process == "trios"' --last 1h

# Kill and restart
pkill -9 trios
open ~/Applications/trios.app
```

#### "Status bar icon missing"
```bash
# Check if already running
pgrep -x trios

# If running, quit and restart
killall trios
open ~/Applications/trios.app
```

#### "Build fails with QueenUILib not found"
```bash
# Verify TRINITY_ROOT is set
echo $TRINITY_ROOT

# Should point to ~/trinity
# If not:
export TRINITY_ROOT=~/trinity
```

#### "PM2 services won't start"
```bash
# Check logs
pm2 logs trios-server --lines 50
pm2 logs browseros-mcp --lines 50
pm2 logs trios-bridge --lines 50

# Common fix: reinstall dependencies
cd ~/trios/browseros-mcp && bun install
cd ~/trios/trios-bridge && bun install
pm2 restart all
```

#### "Tailscale funnel not working"
```bash
# Check funnel status
tailscale status

# Re-authenticate if needed
tailscale logout
tailscale up

# Restart funnel
tailscale funnel 9105
```

#### "GitButler commits fail with lefthook"
```bash
# Add --no-verify to bypass hooks
git commit --no-verify -m "message"

# Or disable lefthook temporarily
lefthook uninstall
```

---

## 📊 Installation Time Estimate

| Phase | Task | Time |
|-------|------|------|
| 1 | Prerequisites | 30 min |
| 2 | Build Trios | 15 min |
| 3 | Install App | 5 min |
| 4 | Backend Services | 20 min |
| 5 | Tailscale | 10 min |
| 6 | MCP Clients | 10 min |
| 7 | Verification | 15 min |
| 8 | Post-Install | 10 min |
| **Total** | | **~2 hours** |

---

## 🎯 Success Criteria

Installation is complete when:
- ✅ Trios app launches and shows status bar icon
- ✅ Panel opens with `Cmd+Shift+T`
- ✅ All 5 tabs functional (Chat, Git, Terminal, Queen, Settings)
- ✅ PM2 shows 3 services online (trios-server, browseros-mcp, trios-bridge)
- ✅ Health checks return 200 OK on ports 9005, 9105, 9203
- ✅ Can send message in chat and get SSE streaming response
- ✅ Tailscale URL accessible from another device (if enabled)
- ✅ GitButler commits work via Trios panel

---

## 📞 Support

- **GitHub**: https://github.com/gHashTag/BrowserOS/issues
- **Discussions**: https://github.com/gHashTag/BrowserOS/discussions
- **Documentation**: `/Users/playra/BrowserOS/trios/docs/`
- **Build Logs**: `~/.trinity/logs/build_*.log`
- **PM2 Logs**: `pm2 logs`

---

**Last Updated**: 2026-05-28  
**Version**: 1.0.0  
**Maintained by**: Trinity Project (@gHashTag)
