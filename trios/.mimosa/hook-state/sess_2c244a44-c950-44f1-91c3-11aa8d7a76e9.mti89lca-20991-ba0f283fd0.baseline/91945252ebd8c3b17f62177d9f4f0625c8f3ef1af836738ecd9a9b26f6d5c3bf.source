diff --git a/chrome/browser/net/profile_network_context_service.cc b/chrome/browser/net/profile_network_context_service.cc
index 47d3143168fe5..cf6ee43ee56ed 100644
--- a/chrome/browser/net/profile_network_context_service.cc
+++ b/chrome/browser/net/profile_network_context_service.cc
@@ -599,7 +599,7 @@ void ProfileNetworkContextService::ConfigureNetworkContextParams(
 void ProfileNetworkContextService::RegisterProfilePrefs(
     user_prefs::PrefRegistrySyncable* registry) {
   registry->RegisterBooleanPref(embedder_support::kAlternateErrorPagesEnabled,
-                                true);
+                                false);
   registry->RegisterBooleanPref(prefs::kQuicAllowed, true);
   registry->RegisterBooleanPref(prefs::kGloballyScopeHTTPAuthCacheEnabled,
                                 false);
