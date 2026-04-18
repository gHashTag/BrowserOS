# PENDING — Next Session Blockers

Last updated: 2026-04-18

---

## 🔴 BLOCKER 1: Black Frame (Chromium rebuild required)

**Status:** Patch applied ✅, rebuild pending ⏳

| Method | Applied | Requires rebuild |
|--------|---------|------------------|
| `frameColorHex` in `trios.tokens.json` | ❌ token only, no code binding | — |
| Patch in `chrome_browser_main_extra_parts_mac.mm` | ✅ added | **Yes** |
| CSS / Extension | ❌ frame is not CSS | — |
| `Info.plist` | ❌ no effect on frame | — |

**Result after `./build.sh`:** toolbar + tabstrip become black (Cocoa native).

```bash
# Apply black frame
./build.sh
# Frame color source: frameColorHex in trios.tokens.json
# Patch location: chrome/browser/app/chrome_browser_main_extra_parts_mac.mm
```

---

## 🔴 BLOCKER 2: CDP Version Mismatch

**Status:** `Browser.getTabs()` not found at runtime

**Quick fix (Option B):** Replace with standard `Target.getTargets()`
```typescript
// ❌ Browser.getTabs()  — non-standard
// ✅ Target.getTargets({ filter: [{ type: 'page' }] })
const { targetInfos } = await cdp.Target.getTargets({
  filter: [{ type: 'page' }]
});
```

**Full fix (Option A):** Regen CDP types from live Chromium
```bash
trios-dev watch --manual
curl http://127.0.0.1:9000/json/protocol > /tmp/actual-protocol.json
diff /tmp/actual-protocol.json packages/browseros-agent/apps/server/src/cdp/protocol.json
```

**Affected tools:** `switch_tab`, `close_tab`, `get_windows` and all tab-enumeration tools.

---

## 🟡 PENDING: Rename BrowserOS.app → TRIOS.app

Requires full Chromium rebuild (`./build.sh`).
Can be done in the same build pass as the black frame patch.

---

## 🟢 READY: 66 Tools Verification

Blocked by CDP mismatch (BLOCKER 2). Fix CDP first, then run:
```bash
bun test apps/server/tests/tools/navigation.test.ts
bun test apps/server/tests/tools/observation.test.ts
```
Full checklist: `docs/testing/tools-verification-checklist.md`

---

## Session summary (2026-04-18)

- ✅ `trios-dev` Rust binary — builds, launches browser, watch mode
- ✅ Tailwind 4.x color utilities working
- ✅ CSS variables kebab-case, no undefined
- ✅ Layout — no ghost borders (`* { @apply border-border }` removed)
- ✅ BrowserOS → TRIOS rename (6 packages typecheck clean)
- ✅ Server HTTP fix (Bun.serve + Hono app instance)
- ✅ 66 tools checklist in `docs/testing/`
- ⬜ Black frame — patch ready, needs `./build.sh`
- ⬜ CDP mismatch — `Browser.getTabs()` → `Target.getTargets()`
- ⬜ Rename `BrowserOS.app` → `TRIOS.app` (same build)
