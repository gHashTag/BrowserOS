diff --git a/chrome/browser/ui/views/side_panel/side_panel_prefs.cc b/chrome/browser/ui/views/side_panel/side_panel_prefs.cc
index 2c6ba6c527498..46424babda9e1 100644
--- a/chrome/browser/ui/views/side_panel/side_panel_prefs.cc
+++ b/chrome/browser/ui/views/side_panel/side_panel_prefs.cc
@@ -7,6 +7,8 @@
 #include "base/feature_list.h"
 #include "base/i18n/rtl.h"
 #include "chrome/browser/ui/ui_features.h"
+#include "chrome/browser/ui/views/side_panel/third_party_llm/third_party_llm_panel_coordinator.h"
+#include "chrome/browser/ui/views/side_panel/clash_of_gpts/clash_of_gpts_coordinator.h"
 #include "chrome/common/pref_names.h"
 #include "components/pref_registry/pref_registry_syncable.h"
 #include "components/prefs/pref_registry_simple.h"
@@ -22,6 +24,16 @@ void RegisterProfilePrefs(user_prefs::PrefRegistrySyncable* registry) {
                                 !base::i18n::IsRTL());
   registry->RegisterBooleanPref(prefs::kGoogleSearchSidePanelEnabled, true);
   registry->RegisterDictionaryPref(prefs::kSidePanelIdToWidth);
+  
+  // Register third-party LLM panel preferences
+  if (base::FeatureList::IsEnabled(features::kThirdPartyLlmPanel)) {
+    ThirdPartyLlmPanelCoordinator::RegisterProfilePrefs(registry);
+  }
+  
+  // Register Clash of GPTs preferences
+  if (base::FeatureList::IsEnabled(features::kClashOfGpts)) {
+    ClashOfGptsCoordinator::RegisterProfilePrefs(registry);
+  }
 }
 
 }  // namespace side_panel_prefs
