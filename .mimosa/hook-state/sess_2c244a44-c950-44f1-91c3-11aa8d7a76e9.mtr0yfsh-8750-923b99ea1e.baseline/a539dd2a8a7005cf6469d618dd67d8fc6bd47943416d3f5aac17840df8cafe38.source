diff --git a/chrome/browser/extensions/api/browser_os/browser_os_api_helpers.h b/chrome/browser/extensions/api/browser_os/browser_os_api_helpers.h
new file mode 100644
index 0000000000000..24948f72ec077
--- /dev/null
+++ b/chrome/browser/extensions/api/browser_os/browser_os_api_helpers.h
@@ -0,0 +1,49 @@
+// Copyright 2024 The Chromium Authors
+// Use of this source code is governed by a BSD-style license that can be
+// found in the LICENSE file.
+
+#ifndef CHROME_BROWSER_EXTENSIONS_API_BROWSER_OS_BROWSER_OS_API_HELPERS_H_
+#define CHROME_BROWSER_EXTENSIONS_API_BROWSER_OS_BROWSER_OS_API_HELPERS_H_
+
+#include <string>
+
+#include "ui/gfx/geometry/point_f.h"
+
+namespace content {
+class RenderWidgetHost;
+class WebContents;
+}  // namespace content
+
+namespace extensions::api {
+
+// Returns the multiplicative factor that converts CSS pixels (frame
+// coordinates) to widget DIPs for input events. This matches DevTools'
+// InputHandler::ScaleFactor(): browser zoom × CSS zoom × page scale. The
+// device scale factor (DSF) is NOT included because compositor handles it and
+// input expects widget DIPs (we also set screen = widget).
+float CssToWidgetScale(content::WebContents* web_contents,
+                       content::RenderWidgetHost* rwh);
+
+// Dispatches a synthetic left-click (mouse down + up) at |point|, which is
+// interpreted as CSS pixels relative to the viewport.
+void PointClick(content::WebContents* web_contents, const gfx::PointF& point);
+
+// Commits |text| to the currently-focused element via the renderer's IME
+// pipeline. Caller must ensure focus is established first.
+void NativeType(content::WebContents* web_contents, const std::string& text);
+
+// Clicks at |point| and reports whether the page exhibited any observable
+// change within a short window (DOM mutation, navigation, focus shift, etc.).
+bool ClickCoordinatesWithDetection(content::WebContents* web_contents,
+                                   const gfx::PointF& point);
+
+// Clicks at |point| to focus, then types |text|. Falls back to JavaScript
+// assignment if native IME typing yields no observable change. Returns true
+// on detected success or JS fallback completion.
+bool TypeAtCoordinatesWithDetection(content::WebContents* web_contents,
+                                    const gfx::PointF& point,
+                                    const std::string& text);
+
+}  // namespace extensions::api
+
+#endif  // CHROME_BROWSER_EXTENSIONS_API_BROWSER_OS_BROWSER_OS_API_HELPERS_H_
