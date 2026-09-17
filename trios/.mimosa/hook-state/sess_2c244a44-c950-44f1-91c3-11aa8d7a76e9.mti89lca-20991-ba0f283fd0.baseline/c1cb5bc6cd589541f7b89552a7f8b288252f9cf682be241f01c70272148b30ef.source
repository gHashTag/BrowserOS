diff --git a/chrome/browser/sessions/session_service_base.cc b/chrome/browser/sessions/session_service_base.cc
index c4a1664d393c9..263ae4511c8f2 100644
--- a/chrome/browser/sessions/session_service_base.cc
+++ b/chrome/browser/sessions/session_service_base.cc
@@ -819,6 +819,11 @@ bool SessionServiceBase::ShouldTrackBrowser(
     return false;
   }
 
+  // Hidden Browsers are ephemeral agent workspaces; never persist them.
+  if (browser->GetBrowserForMigrationOnly()->is_hidden()) {
+    return false;
+  }
+
   // Never track app popup windows that do not have a trusted source (i.e.
   // popup windows spawned by an app). If this logic changes, be sure to also
   // change SessionRestoreImpl::CreateRestoredBrowser().
