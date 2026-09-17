diff --git a/chrome/browser/ui/views/infobars/infobar_container_view.cc b/chrome/browser/ui/views/infobars/infobar_container_view.cc
index 7880b240c9f70..536b7ae1bbd49 100644
--- a/chrome/browser/ui/views/infobars/infobar_container_view.cc
+++ b/chrome/browser/ui/views/infobars/infobar_container_view.cc
@@ -120,8 +120,7 @@ void InfoBarContainerView::Layout(PassKey) {
   // there drawn by the shadow code (so we don't have to extend our bounds out
   // to be able to draw it; see comments in CalculatePreferredSize() on why the
   // shadow is drawn outside the container bounds).
-  content_shadow_->SetBounds(0, top, width(),
-                             content_shadow_->GetPreferredSize().height());
+  content_shadow_->SetBounds(0, top, width(), 1);
 }
 
 gfx::Size InfoBarContainerView::CalculatePreferredSize(
