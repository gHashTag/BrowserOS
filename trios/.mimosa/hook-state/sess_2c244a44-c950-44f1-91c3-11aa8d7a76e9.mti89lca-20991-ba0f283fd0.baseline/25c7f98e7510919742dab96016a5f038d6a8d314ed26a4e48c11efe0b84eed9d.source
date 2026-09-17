diff --git a/chrome/browser/ui/webui/clash_of_gpts/clash_of_gpts_ui.h b/chrome/browser/ui/webui/clash_of_gpts/clash_of_gpts_ui.h
new file mode 100644
index 0000000000000..63022ff758ac8
--- /dev/null
+++ b/chrome/browser/ui/webui/clash_of_gpts/clash_of_gpts_ui.h
@@ -0,0 +1,33 @@
+// Copyright 2025 The Chromium Authors
+// Use of this source code is governed by a BSD-style license that can be
+// found in the LICENSE file.
+
+#ifndef CHROME_BROWSER_UI_WEBUI_CLASH_OF_GPTS_CLASH_OF_GPTS_UI_H_
+#define CHROME_BROWSER_UI_WEBUI_CLASH_OF_GPTS_CLASH_OF_GPTS_UI_H_
+
+#include "content/public/browser/web_ui_controller.h"
+#include "content/public/browser/webui_config.h"
+
+// WebUI config for chrome://clash-of-gpts
+class ClashOfGptsUIConfig : public content::WebUIConfig {
+ public:
+  ClashOfGptsUIConfig();
+  ~ClashOfGptsUIConfig() override;
+
+  // content::WebUIConfig:
+  std::unique_ptr<content::WebUIController> CreateWebUIController(
+      content::WebUI* web_ui,
+      const GURL& url) override;
+};
+
+// WebUI controller for chrome://clash-of-gpts
+class ClashOfGptsUI : public content::WebUIController {
+ public:
+  explicit ClashOfGptsUI(content::WebUI* web_ui);
+  ~ClashOfGptsUI() override;
+
+  ClashOfGptsUI(const ClashOfGptsUI&) = delete;
+  ClashOfGptsUI& operator=(const ClashOfGptsUI&) = delete;
+};
+
+#endif  // CHROME_BROWSER_UI_WEBUI_CLASH_OF_GPTS_CLASH_OF_GPTS_UI_H_
\ No newline at end of file
