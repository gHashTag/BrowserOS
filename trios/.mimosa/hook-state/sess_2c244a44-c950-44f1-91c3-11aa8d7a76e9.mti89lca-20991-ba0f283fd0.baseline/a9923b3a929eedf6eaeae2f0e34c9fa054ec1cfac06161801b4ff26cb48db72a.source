diff --git a/ui/views/widget/desktop_aura/desktop_window_tree_host_platform.cc b/ui/views/widget/desktop_aura/desktop_window_tree_host_platform.cc
index 17476127a1b05..7c56e3c4a290e 100644
--- a/ui/views/widget/desktop_aura/desktop_window_tree_host_platform.cc
+++ b/ui/views/widget/desktop_aura/desktop_window_tree_host_platform.cc
@@ -141,6 +141,7 @@ ui::PlatformWindowInitProperties ConvertWidgetInitParamsToInitProperties(
   properties.workspace = params.workspace;
   properties.opacity = GetPlatformWindowOpacity(params.opacity);
   properties.shadow_type = GetPlatformWindowShadowType(params.shadow_type);
+  properties.headless = params.headless;
 
   if (params.parent && params.parent->GetHost()) {
     properties.parent_widget = params.parent->GetHost()->GetAcceleratedWidget();
