diff --git a/components/content_settings/core/browser/cookie_settings.cc b/components/content_settings/core/browser/cookie_settings.cc
index f89550ae67509..74a0c16236b2b 100644
--- a/components/content_settings/core/browser/cookie_settings.cc
+++ b/components/content_settings/core/browser/cookie_settings.cc
@@ -94,7 +94,7 @@ void CookieSettings::RegisterProfilePrefs(
     user_prefs::PrefRegistrySyncable* registry) {
   registry->RegisterIntegerPref(
       prefs::kCookieControlsMode,
-      static_cast<int>(CookieControlsMode::kIncognitoOnly),
+      static_cast<int>(CookieControlsMode::kBlockThirdParty),
       user_prefs::PrefRegistrySyncable::SYNCABLE_PREF);
 }
 
