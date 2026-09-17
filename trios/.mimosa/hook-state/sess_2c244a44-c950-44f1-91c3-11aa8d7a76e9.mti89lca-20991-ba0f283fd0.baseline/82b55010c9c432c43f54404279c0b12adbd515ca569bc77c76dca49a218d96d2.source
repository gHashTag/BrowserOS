diff --git a/chrome/browser/ui/browser_list.h b/chrome/browser/ui/browser_list.h
index a8f0e5b82d586..ac636aa584728 100644
--- a/chrome/browser/ui/browser_list.h
+++ b/chrome/browser/ui/browser_list.h
@@ -25,6 +25,12 @@ class Browser;
 class BrowserWindowInterface;
 class BrowserListObserver;
 
+// True if `browser` should appear in user-facing UI enumerations (tab search,
+// window menus, drag-drop candidates, extensions API, etc.). Returns false for
+// hidden Browsers — agent-owned workspaces that exist in BrowserList but are
+// not part of the user's visible windowing experience.
+bool ShouldShowBrowserInUserInterface(const Browser* browser);
+
 // Maintains a list of Browser objects.
 class BrowserList {
  public:
@@ -37,6 +43,11 @@ class BrowserList {
 
   static BrowserList* GetInstance();
 
+  // Returns the BrowserList filtered to user-visible Browsers (see
+  // ShouldShowBrowserInUserInterface). Use this — instead of GetInstance() —
+  // at UI enumeration sites so hidden agent workspaces are excluded.
+  static BrowserVector GetUserVisibleBrowsers();
+
   // Adds or removes |browser| from the list it is associated with. The browser
   // object should be valid BEFORE these calls (for the benefit of observers),
   // so notify and THEN delete the object.
