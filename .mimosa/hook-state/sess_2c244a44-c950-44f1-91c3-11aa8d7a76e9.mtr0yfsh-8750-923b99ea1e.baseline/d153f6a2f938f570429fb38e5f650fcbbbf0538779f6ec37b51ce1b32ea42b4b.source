diff --git a/chrome/browser/ui/views/side_panel/side_panel_util.cc b/chrome/browser/ui/views/side_panel/side_panel_util.cc
index b1fb784415a46..ff491e8ace77e 100644
--- a/chrome/browser/ui/views/side_panel/side_panel_util.cc
+++ b/chrome/browser/ui/views/side_panel/side_panel_util.cc
@@ -21,6 +21,7 @@
 #include "chrome/browser/ui/views/side_panel/history_clusters/history_clusters_side_panel_coordinator.h"
 #include "chrome/browser/ui/views/side_panel/reading_list/reading_list_side_panel_coordinator.h"
 #include "chrome/browser/ui/views/side_panel/side_panel_content_proxy.h"
+#include "chrome/browser/ui/views/side_panel/third_party_llm/third_party_llm_panel_coordinator.h"
 #include "chrome/browser/ui/views/side_panel/side_panel_coordinator.h"
 #include "chrome/browser/ui/views/side_panel/side_panel_registry.h"
 #include "chrome/browser/ui/views/side_panel/side_panel_ui.h"
@@ -86,6 +87,15 @@ void SidePanelUtil::PopulateGlobalEntries(Browser* browser,
         ->CreateAndRegisterEntry(browser, window_registry);
   }
 #endif
+
+  // Add third-party LLM panel.
+  if (base::FeatureList::IsEnabled(features::kThirdPartyLlmPanel)) {
+    browser->browser_window_features()
+        ->third_party_llm_panel_coordinator()
+        ->CreateAndRegisterEntry(window_registry);
+  }
+
+  // Clash of GPTs doesn't need side panel registration as it opens in its own window
 }
 
 SidePanelContentProxy* SidePanelUtil::GetSidePanelContentProxy(
