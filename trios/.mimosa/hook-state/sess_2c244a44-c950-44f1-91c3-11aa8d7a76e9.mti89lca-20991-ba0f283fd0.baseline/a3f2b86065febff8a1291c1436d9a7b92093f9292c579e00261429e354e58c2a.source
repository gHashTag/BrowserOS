diff --git a/ui/platform_window/platform_window_init_properties.h b/ui/platform_window/platform_window_init_properties.h
index fe72bc821b0f7..f90b6cc15e2b6 100644
--- a/ui/platform_window/platform_window_init_properties.h
+++ b/ui/platform_window/platform_window_init_properties.h
@@ -158,6 +158,13 @@ struct COMPONENT_EXPORT(PLATFORM_WINDOW) PlatformWindowInitProperties {
   bool enable_compositing_based_throttling = false;
 
   size_t compositor_memory_limit_mb = 0;
+
+  // When true, the native window is created but never mapped/shown to the
+  // OS compositor. Used by BrowserOS agent hidden windows: compositor still
+  // runs (so pages render, screenshots work), but WM/taskbar/overview never
+  // see it. On X11: SKIP_TASKBAR + SKIP_PAGER hints, XUnmapWindow. On
+  // Wayland: not yet supported.
+  bool headless = false;
 };
 
 }  // namespace ui
