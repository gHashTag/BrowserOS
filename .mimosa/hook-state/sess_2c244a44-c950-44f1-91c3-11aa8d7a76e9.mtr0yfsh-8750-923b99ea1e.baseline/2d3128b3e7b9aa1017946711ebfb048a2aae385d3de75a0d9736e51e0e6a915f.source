diff --git a/ui/views/widget/desktop_aura/desktop_window_tree_host_win.cc b/ui/views/widget/desktop_aura/desktop_window_tree_host_win.cc
index 3a02cb67eb114..41503dadbfbab 100644
--- a/ui/views/widget/desktop_aura/desktop_window_tree_host_win.cc
+++ b/ui/views/widget/desktop_aura/desktop_window_tree_host_win.cc
@@ -169,6 +169,7 @@ void DesktopWindowTreeHostWin::FinishTouchDrag(gfx::Point screen_point) {
 // DesktopWindowTreeHostWin, DesktopWindowTreeHost implementation:
 
 void DesktopWindowTreeHostWin::Init(const Widget::InitParams& params) {
+  is_headless_ = params.headless;
   wm::SetAnimationHost(content_window(), this);
   if (params.type == Widget::InitParams::TYPE_WINDOW &&
       !params.remove_standard_frame) {
@@ -313,6 +314,13 @@ void DesktopWindowTreeHostWin::Show(ui::mojom::WindowShowState show_state,
                                     const gfx::Rect& restore_bounds) {
   OnAcceleratedWidgetMadeVisible(true);
 
+  if (is_headless_) {
+    // Headless: keep the aura side "visible" (so compositor runs + WebContents
+    // sees a shown widget), but never call ShowWindow(SW_SHOW*) on the HWND.
+    content_window()->Show();
+    return;
+  }
+
   gfx::Rect pixel_restore_bounds;
   if (show_state == ui::mojom::WindowShowState::kMaximized) {
     // The window parameter is intentionally passed as nullptr because a
