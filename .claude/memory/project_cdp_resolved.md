---
name: cdp_resolved
description: CDP backend issues resolved (April 2026)
type: project
---

CDP рекурсия и Target.getTargets исправлены и запушены на origin/dev.

**Коммиты на remote:**
- f884045c: fix(cdp): resolve infinite recursion in CDP backend constructor
- 40892e9f: docs(testing): add CDP version mismatch blocker + fix plan
- ccb7704c: fix(browser.ts): replace Browser.getTabs with Target.getTargets for CDP compatibility

**P0 статус:**
- ✅ Navigation (навигация) — зелёные smoke tests
- ✅ Observation (наблюдение) — зелёные smoke tests

**Неподтверждённый P0:**
- ⚠️ MCP `/mcp` endpoint — нужно smoke-тест через JSON-RPC

**Рабочая директория (не запушено):**
- modified: packages/browseros-agent/apps/server/src/browser/browser.ts
- untracked: packages/browseros-agent/apps/server/src/browser/browser_list_pages.ts

**Приоритеты на следующую сессию:**
1. Добить tab-groups/save_pdf
2. MCP /mcp и P0 smoke через JSON-RPC

**How to apply:** При продолжении работы сначала решить с локальными изменениями (experimental vs next step), затем выбрать приоритет из списка выше.
