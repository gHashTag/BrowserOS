# 🚀 TRIOS — MASTER INSTALLATION GUIDE

**Complete guide for installing trios on another computer**  
**Author**: Dmitrii Vasilev (@gHashTag)  
**Version**: 1.0.0 | **Date**: 2026-05-28  
**Total Time**: ~2 hours

---

## 📋 Quick Start Checklist

```bash
# 1. Clone & Setup (5 min)
git clone https://github.com/gHashTag/BrowserOS.git
cd BrowserOS/trios
git clone https://github.com/gHashTag/trinity.git ~/trinity
export TRINITY_ROOT=~/trinity
export TRIOS_ROOT=$(pwd)

# 2. Install Dependencies (15 min)
brew install tailscale git node@20
curl -fsSL https://bun.sh/install | bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
cargo install but
npm install -g pm2

# 3. Build (10 min)
chmod +x build.sh
./build.sh

# 4. Install App (2 min)
mkdir -p ~/Applications
cp -R ./trios.app ~/Applications/
open ~/Applications/trios.app

# 5. Start Backend Services (10 min)
cd ~/trios  # or your trios directory
pm2 start ecosystem.config.cjs
pm2 save

# 6. Configure Tailscale (Optional, 5 min)
tailscale up
tailscale funnel 9105

# 7. Verify (5 min)
curl http://127.0.0.1:9005/health
curl http://127.0.0.1:9105/health
curl http://127.0.0.1:9203/health
```

---

## 📦 Phase 1: Prerequisites (30 min)

### 1.1 System Requirements
- ✅ macOS 14.0+ (Sonoma or later)
- ✅ Xcode 15.0+ from App Store
- ✅ Command Line Tools: `xcode-select --install`
- ✅ Swift 5.9+: `swift --version`
- ✅ Homebrew installed

### 1.2 Install Dependencies
```bash
# Tailscale for remote access
brew install tailscale

# Git (if not present)
brew install git

# Verify
tailscale --version
git --version
swift --version
```

### 1.3 Clone Repositories
```bash
# Main repo
git clone https://github.com/gHashTag/BrowserOS.git
cd BrowserOS/trios

# Trinity dependency (required for QueenUILib)
git clone https://github.com/gHashTag/trinity.git ~/trinity
export TRINITY_ROOT=~/trinity
```

---

## 🔨 Phase 2: Build Trios (15 min)

### 2.1 Set Environment
```bash
cd /path/to/BrowserOS/trios
export TRIOS_ROOT=$(pwd)
export TRINITY_ROOT=~/trinity
```

### 2.2 Build Application
```bash
chmod +x build.sh
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
# Check binary exists (~13MB)
ls -lh trios_app

# Check .app bundle
ls -lh trios.app/Contents/MacOS/trios
ls -lh trios.app/Contents/Frameworks/libQueenUILib.dylib
ls -lh trios.app/Contents/Info.plist
```

---

## 📲 Phase 3: Install Application (5 min)

### 3.1 Copy to Applications
```bash
mkdir -p ~/Applications
cp -R ./trios.app ~/Applications/
ls -lh ~/Applications/trios.app
```

### 3.2 First Launch
```bash
open ~/Applications/trios.app
```

### 3.3 Grant Permissions
**System Settings → Privacy & Security:**
- [ ] **Accessibility**: Enable for window shifting
- [ ] **Screen Recording** (if using screen capture)
- [ ] **Automation** (if controlling other apps)

**First launch checklist:**
- [ ] Status bar icon appears (top-right)
- [ ] Click icon → panel slides in
- [ ] `Cmd+Shift+T` toggles panel
- [ ] No crash logs in Console.app

---

## ⚙️ Phase 4: Configure Backend Services (20 min)

### 4.1 Install Node.js & Bun
```bash
brew install node@20
curl -fsSL https://bun.sh/install | bash

# Verify
node --version
bun --version
```

### 4.2 Install Rust
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# Verify
rustc --version
cargo --version
```

### 4.3 Install GitButler CLI
```bash
cargo install but
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
```

**Expected:**
```
┌────┬────────────────────┬──────────┬──────┬───────────┬──────────┬──────────┐
│ id │ name               │ mode     │ ↺    │ status    │ cpu      │ memory   │
├────┼────────────────────┼──────────┼──────┼───────────┼──────────┼──────────┤
│ 0  │ trios-server       │ fork     │ 0    │ online    │ 0%       │ 45.2mb   │
│ 1  │ browseros-mcp      │ fork     │ 0    │ online    │ 0%       │ 32.1mb   │
│ 2  │ trios-bridge       │ fork     │ 0    │ online    │ 0%       │ 28.7mb   │
└────┴────────────────────┴──────────┴──────┴───────────┴──────────┴──────────┘
```

### 4.6 Verify Service Ports
```bash
lsof -i :9005  # trios-server
lsof -i :9105  # browseros-mcp
lsof -i :9203  # trios-bridge
```

---

## 🌐 Phase 5: Configure Tailscale (Optional, 10 min)

### 5.1 Install & Authenticate
```bash
# Already installed via brew
tailscale up
# Opens browser for OAuth login
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
tailscale status
# Example: 100.x.y.z  playras-macbook-pro  playras-macbook-pro.tail01804b.ts.net
```

**Your URL**: `https://<hostname>.tail01804b.ts.net`

### 5.4 Test Remote Access
```bash
# From another device on tailnet:
curl https://playras-macbook-pro-1.tail01804b.ts.net/health
# Expected: 200 OK
```

---

## 🔌 Phase 6: Connect MCP Clients (10 min)

### 6.1 BrowserOS MCP Connection
1. Open BrowserOS Agent (usually at `http://localhost:9105`)
2. Go to **Settings → Connected Apps**
3. Add **Trios Bridge** at `http://127.0.0.1:9203/mcp`
4. Verify 17+ tools appear

### 6.2 GitButler Connection
```bash
# In trios-bridge config:
# - GitButler CLI path: ~/.cargo/bin/but
# - Mode: simple (not internal)
# - No lefthook hooks blocking commits
```

### 6.3 Test Tool Calls
From BrowserOS chat, try:
- "List files in ~/trios"
- "Show git status"
- "Create a test commit"

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
- [ ] Right-click menu works

### 7.2 Backend Service Tests
```bash
curl http://127.0.0.1:9005/health
curl http://127.0.0.1:9105/health
curl http://127.0.0.1:9203/health
# All should return 200 OK
```

### 7.3 End-to-End Test
1. Open Trios panel (`Cmd+Shift+T`)
2. Type: "Hello, list files in current directory"
3. Verify SSE streaming response
4. Check tool cards appear
5. Verify conversation persists after closing

### 7.4 Tailscale Test (if enabled)
- [ ] From another device: `curl https://<your-tailnet-url>/health`
- [ ] Returns 200 OK
- [ ] Can access BrowserOS Agent remotely

---

## 🔧 Phase 8: Post-Installation (10 min)

### 8.1 Auto-Launch on Login
```bash
osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/trios.app", hidden:false}'
```

### 8.2 PM2 Auto-Start on Boot
```bash
pm2 startup
# Run the generated command
pm2 save
```

### 8.3 Environment Variables (~/.zshrc)
```bash
export TRINITY_ROOT=~/trinity
export TRIOS_ROOT=~/BrowserOS/trios
export TRIOS_MESH_PORT=9505
export TRIOS_MCP_PORT=9105
export TRIOS_A2A_PORT=9200
```

### 8.4 Backup Installation
```bash
cp -R ~/Applications/trios.app ~/Applications/trios.app.backup
cp -R ~/.pm2 ~/trios-pm2-backup
```

---

## 🎯 Success Criteria

Installation complete when:
- ✅ Trios app launches and shows status bar icon
- ✅ Panel opens with `Cmd+Shift+T`
- ✅ All 5 tabs functional (Chat, Git, Terminal, Queen, Settings)
- ✅ PM2 shows 3 services online
- ✅ Health checks return 200 OK on ports 9005, 9105, 9203
- ✅ Can send message and get SSE streaming response
- ✅ Tailscale URL accessible from another device
- ✅ GitButler commits work via Trios panel

---

## 🚨 Troubleshooting

### App won't launch
```bash
log show --predicate 'process == "trios"' --last 1h
pkill -9 trios
open ~/Applications/trios.app
```

### Status bar icon missing
```bash
pgrep -x trios
killall trios
open ~/Applications/trios.app
```

### Build fails with QueenUILib not found
```bash
echo $TRINITY_ROOT  # Should be ~/trinity
export TRINITY_ROOT=~/trinity
```

### PM2 services won't start
```bash
pm2 logs trios-server --lines 50
cd ~/trios/browseros-mcp && bun install
pm2 restart all
```

### Tailscale funnel not working
```bash
tailscale status
tailscale logout
tailscale up
tailscale funnel 9105
```

### GitButler commits fail with lefthook
```bash
git commit --no-verify -m "message"
# Or disable lefthook temporarily
lefthook uninstall
```

---

## 📊 Time Estimate

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

## 📞 Support

- **GitHub Issues**: https://github.com/gHashTag/BrowserOS/issues
- **Discussions**: https://github.com/gHashTag/BrowserOS/discussions
- **Documentation**: `/Users/playra/BrowserOS/trios/docs/`
- **Build Logs**: `~/.trinity/logs/build_*.log`
- **PM2 Logs**: `pm2 logs`

---

## 📁 Available Formats

This guide is available in multiple formats:

1. **Markdown** (this file): `TRIOS_MASTER_INSTALLATION_GUIDE.md`
2. **HTML**: `INSTALLATION_GUIDE.html` (interactive with checkboxes)
3. **PDF**: `TRIOS_INSTALLATION_GUIDE.pdf` (printable)
4. **TODO List**: `INSTALL_TODO.md` (checklist format)

---

**Last Updated**: 2026-05-28  
**Version**: 1.0.0  
**Maintained by**: Trinity Project (@gHashTag)
