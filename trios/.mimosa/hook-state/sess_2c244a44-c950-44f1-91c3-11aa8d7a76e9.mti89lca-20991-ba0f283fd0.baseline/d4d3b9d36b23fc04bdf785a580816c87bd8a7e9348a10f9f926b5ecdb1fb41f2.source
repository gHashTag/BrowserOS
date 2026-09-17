diff --git a/chrome/browser/ui/views/new_tab_footer/footer_controller.cc b/chrome/browser/ui/views/new_tab_footer/footer_controller.cc
index fa4ddd420efdf..e52050341f8d6 100644
--- a/chrome/browser/ui/views/new_tab_footer/footer_controller.cc
+++ b/chrome/browser/ui/views/new_tab_footer/footer_controller.cc
@@ -201,14 +201,7 @@ bool NewTabFooterController::ContentsViewFooterCotroller::
 
 bool NewTabFooterController::ContentsViewFooterCotroller::
     ShouldShowExtensionFooter(const GURL& url) {
-  if (ShouldSkipForErrorPage()) {
-    return false;
-  }
-
-  return ntp_footer::IsExtensionNtp(url, owner_->profile_) &&
-         owner_->profile_->GetPrefs()->GetBoolean(
-             prefs::kNTPFooterExtensionAttributionEnabled) &&
-         owner_->profile_->GetPrefs()->GetBoolean(prefs::kNtpFooterVisible);
+  return false;
 }
 
 void NewTabFooterController::UpdateFooterVisibilities(bool log_on_load_metric) {
