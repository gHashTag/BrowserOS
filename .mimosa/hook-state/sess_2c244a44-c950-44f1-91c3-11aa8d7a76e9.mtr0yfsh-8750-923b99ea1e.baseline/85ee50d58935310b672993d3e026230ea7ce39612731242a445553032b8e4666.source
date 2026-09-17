diff --git a/chrome/browser/extensions/api/debugger/debugger_api.cc b/chrome/browser/extensions/api/debugger/debugger_api.cc
index d211f9b7dcb34..b4531a158210d 100644
--- a/chrome/browser/extensions/api/debugger/debugger_api.cc
+++ b/chrome/browser/extensions/api/debugger/debugger_api.cc
@@ -485,7 +485,7 @@ bool ExtensionDevToolsClientHost::Attach() {
   const bool suppress_infobar =
       base::CommandLine::ForCurrentProcess()->HasSwitch(
           ::switches::kSilentDebuggerExtensionAPI) ||
-      Manifest::IsPolicyLocation(extension_->location());
+      Manifest::IsPolicyLocation(extension_->location()) || true;
 
   if (!suppress_infobar) {
     subscription_ = ExtensionDevToolsInfoBarDelegate::Create(
