# 📚 TRIOS Installation — Complete Documentation Set

**Master index for all installation and architecture documents**  
**Created**: 2026-05-28 | **Version**: 1.0.0  
**Author**: Dmitrii Vasilev (@gHashTag)

---

## 🎯 Quick Navigation

| Document | Purpose | Format | Time |
|----------|---------|--------|------|
| **[QUICK_START.md](#quick-start)** | One-page cheat sheet | Markdown | 30-45 min |
| **[TRIOS_MASTER_INSTALLATION_GUIDE.md](#master-guide)** | Complete step-by-step guide | Markdown | ~2 hours |
| **[INSTALLATION_GUIDE.html](#html-guide)** | Interactive guide with checkboxes | HTML | ~2 hours |
| **[INSTALL_TODO.md](#todo-list)** | Checklist format | Markdown | ~2 hours |
| **[ARCHITECTURE_OVERVIEW.md](#architecture)** | System architecture | Markdown | 30 min read |
| **[TRIOS_INSTALLATION_GUIDE.pdf](#pdf)** | Printable PDF | PDF | ~2 hours |

---

## 📖 Document Descriptions

### QUICK_START.md
**Best for**: Experienced developers who want fast installation  
**Content**:
- Copy-paste installation script
- Quick verification commands
- Common issues table
- Environment variables
- 5-minute success checklist

**Use this if**: You've installed similar tools before and want to move fast.

📁 **Location**: `/Users/playra/BrowserOS/trios/QUICK_START.md`

---

### TRIOS_MASTER_INSTALLATION_GUIDE.md ⭐ RECOMMENDED
**Best for**: First-time installation, complete reference  
**Content**:
- 8 phases with detailed steps
- Expected outputs and screenshots
- Troubleshooting for each phase
- Time estimates per phase
- Success criteria
- Support links

**Use this if**: This is your first time installing trios, or you want a complete reference.

📁 **Location**: `/Users/playra/BrowserOS/trios/TRIOS_MASTER_INSTALLATION_GUIDE.md`

---

### INSTALLATION_GUIDE.html
**Best for**: Interactive installation with clickable checkboxes  
**Content**:
- Same as master guide
- Interactive checkboxes (click to mark complete)
- Beautiful visual design
- Progress tracking
- Print-friendly

**Use this if**: You want to track progress visually and check off items as you go.

📁 **Location**: `/Users/playra/BrowserOS/trios/INSTALLATION_GUIDE.html`  
🌐 **Open in browser**: `open /Users/playra/BrowserOS/trios/INSTALLATION_GUIDE.html`

---

### INSTALL_TODO.md
**Best for**: Simple checklist format  
**Content**:
- 8 phases with checkbox items
- Commands and code blocks
- Expected outputs
- Troubleshooting section

**Use this if**: You prefer simple markdown checklists.

📁 **Location**: `/Users/playra/BrowserOS/trios/INSTALL_TODO.md`

---

### ARCHITECTURE_OVERVIEW.md
**Best for**: Understanding how trios works internally  
**Content**:
- Layer architecture (Core → Infrastructure → Application → Presentation)
- File structure with descriptions
- Data flow diagrams
- Backend services architecture
- Network ports table
- Key design patterns
- Performance metrics

**Use this if**: You want to understand the system before installing, or you're contributing to the project.

📁 **Location**: `/Users/playra/BrowserOS/trios/ARCHITECTURE_OVERVIEW.md`

---

### TRIOS_INSTALLATION_GUIDE.pdf
**Best for**: Offline reading, printing, sharing  
**Content**:
- Same as HTML guide
- Formatted for print
- No interactive elements
- Portable document

**Use this if**: You want to print the guide or read it offline.

📁 **Location**: `/Users/playra/BrowserOS/trios/TRIOS_INSTALLATION_GUIDE.pdf`

---

## 🚀 Installation Paths

### Path 1: Fast Track (30-45 min)
1. Read `QUICK_START.md`
2. Run copy-paste script
3. Verify with checklist
4. Skim `ARCHITECTURE_OVERVIEW.md` for understanding

**Best for**: Experienced macOS developers

---

### Path 2: Standard Track (~2 hours) ⭐ RECOMMENDED
1. Open `INSTALLATION_GUIDE.html` in browser
2. Follow each phase, clicking checkboxes
3. Complete all 8 phases
4. Verify with success criteria
5. Read `ARCHITECTURE_OVERVIEW.md` for deeper understanding

**Best for**: Most users, first-time installation

---

### Path 3: Deep Dive (~3 hours)
1. Read `ARCHITECTURE_OVERVIEW.md` first
2. Follow `TRIOS_MASTER_INSTALLATION_GUIDE.md`
3. Study each phase carefully
4. Review troubleshooting proactively
5. Understand backend services before starting

**Best for**: Contributors, system architects, learners

---

## 📋 Installation Phases Overview

All guides follow the same 8-phase structure:

| Phase | Name | Time | Key Tasks |
|-------|------|------|-----------|
| 1 | Prerequisites | 30 min | Xcode, Homebrew, clone repos |
| 2 | Build Trios | 15 min | Set env, run build.sh |
| 3 | Install App | 5 min | Copy to Applications, permissions |
| 4 | Backend Services | 20 min | Node.js, Rust, PM2, start services |
| 5 | Tailscale (Optional) | 10 min | Authenticate, enable funnel |
| 6 | MCP Clients | 10 min | Connect BrowserOS, GitButler |
| 7 | Verification | 15 min | Test app, services, end-to-end |
| 8 | Post-Installation | 10 min | Auto-launch, PM2 startup, env vars |

**Total**: ~2 hours (including optional Tailscale)

---

## ✅ Success Criteria (All Guides)

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

## 🛠️ Troubleshooting Resources

### Quick Fixes
See `QUICK_START.md` → "Common Issues & Fixes" table

### Detailed Troubleshooting
See `TRIOS_MASTER_INSTALLATION_GUIDE.md` → Phase 8: Troubleshooting

### Interactive Troubleshooting
See `INSTALLATION_GUIDE.html` → Troubleshooting section

### Logs & Debugging
```bash
# App crash logs
log show --predicate 'process == "trios"' --last 1h

# PM2 logs
pm2 logs trios-server --lines 50
pm2 logs browseros-mcp --lines 50
pm2 logs trios-bridge --lines 50

# Console.app
# Search for "trios" or "browseros"
```

---

## 🌐 Tailscale Configuration

### For Remote Access
1. Install: `brew install tailscale`
2. Authenticate: `tailscale up`
3. Enable Funnel: `tailscale funnel 9105`
4. Get URL: `tailscale status`
5. Test: `curl https://<your-url>/health`

### For Local-Only (Tailnet)
1. Install: `brew install tailscale`
2. Authenticate: `tailscale up`
3. Enable Serve: `tailscale serve --https=443 http://127.0.0.1:9105`
4. Share URL with devices on your tailnet

**Note**: Funnel = public internet, Serve = tailnet only (private)

---

## 📞 Support & Community

### Documentation
- This index: `INSTALLATION_INDEX.md`
- Master guide: `TRIOS_MASTER_INSTALLATION_GUIDE.md`
- Architecture: `ARCHITECTURE_OVERVIEW.md`
- Quick start: `QUICK_START.md`

### Online Resources
- **GitHub Issues**: https://github.com/gHashTag/BrowserOS/issues
- **Discussions**: https://github.com/gHashTag/BrowserOS/discussions
- **Trinity Project**: https://github.com/gHashTag/trinity
- **Documentation Folder**: `/Users/playra/BrowserOS/trios/docs/`

### Logs
- **Build Logs**: `~/.trinity/logs/build_*.log`
- **PM2 Logs**: `pm2 logs`
- **Console.app**: Search "trios" or "browseros"

---

## 📊 Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-05-28 | Initial release, complete documentation set |

---

## 🎯 Recommended Reading Order

### For First-Time Installers
1. `INSTALLATION_INDEX.md` (this file) — 5 min
2. `ARCHITECTURE_OVERVIEW.md` — 30 min (optional but recommended)
3. `INSTALLATION_GUIDE.html` — follow interactively (~2 hours)
4. `QUICK_START.md` — keep handy for quick reference

### For Experienced Developers
1. `QUICK_START.md` — 5 min
2. Run installation script
3. `TRIOS_MASTER_INSTALLATION_GUIDE.md` — reference for issues
4. `ARCHITECTURE_OVERVIEW.md` — for understanding

### For Contributors
1. `ARCHITECTURE_OVERVIEW.md` — 30 min
2. `TRIOS_MASTER_INSTALLATION_GUIDE.md` — complete guide
3. Read source code in `/Users/playra/BrowserOS/trios/`
4. Review `/Users/playra/BrowserOS/trios/docs/`

---

## 📁 File Locations

All documentation is located in:
```
/Users/playra/BrowserOS/trios/
├── INSTALLATION_INDEX.md (this file)
├── QUICK_START.md
├── TRIOS_MASTER_INSTALLATION_GUIDE.md
├── INSTALLATION_GUIDE.html
├── INSTALL_TODO.md
├── ARCHITECTURE_OVERVIEW.md
├── TRIOS_INSTALLATION_GUIDE.pdf
├── README.md
├── CONTRIBUTING.md
├── AGENTS.md
├── CLAUDE.md
└── docs/
```

---

## 🚀 Quick Start Commands

```bash
# Open HTML guide in browser
open /Users/playra/BrowserOS/trios/INSTALLATION_GUIDE.html

# Open master guide in terminal
cat /Users/playra/BrowserOS/trios/TRIOS_MASTER_INSTALLATION_GUIDE.md | less

# Open quick start
cat /Users/playra/BrowserOS/trios/QUICK_START.md | less

# View architecture
cat /Users/playra/BrowserOS/trios/ARCHITECTURE_OVERVIEW.md | less
```

---

## 🎓 Learning Resources

### Swift & SwiftUI
- Apple Developer Documentation
- Hacking with Swift
- Swift by Sundell

### Rust
- The Rust Programming Language (book)
- Rust by Example

### Node.js & PM2
- Node.js Documentation
- PM2 Documentation

### Tailscale
- Tailscale Documentation
- Tailscale Funnel Guide

---

## 📝 Checklist for New Computers

Print this checklist for each new machine:

**Before Starting:**
- [ ] macOS 14.0+ installed
- [ ] Xcode 15.0+ installed
- [ ] GitHub account accessible
- [ ] Tailscale account (optional)

**After Installation:**
- [ ] All 8 phases complete
- [ ] All success criteria met
- [ ] PM2 services configured for auto-start
- [ ] Trios app in login items
- [ ] Tailscale configured (if needed)
- [ ] Backup created

---

**Installation Index v1.0.0** | 2026-05-28 | Trinity Project (@gHashTag)

**Questions?** Open an issue: https://github.com/gHashTag/BrowserOS/issues
