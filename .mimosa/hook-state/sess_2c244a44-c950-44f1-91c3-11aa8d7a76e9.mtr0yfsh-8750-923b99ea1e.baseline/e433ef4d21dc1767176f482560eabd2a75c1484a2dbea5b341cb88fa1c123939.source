diff --git a/ui/views/widget/widget_hwnd_utils.cc b/ui/views/widget/widget_hwnd_utils.cc
index 55e5b8a832c9c..ad41487c91e58 100644
--- a/ui/views/widget/widget_hwnd_utils.cc
+++ b/ui/views/widget/widget_hwnd_utils.cc
@@ -56,6 +56,14 @@ WindowStyles CalculateWindowStylesFromInitParams(
   if (params.activatable == Widget::InitParams::Activatable::kNo) {
     styles.ex_style |= WS_EX_NOACTIVATE;
   }
+  // Headless: belt-and-suspenders — even though the HWND is never shown
+  // (see DesktopWindowTreeHostWin::Show), mark it as a tool window and
+  // non-activating so that any accidental surface from the OS compositor
+  // has no taskbar/Alt-Tab presence.
+  if (params.headless) {
+    styles.ex_style |= WS_EX_TOOLWINDOW;
+    styles.ex_style |= WS_EX_NOACTIVATE;
+  }
   if (params.EffectiveZOrderLevel() != ui::ZOrderLevel::kNormal) {
     styles.ex_style |= WS_EX_TOPMOST;
   }
