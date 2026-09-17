diff --git a/chrome/browser/ui/views/toolbar/pinned_toolbar_actions_container.h b/chrome/browser/ui/views/toolbar/pinned_toolbar_actions_container.h
index 7cda29020d9c8..0227cea111fb3 100644
--- a/chrome/browser/ui/views/toolbar/pinned_toolbar_actions_container.h
+++ b/chrome/browser/ui/views/toolbar/pinned_toolbar_actions_container.h
@@ -59,6 +59,9 @@ class PinnedToolbarActionsContainer
   // ToolbarIconContainerView:
   void UpdateAllIcons() override;
 
+  // Updates label visibility on all buttons based on pref.
+  void UpdateAllLabels();
+
   // views::View:
   void OnThemeChanged() override;
   void AddedToWidget() override;
@@ -76,6 +79,7 @@ class PinnedToolbarActionsContainer
   void OnActionAddedLocally(actions::ActionId id) override;
   void OnActionRemovedLocally(actions::ActionId id) override;
   void OnActionsChanged() override;
+  void OnLabelsVisibilityChanged() override;
 
   // views::DragController:
   void WriteDragDataForView(View* sender,
