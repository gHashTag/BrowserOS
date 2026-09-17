diff --git a/chrome/browser/extensions/api/browser_os/browser_os_api_utils.h b/chrome/browser/extensions/api/browser_os/browser_os_api_utils.h
new file mode 100644
index 0000000000000..f5dd08378e67f
--- /dev/null
+++ b/chrome/browser/extensions/api/browser_os/browser_os_api_utils.h
@@ -0,0 +1,38 @@
+// Copyright 2024 The Chromium Authors
+// Use of this source code is governed by a BSD-style license that can be
+// found in the LICENSE file.
+
+#ifndef CHROME_BROWSER_EXTENSIONS_API_BROWSER_OS_BROWSER_OS_API_UTILS_H_
+#define CHROME_BROWSER_EXTENSIONS_API_BROWSER_OS_BROWSER_OS_API_UTILS_H_
+
+#include <optional>
+#include <string>
+
+#include "base/memory/raw_ptr.h"
+
+namespace content {
+class BrowserContext;
+class WebContents;
+}  // namespace content
+
+namespace extensions::api {
+
+// Result structure for tab retrieval
+struct TabInfo {
+  raw_ptr<content::WebContents> web_contents;
+  int tab_id;
+
+  TabInfo(content::WebContents* wc, int id) : web_contents(wc), tab_id(id) {}
+};
+
+// Helper to get WebContents and tab ID from optional tab_id parameter.
+// Returns nullopt if tab is not found, with error message set.
+std::optional<TabInfo> GetTabFromOptionalId(
+    std::optional<int> tab_id_param,
+    content::BrowserContext* browser_context,
+    bool include_incognito_information,
+    std::string* error_message);
+
+}  // namespace extensions::api
+
+#endif  // CHROME_BROWSER_EXTENSIONS_API_BROWSER_OS_BROWSER_OS_API_UTILS_H_
