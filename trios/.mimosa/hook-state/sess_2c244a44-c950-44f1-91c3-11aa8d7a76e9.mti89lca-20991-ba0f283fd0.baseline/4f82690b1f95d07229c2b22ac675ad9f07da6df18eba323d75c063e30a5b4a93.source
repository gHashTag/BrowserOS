# 📖 TRIOS Documentation

**Complete documentation for installing and understanding trios**

---

## 🚀 Quick Start

**New to trios? Start here:**

1. **Fast Installation** → [`QUICK_START.md`](../QUICK_START.md)
2. **Complete Guide** → [`TRIOS_MASTER_INSTALLATION_GUIDE.md`](../TRIOS_MASTER_INSTALLATION_GUIDE.md)
3. **Interactive Guide** → [`INSTALLATION_GUIDE.html`](../INSTALLATION_GUIDE.html) (open in browser)
4. **Architecture** → [`ARCHITECTURE_OVERVIEW.md`](../ARCHITECTURE_OVERVIEW.md)

**All documentation index**: [`INSTALLATION_INDEX.md`](../INSTALLATION_INDEX.md)

---

## 📚 Available Documents

### Installation Guides

| Document | Format | Time | Best For |
|----------|--------|------|----------|
| [QUICK_START.md](../QUICK_START.md) | Markdown | 30-45 min | Fast installation |
| [TRIOS_MASTER_INSTALLATION_GUIDE.md](../TRIOS_MASTER_INSTALLATION_GUIDE.md) | Markdown | ~2 hours | Complete reference |
| [INSTALLATION_GUIDE.html](../INSTALLATION_GUIDE.html) | HTML | ~2 hours | Interactive tracking |
| [INSTALL_TODO.md](../INSTALL_TODO.md) | Markdown | ~2 hours | Checklist format |
| [TRIOS_INSTALLATION_GUIDE.pdf](../TRIOS_INSTALLATION_GUIDE.pdf) | PDF | ~2 hours | Printable |

### Architecture & Understanding

| Document | Format | Time | Purpose |
|----------|--------|------|---------|
| [ARCHITECTURE_OVERVIEW.md](../ARCHITECTURE_OVERVIEW.md) | Markdown | 30 min | System design |
| [INSTALLATION_INDEX.md](../INSTALLATION_INDEX.md) | Markdown | 10 min | Document navigation |

---

## 🎯 Installation Paths

### ⚡ Fast Track (30-45 min)
```bash
# 1. Read quick start
cat QUICK_START.md | less

# 2. Run installation script (copy-paste from guide)
# 3. Verify installation
```

### 📖 Standard Track (~2 hours) ⭐ RECOMMENDED
```bash
# 1. Open interactive guide in browser
open INSTALLATION_GUIDE.html

# 2. Follow each phase, clicking checkboxes
# 3. Complete all 8 phases
```

### 🏗️ Deep Dive (~3 hours)
```bash
# 1. Read architecture first
cat ARCHITECTURE_OVERVIEW.md | less

# 2. Follow master guide
cat TRIOS_MASTER_INSTALLATION_GUIDE.md | less

# 3. Study each phase carefully
```

---

## 📋 Installation Phases

All guides follow the same 8-phase structure:

1. **Prerequisites** (30 min) — Xcode, Homebrew, clone repos
2. **Build Trios** (15 min) — Set env, run build.sh
3. **Install App** (5 min) — Copy to Applications, permissions
4. **Backend Services** (20 min) — Node.js, Rust, PM2
5. **Tailscale** (10 min, optional) — Remote access
6. **MCP Clients** (10 min) — Connect BrowserOS, GitButler
7. **Verification** (15 min) — Test everything
8. **Post-Installation** (10 min) — Auto-start, env vars

**Total**: ~2 hours

---

## ✅ Success Criteria

Installation complete when:
- ✅ Trios app launches with status bar icon
- ✅ Panel opens with `Cmd+Shift+T`
- ✅ All 5 tabs functional
- ✅ PM2 shows 3 services online
- ✅ Health checks return 200 OK
- ✅ SSE streaming works
- ✅ Tailscale accessible (if enabled)
- ✅ GitButler commits work

---

## 🛠️ Troubleshooting

### Quick Fixes
```bash
# App won't launch
pkill -9 trios && open ~/Applications/trios.app

# No status bar icon
killall trios && open ~/Applications/trios.app

# PM2 services down
pm2 logs && pm2 restart all

# Tailscale issues
tailscale logout && tailscale up && tailscale funnel 9105
```

### Detailed Troubleshooting
See [`TRIOS_MASTER_INSTALLATION_GUIDE.md`](../TRIOS_MASTER_INSTALLATION_GUIDE.md) → Troubleshooting section

### Logs
```bash
# App logs
log show --predicate 'process == "trios"' --last 1h

# PM2 logs
pm2 logs trios-server --lines 50
pm2 logs browseros-mcp --lines 50
pm2 logs trios-bridge --lines 50
```

---

## 🌐 Tailscale Setup

### Enable Remote Access
```bash
# Install
brew install tailscale

# Authenticate
tailscale up

# Enable public access (funnel)
tailscale funnel 9105

# Or tailnet-only (private)
tailscale serve --https=443 http://127.0.0.1:9105

# Get your URL
tailscale status

# Test from another device
curl https://<your-hostname>.tail01804b.ts.net/health
```

---

## 📁 File Structure

```
trios/docs/
├── INSTALLATION_README.md (this file)
└── [other documentation...]

trios/
├── QUICK_START.md
├── TRIOS_MASTER_INSTALLATION_GUIDE.md
├── INSTALLATION_GUIDE.html
├── INSTALL_TODO.md
├── ARCHITECTURE_OVERVIEW.md
├── INSTALLATION_INDEX.md
├── TRIOS_INSTALLATION_GUIDE.pdf
├── README.md
├── build.sh
├── main.swift
└── [source code...]
```

---

## 📞 Support

### Documentation
- Installation Index: `INSTALLATION_INDEX.md`
- Quick Start: `QUICK_START.md`
- Master Guide: `TRIOS_MASTER_INSTALLATION_GUIDE.md`
- Architecture: `ARCHITECTURE_OVERVIEW.md`

### Online
- **GitHub Issues**: https://github.com/gHashTag/BrowserOS/issues
- **Discussions**: https://github.com/gHashTag/BrowserOS/discussions
- **Trinity Project**: https://github.com/gHashTag/trinity

### Local Logs
- Build Logs: `~/.trinity/logs/build_*.log`
- PM2 Logs: `pm2 logs`
- Console.app: Search "trios" or "browseros"

---

## 🎓 Learning Path

### Week 1: Installation
- Day 1-2: Install trios (follow guide)
- Day 3: Explore UI, test features
- Day 4-5: Configure backend services
- Day 6-7: Set up Tailscale, test remote access

### Week 2: Understanding
- Day 1-2: Read `ARCHITECTURE_OVERVIEW.md`
- Day 3-4: Study source code
- Day 5-7: Experiment with configurations

### Week 3: Contribution
- Review open issues
- Submit PRs
- Improve documentation

---

## 📊 Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-05-28 | Initial documentation set |

---

## 🎯 Next Steps

**After installation:**

1. **Explore the app**
   - Open panel: `Cmd+Shift+T`
   - Try each tab (Chat, Git, Terminal, Queen, Settings)
   - Send a message in chat

2. **Configure your workflow**
   - Add to login items
   - Configure PM2 auto-start
   - Set up environment variables

3. **Connect services**
   - BrowserOS MCP
   - GitButler
   - Tailscale (optional)

4. **Learn the architecture**
   - Read `ARCHITECTURE_OVERVIEW.md`
   - Study source code
   - Understand data flow

5. **Contribute** (optional)
   - Report issues
   - Suggest features
   - Submit PRs

---

**Documentation v1.0.0** | 2026-05-28 | Trinity Project (@gHashTag)

**Start here**: [`INSTALLATION_INDEX.md`](../INSTALLATION_INDEX.md)
