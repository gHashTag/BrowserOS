diff --git a/chrome/browser/extensions/api/browser_os/browser_os_api_utils.cc b/chrome/browser/extensions/api/browser_os/browser_os_api_utils.cc
new file mode 100644
index 0000000000000..715703aca2e4d
--- /dev/null
+++ b/chrome/browser/extensions/api/browser_os/browser_os_api_utils.cc
@@ -0,0 +1,58 @@
+// Copyright 2024 The Chromium Authors
+// Use of this source code is governed by a BSD-style license that can be
+// found in the LICENSE file.
+
+#include "chrome/browser/extensions/api/browser_os/browser_os_api_utils.h"
+
+#include "chrome/browser/extensions/extension_tab_util.h"
+#include "chrome/browser/extensions/window_controller.h"
+#include "chrome/browser/ui/browser.h"
+#include "chrome/browser/ui/browser_finder.h"
+#include "chrome/browser/ui/tabs/tab_strip_model.h"
+#include "content/public/browser/web_contents.h"
+
+namespace extensions::api {
+
+std::optional<TabInfo> GetTabFromOptionalId(
+    std::optional<int> tab_id_param,
+    content::BrowserContext* browser_context,
+    bool include_incognito_information,
+    std::string* error_message) {
+  content::WebContents* web_contents = nullptr;
+  int tab_id = -1;
+
+  if (tab_id_param) {
+    WindowController* controller = nullptr;
+    int tab_index = -1;
+    if (!ExtensionTabUtil::GetTabById(*tab_id_param, browser_context,
+                                      include_incognito_information,
+                                      &controller, &web_contents,
+                                      &tab_index)) {
+      if (error_message) {
+        *error_message = "Tab not found";
+      }
+      return std::nullopt;
+    }
+    tab_id = *tab_id_param;
+  } else {
+    Browser* browser = chrome::FindLastActive();
+    if (!browser) {
+      if (error_message) {
+        *error_message = "No active browser";
+      }
+      return std::nullopt;
+    }
+    web_contents = browser->tab_strip_model()->GetActiveWebContents();
+    if (!web_contents) {
+      if (error_message) {
+        *error_message = "No active tab";
+      }
+      return std::nullopt;
+    }
+    tab_id = ExtensionTabUtil::GetTabId(web_contents);
+  }
+
+  return TabInfo(web_contents, tab_id);
+}
+
+}  // namespace extensions::api
