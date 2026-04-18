# 66 Unified Tools — Verification Checklist

Requires: `trios-dev watch --manual` (CDP on 127.0.0.1:9000)

## 🔴 P0 — Navigation (8)
- [ ] navigate
- [ ] go_back
- [ ] go_forward
- [ ] reload
- [ ] new_tab
- [ ] close_tab
- [ ] switch_tab
- [ ] open_url

## 🔴 P0 — Observation (9)
- [ ] screenshot
- [ ] get_dom
- [ ] find_element
- [ ] get_page_info
- [ ] get_element_text
- [ ] get_element_attrs
- [ ] is_element_visible
- [ ] wait_for_element
- [ ] get_scroll_position

## 🟠 P1 — Input (17)
- [ ] click / click_coordinates
- [ ] type / type_into / clear_input
- [ ] press_key / key_combination
- [ ] scroll / scroll_to_element / scroll_to_top / scroll_to_bottom
- [ ] hover / drag_and_drop
- [ ] select_option / check_checkbox
- [ ] upload_file / focus_element

## 🟠 P1 — Page Actions (3)
- [ ] execute_script
- [ ] get_cookies / set_cookie

## 🟡 P2 — Windows (5) + Tab Groups (5)
- [ ] get/new/close/switch/maximize_window
- [ ] get/create/update/move/ungroup tab_group

## 🟢 P3 — Bookmarks (6) + History (4) + Info (1) + Nudges (2) + Git (6)
- [ ] все вспомогательные tools

## Smoke test
```bash
# Run P0 tests (navigate + screenshot)
bun test apps/server/tests/tools/navigation.test.ts
bun test apps/server/tests/tools/observation.test.ts
```
