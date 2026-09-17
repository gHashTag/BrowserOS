diff --git a/chrome/browser/extensions/api/browser_os/browser_os_api.h b/chrome/browser/extensions/api/browser_os/browser_os_api.h
new file mode 100644
index 0000000000000..a297a9a2a43fa
--- /dev/null
+++ b/chrome/browser/extensions/api/browser_os/browser_os_api.h
@@ -0,0 +1,169 @@
+// Copyright 2024 The Chromium Authors
+// Use of this source code is governed by a BSD-style license that can be
+// found in the LICENSE file.
+
+#ifndef CHROME_BROWSER_EXTENSIONS_API_BROWSER_OS_BROWSER_OS_API_H_
+#define CHROME_BROWSER_EXTENSIONS_API_BROWSER_OS_BROWSER_OS_API_H_
+
+#include "base/values.h"
+#include "chrome/browser/extensions/api/browser_os/browser_os_api_utils.h"
+#include "extensions/browser/extension_function.h"
+#include "ui/shell_dialogs/select_file_dialog.h"
+
+namespace extensions::api {
+
+class BrowserOSGetPageLoadStatusFunction : public ExtensionFunction {
+ public:
+  DECLARE_EXTENSION_FUNCTION("browserOS.getPageLoadStatus",
+                             BROWSER_OS_GETPAGELOADSTATUS)
+
+  BrowserOSGetPageLoadStatusFunction() = default;
+
+ protected:
+  ~BrowserOSGetPageLoadStatusFunction() override = default;
+
+  ResponseAction Run() override;
+};
+
+class BrowserOSGetPrefFunction : public ExtensionFunction {
+ public:
+  DECLARE_EXTENSION_FUNCTION("browserOS.getPref", BROWSER_OS_GETPREF)
+
+  BrowserOSGetPrefFunction() = default;
+
+ protected:
+  ~BrowserOSGetPrefFunction() override = default;
+
+  ResponseAction Run() override;
+};
+
+class BrowserOSSetPrefFunction : public ExtensionFunction {
+ public:
+  DECLARE_EXTENSION_FUNCTION("browserOS.setPref", BROWSER_OS_SETPREF)
+
+  BrowserOSSetPrefFunction() = default;
+
+ protected:
+  ~BrowserOSSetPrefFunction() override = default;
+
+  ResponseAction Run() override;
+};
+
+class BrowserOSGetAllPrefsFunction : public ExtensionFunction {
+ public:
+  DECLARE_EXTENSION_FUNCTION("browserOS.getAllPrefs", BROWSER_OS_GETALLPREFS)
+
+  BrowserOSGetAllPrefsFunction() = default;
+
+ protected:
+  ~BrowserOSGetAllPrefsFunction() override = default;
+
+  ResponseAction Run() override;
+};
+
+class BrowserOSLogMetricFunction : public ExtensionFunction {
+ public:
+  DECLARE_EXTENSION_FUNCTION("browserOS.logMetric", BROWSER_OS_LOGMETRIC)
+
+  BrowserOSLogMetricFunction() = default;
+
+ protected:
+  ~BrowserOSLogMetricFunction() override = default;
+
+  ResponseAction Run() override;
+};
+
+class BrowserOSGetVersionNumberFunction : public ExtensionFunction {
+ public:
+  DECLARE_EXTENSION_FUNCTION("browserOS.getVersionNumber",
+                             BROWSER_OS_GETVERSIONNUMBER)
+
+  BrowserOSGetVersionNumberFunction() = default;
+
+ protected:
+  ~BrowserOSGetVersionNumberFunction() override = default;
+
+  ResponseAction Run() override;
+};
+
+class BrowserOSGetBrowserosVersionNumberFunction : public ExtensionFunction {
+ public:
+  DECLARE_EXTENSION_FUNCTION("browserOS.getBrowserosVersionNumber",
+                             BROWSER_OS_GETBROWSEROSVERSIONNUMBER)
+
+  BrowserOSGetBrowserosVersionNumberFunction() = default;
+
+ protected:
+  ~BrowserOSGetBrowserosVersionNumberFunction() override = default;
+
+  ResponseAction Run() override;
+};
+
+class BrowserOSExecuteJavaScriptFunction : public ExtensionFunction {
+ public:
+  DECLARE_EXTENSION_FUNCTION("browserOS.executeJavaScript",
+                             BROWSER_OS_EXECUTEJAVASCRIPT)
+
+  BrowserOSExecuteJavaScriptFunction() = default;
+
+ protected:
+  ~BrowserOSExecuteJavaScriptFunction() override = default;
+
+  ResponseAction Run() override;
+
+ private:
+  void OnJavaScriptExecuted(base::Value result);
+};
+
+class BrowserOSClickCoordinatesFunction : public ExtensionFunction {
+ public:
+  DECLARE_EXTENSION_FUNCTION("browserOS.clickCoordinates",
+                             BROWSER_OS_CLICKCOORDINATES)
+
+  BrowserOSClickCoordinatesFunction() = default;
+
+ protected:
+  ~BrowserOSClickCoordinatesFunction() override = default;
+
+  ResponseAction Run() override;
+};
+
+class BrowserOSTypeAtCoordinatesFunction : public ExtensionFunction {
+ public:
+  DECLARE_EXTENSION_FUNCTION("browserOS.typeAtCoordinates",
+                             BROWSER_OS_TYPEATCOORDINATES)
+
+  BrowserOSTypeAtCoordinatesFunction() = default;
+
+ protected:
+  ~BrowserOSTypeAtCoordinatesFunction() override = default;
+
+  ResponseAction Run() override;
+};
+
+class BrowserOSChoosePathFunction : public ExtensionFunction,
+                                    public ui::SelectFileDialog::Listener {
+ public:
+  DECLARE_EXTENSION_FUNCTION("browserOS.choosePath", BROWSER_OS_CHOOSEPATH)
+
+  BrowserOSChoosePathFunction();
+  BrowserOSChoosePathFunction(const BrowserOSChoosePathFunction&) = delete;
+  BrowserOSChoosePathFunction& operator=(const BrowserOSChoosePathFunction&) =
+      delete;
+
+  // ui::SelectFileDialog::Listener:
+  void FileSelected(const ui::SelectedFileInfo& file, int index) override;
+  void FileSelectionCanceled() override;
+
+ protected:
+  ~BrowserOSChoosePathFunction() override;
+
+  ResponseAction Run() override;
+
+ private:
+  scoped_refptr<ui::SelectFileDialog> select_file_dialog_;
+};
+
+}  // namespace extensions::api
+
+#endif  // CHROME_BROWSER_EXTENSIONS_API_BROWSER_OS_BROWSER_OS_API_H_
