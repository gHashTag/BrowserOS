diff --git a/chrome/browser/extensions/api/browser_os/browser_os_api_helpers.cc b/chrome/browser/extensions/api/browser_os/browser_os_api_helpers.cc
new file mode 100644
index 0000000000000..3849875a90533
--- /dev/null
+++ b/chrome/browser/extensions/api/browser_os/browser_os_api_helpers.cc
@@ -0,0 +1,180 @@
+// Copyright 2024 The Chromium Authors
+// Use of this source code is governed by a BSD-style license that can be
+// found in the LICENSE file.
+
+#include "chrome/browser/extensions/api/browser_os/browser_os_api_helpers.h"
+
+#include <vector>
+
+#include "base/logging.h"
+#include "base/strings/stringprintf.h"
+#include "base/strings/utf_string_conversions.h"
+#include "base/threading/platform_thread.h"
+#include "chrome/browser/extensions/api/browser_os/browser_os_change_detector.h"
+#include "content/browser/renderer_host/render_widget_host_impl.h"
+#include "content/browser/renderer_host/render_widget_host_view_base.h"
+#include "content/browser/web_contents/web_contents_impl.h"
+#include "content/public/browser/render_frame_host.h"
+#include "content/public/browser/render_widget_host.h"
+#include "content/public/browser/render_widget_host_view.h"
+#include "content/public/browser/web_contents.h"
+#include "third_party/blink/public/common/input/web_input_event.h"
+#include "third_party/blink/public/common/input/web_mouse_event.h"
+#include "third_party/blink/public/common/page/page_zoom.h"
+#include "ui/base/ime/ime_text_span.h"
+#include "ui/events/base_event_utils.h"
+#include "ui/gfx/range/range.h"
+
+namespace extensions::api {
+
+float CssToWidgetScale(content::WebContents* web_contents,
+                       content::RenderWidgetHost* rwh) {
+  float zoom = 1.0f;
+  if (auto* rwhi = static_cast<content::RenderWidgetHostImpl*>(rwh)) {
+    if (auto* wci = static_cast<content::WebContentsImpl*>(web_contents)) {
+      zoom = blink::ZoomLevelToZoomFactor(wci->GetPendingZoomLevel(rwhi));
+    }
+  }
+
+  float css_zoom = 1.0f;
+  if (auto* view = rwh ? rwh->GetView() : nullptr) {
+    if (auto* view_base =
+            static_cast<content::RenderWidgetHostViewBase*>(view)) {
+      css_zoom = view_base->GetCSSZoomFactor();
+    }
+  }
+
+  float page_scale = 1.0f;
+  if (auto* wci = static_cast<content::WebContentsImpl*>(web_contents)) {
+    page_scale = wci->GetPrimaryPage().GetPageScaleFactor();
+  }
+
+  return zoom * css_zoom * page_scale;
+}
+
+void PointClick(content::WebContents* web_contents, const gfx::PointF& point) {
+  content::RenderFrameHost* rfh = web_contents->GetPrimaryMainFrame();
+  if (!rfh) {
+    return;
+  }
+  content::RenderWidgetHost* rwh = rfh->GetRenderWidgetHost();
+  if (!rwh) {
+    return;
+  }
+  if (!rwh->GetView()) {
+    return;
+  }
+
+  // Input pipeline expects widget DIPs; align screen = widget to avoid
+  // HiDPI unit mixing (compositor handles DSF).
+  const float scale = CssToWidgetScale(web_contents, rwh);
+  gfx::PointF widget_point(point.x() * scale, point.y() * scale);
+
+  blink::WebMouseEvent mouse_down;
+  mouse_down.SetType(blink::WebInputEvent::Type::kMouseDown);
+  mouse_down.button = blink::WebPointerProperties::Button::kLeft;
+  mouse_down.click_count = 1;
+  mouse_down.SetPositionInWidget(widget_point.x(), widget_point.y());
+  mouse_down.SetPositionInScreen(widget_point.x(), widget_point.y());
+  mouse_down.SetTimeStamp(ui::EventTimeForNow());
+  mouse_down.SetModifiers(blink::WebInputEvent::kLeftButtonDown);
+
+  blink::WebMouseEvent mouse_up;
+  mouse_up.SetType(blink::WebInputEvent::Type::kMouseUp);
+  mouse_up.button = blink::WebPointerProperties::Button::kLeft;
+  mouse_up.click_count = 1;
+  mouse_up.SetPositionInWidget(widget_point.x(), widget_point.y());
+  mouse_up.SetPositionInScreen(widget_point.x(), widget_point.y());
+  mouse_up.SetTimeStamp(ui::EventTimeForNow());
+
+  rwh->ForwardMouseEvent(mouse_down);
+  rwh->ForwardMouseEvent(mouse_up);
+}
+
+void NativeType(content::WebContents* web_contents, const std::string& text) {
+  content::RenderFrameHost* rfh = web_contents->GetPrimaryMainFrame();
+  if (!rfh) {
+    return;
+  }
+  content::RenderWidgetHost* rwh = rfh->GetRenderWidgetHost();
+  if (!rwh) {
+    return;
+  }
+
+  content::RenderWidgetHostImpl* rwhi =
+      static_cast<content::RenderWidgetHostImpl*>(rwh);
+  rwhi->Focus();
+
+  // ImeCommitText without composition avoids form-input issues that arise
+  // when using composition state for a direct value set.
+  rwhi->ImeCommitText(base::UTF8ToUTF16(text), std::vector<ui::ImeTextSpan>(),
+                      gfx::Range::InvalidRange(),
+                      /*relative_cursor_pos=*/0);
+}
+
+bool ClickCoordinatesWithDetection(content::WebContents* web_contents,
+                                   const gfx::PointF& point) {
+  LOG(INFO) << "[browseros] ClickCoordinatesWithDetection at (" << point.x()
+            << ", " << point.y() << ")";
+
+  bool changed = BrowserOSChangeDetector::ExecuteWithDetection(
+      web_contents,
+      [&]() { PointClick(web_contents, point); },
+      base::Milliseconds(300));
+
+  LOG(INFO) << "[browseros] Click coordinates result: "
+            << (changed ? "changed" : "no change");
+  return changed;
+}
+
+bool TypeAtCoordinatesWithDetection(content::WebContents* web_contents,
+                                    const gfx::PointF& point,
+                                    const std::string& text) {
+  LOG(INFO) << "[browseros] TypeAtCoordinatesWithDetection at (" << point.x()
+            << ", " << point.y() << ") with text: " << text;
+
+  PointClick(web_contents, point);
+  base::PlatformThread::Sleep(base::Milliseconds(100));
+
+  bool changed = BrowserOSChangeDetector::ExecuteWithDetection(
+      web_contents,
+      [&]() { NativeType(web_contents, text); },
+      base::Milliseconds(300));
+
+  if (!changed) {
+    LOG(INFO) << "[browseros] No change from native typing, trying JS fallback";
+    content::RenderFrameHost* rfh = web_contents->GetPrimaryMainFrame();
+    if (rfh) {
+      std::string js_code = base::StringPrintf(R"(
+        (function() {
+          var focused = document.activeElement;
+          if (focused && (focused.tagName === 'INPUT' ||
+                         focused.tagName === 'TEXTAREA' ||
+                         focused.contentEditable === 'true')) {
+            if (focused.contentEditable === 'true') {
+              focused.textContent = '%s';
+            } else {
+              focused.value = '%s';
+            }
+            focused.dispatchEvent(new Event('input', { bubbles: true }));
+            focused.dispatchEvent(new Event('change', { bubbles: true }));
+            return true;
+          }
+          return false;
+        })();
+      )",
+                                               text.c_str(), text.c_str());
+      rfh->ExecuteJavaScriptForTests(base::UTF8ToUTF16(js_code),
+                                     base::NullCallback(),
+                                     /*honor_js_content_settings=*/false);
+      base::PlatformThread::Sleep(base::Milliseconds(50));
+      changed = true;
+    }
+  }
+
+  LOG(INFO) << "[browseros] Type at coordinates result: "
+            << (changed ? "success" : "failed");
+  return changed;
+}
+
+}  // namespace extensions::api
