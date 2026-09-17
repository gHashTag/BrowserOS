diff --git a/chrome/browser/ui/views/toolbar/pinned_action_toolbar_button.h b/chrome/browser/ui/views/toolbar/pinned_action_toolbar_button.h
index e1557abfda184..b3b93610a2ee3 100644
--- a/chrome/browser/ui/views/toolbar/pinned_action_toolbar_button.h
+++ b/chrome/browser/ui/views/toolbar/pinned_action_toolbar_button.h
@@ -51,11 +51,13 @@ class PinnedActionToolbarButton : public ToolbarButton {
   }
   void SetActionEngaged(bool action_engaged);
   void UpdateIcon() override;
+  void UpdateLabelVisibility();
   bool ShouldShowEphemerallyInToolbar();
   bool IsIconVisible() { return is_icon_visible_; }
   bool IsPinned() { return pinned_; }
   bool IsPermanent() { return permanent_; }
   views::View* GetImageContainerView() { return image_container_view(); }
+  Browser* GetBrowser() { return browser_; }
 
   bool ShouldSkipExecutionForTesting() { return skip_execution_; }
 
