diff --git a/ui/ozone/platform/x11/x11_window.h b/ui/ozone/platform/x11/x11_window.h
index f744189f0aa26..ad022d7303ccf 100644
--- a/ui/ozone/platform/x11/x11_window.h
+++ b/ui/ozone/platform/x11/x11_window.h
@@ -428,6 +428,11 @@ class X11Window : public PlatformWindow,
   // True if the window is security-sensitive. Implies |is_always_on_top_|.
   bool is_security_surface_ = false;
 
+  // Mirrors PlatformWindowInitProperties::headless. When true the XWindow is
+  // created but never mapped: _NET_WM_STATE_SKIP_TASKBAR + SKIP_PAGER hints
+  // ensure no WM surface, Show() is a no-op at the X level.
+  bool is_headless_ = false;
+
   // True if the window is fully obscured by another window.
   bool is_occluded_ = false;
 
