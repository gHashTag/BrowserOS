diff --git a/ui/views/widget/desktop_aura/desktop_window_tree_host_win.h b/ui/views/widget/desktop_aura/desktop_window_tree_host_win.h
index b65ced55f997d..8f9aecfc0fee7 100644
--- a/ui/views/widget/desktop_aura/desktop_window_tree_host_win.h
+++ b/ui/views/widget/desktop_aura/desktop_window_tree_host_win.h
@@ -349,6 +349,12 @@ class VIEWS_EXPORT DesktopWindowTreeHostWin
   // True if the window is allow to take screenshots, by default is true.
   bool allow_screenshots_ = true;
 
+  // Honors Widget::InitParams::headless: the HWND is created but never
+  // transitioned to visible via ShowWindow(SW_SHOW*), so the OS compositor
+  // (taskbar, Alt-Tab, Task View, peek preview) doesn't see it. The aura
+  // side still transitions to visible so the content compositor runs.
+  bool is_headless_ = false;
+
   // Visibility of the cursor. On Windows we can have multiple root windows and
   // the implementation of ::ShowCursor() is based on a counter, so making this
   // member static ensures that ::ShowCursor() is always called exactly once
