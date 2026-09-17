diff --git a/chrome/browser/ui/webui/clash_of_gpts/clash_of_gpts_ui.cc b/chrome/browser/ui/webui/clash_of_gpts/clash_of_gpts_ui.cc
new file mode 100644
index 0000000000000..ce25eefa09ff9
--- /dev/null
+++ b/chrome/browser/ui/webui/clash_of_gpts/clash_of_gpts_ui.cc
@@ -0,0 +1,104 @@
+// Copyright 2025 The Chromium Authors
+// Use of this source code is governed by a BSD-style license that can be
+// found in the LICENSE file.
+
+#include "chrome/browser/ui/webui/clash_of_gpts/clash_of_gpts_ui.h"
+
+#include <memory>
+
+#include "base/memory/ref_counted_memory.h"
+#include "chrome/browser/profiles/profile.h"
+#include "chrome/browser/ui/browser.h"
+#include "chrome/browser/ui/browser_window/public/browser_window_features.h"
+#include "chrome/browser/ui/browser_finder.h"
+#include "chrome/browser/ui/views/side_panel/clash_of_gpts/clash_of_gpts_coordinator.h"
+#include "chrome/common/webui_url_constants.h"
+#include "chrome/grit/generated_resources.h"
+#include "content/public/browser/web_contents.h"
+#include "content/public/browser/web_ui.h"
+#include "content/public/browser/web_ui_data_source.h"
+#include "services/network/public/mojom/content_security_policy.mojom.h"
+
+ClashOfGptsUIConfig::ClashOfGptsUIConfig()
+    : content::WebUIConfig(content::kChromeUIScheme,
+                          chrome::kChromeUIClashOfGptsHost) {}
+
+ClashOfGptsUIConfig::~ClashOfGptsUIConfig() = default;
+
+std::unique_ptr<content::WebUIController>
+ClashOfGptsUIConfig::CreateWebUIController(content::WebUI* web_ui,
+                                           const GURL& url) {
+  return std::make_unique<ClashOfGptsUI>(web_ui);
+}
+
+ClashOfGptsUI::ClashOfGptsUI(content::WebUI* web_ui)
+    : content::WebUIController(web_ui) {
+  // Create a data source with minimal HTML
+  content::WebUIDataSource* source = content::WebUIDataSource::CreateAndAdd(
+      web_ui->GetWebContents()->GetBrowserContext(),
+      chrome::kChromeUIClashOfGptsHost);
+
+  // Set the HTML content directly
+  static constexpr const char kHtmlContent[] = R"(
+<!DOCTYPE html>
+<html>
+<head>
+  <meta charset="utf-8">
+  <title>Council</title>
+  <style>
+    body {
+      font-family: system-ui, -apple-system, sans-serif;
+      display: flex;
+      justify-content: center;
+      align-items: center;
+      height: 100vh;
+      margin: 0;
+      background: #f5f5f5;
+    }
+    .message {
+      text-align: center;
+      color: #666;
+    }
+  </style>
+</head>
+<body>
+  <div class="message">
+    <h2>Opening Council...</h2>
+    <p>The window should open automatically.</p>
+  </div>
+  <script>
+    // Close this tab after a short delay
+    setTimeout(() => {
+      window.close();
+    }, 1000);
+  </script>
+</body>
+</html>
+)";
+
+  // Use a lambda to provide the HTML content
+  source->SetRequestFilter(
+      base::BindRepeating([](const std::string& path) { 
+        return path.empty() || path == "/"; 
+      }),
+      base::BindRepeating([](const std::string& path,
+                            content::WebUIDataSource::GotDataCallback callback) {
+        std::string data(kHtmlContent);
+        auto ref_bytes = base::MakeRefCounted<base::RefCountedBytes>(
+            std::vector<uint8_t>(data.begin(), data.end()));
+        std::move(callback).Run(ref_bytes);
+      }));
+  
+  // Set CSP
+  source->OverrideContentSecurityPolicy(
+      network::mojom::CSPDirectiveName::ScriptSrc,
+      "script-src 'self' 'unsafe-inline';");
+
+  // Open the Clash of GPTs window
+  Browser* browser = chrome::FindBrowserWithTab(web_ui->GetWebContents());
+  if (browser) {
+    browser->browser_window_features()->clash_of_gpts_coordinator()->Show();
+  }
+}
+
+ClashOfGptsUI::~ClashOfGptsUI() = default;
