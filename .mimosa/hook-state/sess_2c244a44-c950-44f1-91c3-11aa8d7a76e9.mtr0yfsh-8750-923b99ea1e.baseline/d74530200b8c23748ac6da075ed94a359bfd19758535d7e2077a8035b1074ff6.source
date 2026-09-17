diff --git a/third_party/blink/renderer/core/frame/navigator.cc b/third_party/blink/renderer/core/frame/navigator.cc
index 1a73d4a8f097f..2f6238fcd0757 100644
--- a/third_party/blink/renderer/core/frame/navigator.cc
+++ b/third_party/blink/renderer/core/frame/navigator.cc
@@ -101,12 +101,7 @@ bool Navigator::cookieEnabled() const {
 }
 
 bool Navigator::webdriver() const {
-  if (RuntimeEnabledFeatures::AutomationControlledEnabled())
-    return true;
-
-  bool automation_enabled = false;
-  probe::ApplyAutomationOverride(GetExecutionContext(), automation_enabled);
-  return automation_enabled;
+  return false;
 }
 
 String Navigator::GetAcceptLanguages() {
