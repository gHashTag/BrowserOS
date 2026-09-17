diff --git a/chrome/common/webui_url_constants.cc b/chrome/common/webui_url_constants.cc
index 85b06a40a8bb8..f6e2fa231cd35 100644
--- a/chrome/common/webui_url_constants.cc
+++ b/chrome/common/webui_url_constants.cc
@@ -74,6 +74,7 @@ bool IsSystemWebUIHost(std::string_view host) {
 // These hosts will also be suggested by BuiltinProvider.
 base::span<const base::cstring_view> ChromeURLHosts() {
   static constexpr auto kChromeURLHosts = std::to_array<base::cstring_view>({
+      kBrowserOSFirstRun,
       kChromeUIAboutHost,
       kChromeUIAccessibilityHost,
       kChromeUIActorInternalsHost,
