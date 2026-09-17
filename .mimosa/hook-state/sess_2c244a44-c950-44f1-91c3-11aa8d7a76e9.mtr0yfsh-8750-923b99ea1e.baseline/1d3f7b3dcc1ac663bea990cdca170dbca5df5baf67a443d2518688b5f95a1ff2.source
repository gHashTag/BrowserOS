diff --git a/chrome/browser/extensions/chrome_extensions_browser_api_provider.cc b/chrome/browser/extensions/chrome_extensions_browser_api_provider.cc
index a251aaaa53378..93c5a121684a4 100644
--- a/chrome/browser/extensions/chrome_extensions_browser_api_provider.cc
+++ b/chrome/browser/extensions/chrome_extensions_browser_api_provider.cc
@@ -4,6 +4,7 @@
 
 #include "chrome/browser/extensions/chrome_extensions_browser_api_provider.h"
 
+#include "chrome/browser/extensions/api/browser_os/browser_os_api.h"
 #include "chrome/browser/extensions/api/generated_api_registration.h"
 #include "extensions/browser/extension_function_registry.h"
 #include "extensions/buildflags/buildflags.h"
@@ -19,6 +20,9 @@ ChromeExtensionsBrowserAPIProvider::~ChromeExtensionsBrowserAPIProvider() =
 
 void ChromeExtensionsBrowserAPIProvider::RegisterExtensionFunctions(
     ExtensionFunctionRegistry* registry) {
+  // BrowserOS API
+  registry->RegisterFunction<api::BrowserOSExecuteJavaScriptFunction>();
+
   // Generated APIs from Chrome.
   api::ChromeGeneratedFunctionRegistry::RegisterAll(registry);
 }
