diff --git a/chrome/browser/themes/theme_service.cc b/chrome/browser/themes/theme_service.cc
index 0c89bb8539af6..209620f3f0f9a 100644
--- a/chrome/browser/themes/theme_service.cc
+++ b/chrome/browser/themes/theme_service.cc
@@ -30,6 +30,7 @@
 #include "base/task/thread_pool.h"
 #include "base/trace_event/trace_event.h"
 #include "build/build_config.h"
+#include "chrome/browser/browseros/theme/trios_theme.h"
 #include "chrome/browser/extensions/extension_service.h"
 #include "chrome/browser/extensions/theme_installed_infobar_delegate.h"
 #include "chrome/browser/new_tab_page/chrome_colors/chrome_colors_util.h"
@@ -265,6 +266,12 @@ ThemeService::~ThemeService() = default;
 void ThemeService::Init() {
   theme_helper_->DCheckCalledOnValidSequence();

+  // TOTAL BLACK: seed 0x000000 kills the gray (#3a3a3a) frame
+  const PrefService::Preference* user_color_pref =
+      pref_service_->FindPreference(::prefs::kUserColor);
+  if (user_color_pref && user_color_pref->IsDefaultValue()) {
+    pref_service->SetInteger(::prefs::kUserColor, 0xFF000000);
+  }
   InitFromPrefs();
 
   // ThemeObserver should be constructed before calling
@@ -272,11 +274,11 @@ void ThemeService::RegisterProfilePrefs(
                                 SK_ColorTRANSPARENT);
   registry->RegisterIntegerPref(
       prefs::kDeprecatedBrowserColorSchemeDoNotUse,
-      static_cast<int>(ThemeService::BrowserColorScheme::kSystem),
+      static_cast<int>(ThemeService::BrowserColorScheme::kDark),
       user_prefs::PrefRegistrySyncable::SYNCABLE_PREF);
   registry->RegisterIntegerPref(
       prefs::kBrowserColorScheme,
-      static_cast<int>(ThemeService::BrowserColorScheme::kSystem));
+      static_cast<int>(ThemeService::BrowserColorScheme::kDark));
   registry->RegisterIntegerPref(
       prefs::kDeprecatedUserColorDoNotUse, SK_ColorTRANSPARENT,
       user_prefs::PrefRegistrySyncable::SYNCABLE_PREF);
