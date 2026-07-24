# ⚡ TRIOS Quick Start Guide

**One-page cheat sheet for fast installation**  
**Time**: 30-45 minutes | **Version**: 1.0.0

---

## 🚀 Copy-Paste Installation Script

```bash
#!/bin/bash
# TRIOS Quick Install — Copy this entire block!

# 1. Clone repositories
git clone https://github.com/gHashTag/BrowserOS.git
cd BrowserOS/trios
git clone https://github.com/gHashTag/trinity.git ~/trinity

# 2. Set environment
export TRINITY_ROOT=~/trinity
export TRIOS_ROOT=$(pwd)

# 3. Install dependencies
brew install tailscale git node@20
curl -fsSL https://bun.sh/install | bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
cargo install but
npm install -g pm2

# 4. Build trios
chmod +x build.sh
./build.sh

# 5. Install app
mkdir -p ~/Applications
cp -R ./trios.app ~/Applications/

# 6. Start backend services and app
cd ~/BrowserOS/trios
./trios

# 7. Configure Tailscale (optional)
tailscale up
tailscale funnel 9105

echo "✅ Installation complete!"
echo "📱 Launch: cd ~/BrowserOS/trios && ./trios"
echo "⌨️ Shortcut: Cmd+Shift+T"
echo "🌐 Tailscale URL: $(tailscale status | grep $(scutil --get ComputerName) | awk '{print $3}')"
```

---

## ✅ Verification Commands

```bash
# Check all services running
pm2 status

# Health checks
curl http://127.0.0.1:9005/health  # trios-server
curl http://127.0.0.1:9105/health  # browseros-mcp
curl http://127.0.0.1:9203/health  # trios-bridge

# Check ports
lsof -i :9005
lsof -i :9105
lsof -i :9203

# Tailscale status
tailscale status
```

---

## 🔧 Common Issues & Fixes

| Problem | Solution |
|---------|----------|
| App won't launch | `pkill -9 trios && open ~/Applications/trios.app` |
| No status bar icon | `killall trios && open ~/Applications/trios.app` |
| QueenUILib not found | `export TRINITY_ROOT=~/trinity` |
| PM2 services down | `pm2 logs && pm2 restart all` |
| Tailscale not working | `tailscale logout && tailscale up` |
| Build fails | Check Xcode: `xcode-select --install` |

---

## 📋 Environment Variables

Add to `~/.zshrc`:

```bash
export TRINITY_ROOT=~/trinity
export TRIOS_ROOT=~/BrowserOS/trios
export TRIOS_PORT_SOVEREIGN=9105
export TRIOS_MESH_PORT=9505
export TRIOS_MCP_PORT=9105
export TRIOS_A2A_PORT=9200
```

Then: `source ~/.zshrc`

---

## 🎯 Success Checklist

Quick verification (5 min):

- [ ] `cd ~/BrowserOS/trios && ./trios` → app launches and backend starts
- [ ] Status bar icon visible (top-right)
- [ ] `Cmd+Shift+T` → panel opens
- [ ] Chat tab → type "hello" → get response
- [ ] `pm2 status` → 3 services online
- [ ] All 3 health checks return 200 OK
- [ ] Tailscale URL works from another device

---

## 📞 Need Help?

**Full Guide**: `TRIOS_MASTER_INSTALLATION_GUIDE.md`  
**HTML Version**: `INSTALLATION_GUIDE.html` (interactive)  
**PDF Version**: `TRIOS_INSTALLATION_GUIDE.pdf`  
**GitHub**: https://github.com/gHashTag/BrowserOS-full/issues

---

**Quick Start v1.0.0** | 2026-05-28 | Trinity Project (@gHashTag)
