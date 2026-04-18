# 66 Unified Tools — Verification Checklist

Requires: `trios-dev watch --manual` (CDP on 127.0.0.1:9000, HTTP on 9105)

---

## ✅ SMOKE TEST PASSED — 2026-04-18

| Test | Endpoint | Result |
|------|----------|--------|
| Health | `GET /health` | `{"status":"ok","cdpConnected":true}` ✅ |
| Navigate | `POST /sdk/nav {"url":"https://example.com"}` | `{"success":true,"tabId":36347442}` ✅ |

**66 tools loaded. CDP connected on port 9000.**

### ⚠️ API structure note

Tools are NOT exposed as individual REST endpoints.
All 66 tools are accessible through:

| Endpoint | Purpose |
|----------|---------|
| `POST /api/chat` | All tools via chat/stream interface |
| `POST /sdk/nav` | Navigation shortcut |
| `POST /sdk/act` | Actions (click, type, screenshot, etc.) |
| `POST /sdk/extract` | Data extraction from page |
| `POST /sdk/verify` | Assertions / verification |

Screenshots: via `/sdk/act` with action schema, not `/tools/screenshot`.

---

## ⚠️ BLOCKER: CDP Version Mismatch (partial)

**Status:** `Browser.getTabs()` — not found at runtime for some tools

**Quick fix (Option B — recommended):**
```typescript
// ❌ Browser.getTabs()
// ✅ Target.getTargets({ filter: [{ type: 'page' }] })
const { targetInfos } = await cdp.Target.getTargets({
  filter: [{ type: 'page' }]
});
```

---

## 🔴 P0 — Navigation (8)
- [x] `navigate` — ✅ tested via `/sdk/nav`
- [ ] `go_back`
- [ ] `go_forward`
- [ ] `reload`
- [ ] `new_tab`
- [ ] `close_tab`
- [ ] `switch_tab`
- [ ] `open_url`

## 🔴 P0 — Observation (9)
- [ ] `screenshot` — via `/sdk/act`
- [ ] `get_dom`
- [ ] `find_element`
- [ ] `get_page_info`
- [ ] `get_element_text`
- [ ] `get_element_attrs`
- [ ] `is_element_visible`
- [ ] `wait_for_element`
- [ ] `get_scroll_position`

## 🟠 P1 — Input (17)
- [ ] `click` / `click_coordinates` — via `/sdk/act`
- [ ] `type` / `type_into` / `clear_input`
- [ ] `press_key` / `key_combination`
- [ ] `scroll` / `scroll_to_element` / `scroll_to_top` / `scroll_to_bottom`
- [ ] `hover` / `drag_and_drop`
- [ ] `select_option` / `check_checkbox`
- [ ] `upload_file` / `focus_element`

## 🟠 P1 — Page Actions (3)
- [ ] `execute_script`
- [ ] `get_cookies` / `set_cookie`

## 🟡 P2 — Windows (5) + Tab Groups (5)
- [ ] get/new/close/switch/maximize_window
- [ ] get/create/update/move/ungroup tab_group

## 🟢 P3 — Bookmarks (6) + History (4) + Info (1) + Nudges (2) + Git (6)
- [ ] all auxiliary tools

---

## How to test remaining tools

```bash
# Act (screenshot, click, type, scroll...)
curl http://localhost:9105/sdk/act \
  -H 'Content-Type: application/json' \
  -d '{"action":"screenshot"}'

# Extract (get_dom, find_element, get_page_info...)
curl http://localhost:9105/sdk/extract \
  -H 'Content-Type: application/json' \
  -d '{"goal":"get page title"}'

# Verify
curl http://localhost:9105/sdk/verify \
  -H 'Content-Type: application/json' \
  -d '{"assertion":"page is loaded"}'
```
