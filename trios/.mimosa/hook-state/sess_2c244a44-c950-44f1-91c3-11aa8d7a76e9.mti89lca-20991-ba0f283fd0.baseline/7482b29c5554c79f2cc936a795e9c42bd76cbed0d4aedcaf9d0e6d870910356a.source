diff --git a/chrome/browser/ui/views/side_panel/clash_of_gpts/clash_of_gpts_window.cc b/chrome/browser/ui/views/side_panel/clash_of_gpts/clash_of_gpts_window.cc
new file mode 100644
index 0000000000000..7a44fab1879ef
--- /dev/null
+++ b/chrome/browser/ui/views/side_panel/clash_of_gpts/clash_of_gpts_window.cc
@@ -0,0 +1,83 @@
+// Copyright 2025 The Chromium Authors
+// Use of this source code is governed by a BSD-style license that can be
+// found in the LICENSE file.
+
+#include "chrome/browser/ui/views/side_panel/clash_of_gpts/clash_of_gpts_window.h"
+
+#include "chrome/browser/ui/browser.h"
+#include "chrome/browser/ui/browser_window.h"
+#include "chrome/browser/ui/views/chrome_layout_provider.h"
+#include "chrome/browser/ui/views/side_panel/clash_of_gpts/clash_of_gpts_coordinator.h"
+#include "chrome/browser/ui/views/side_panel/clash_of_gpts/clash_of_gpts_view.h"
+#include "components/vector_icons/vector_icons.h"
+#include "ui/base/models/image_model.h"
+#include "ui/gfx/geometry/size.h"
+#include "ui/views/widget/widget.h"
+
+ClashOfGptsWindow::ClashOfGptsWindow(Browser* browser,
+                                     ClashOfGptsCoordinator* coordinator)
+    : browser_(browser), 
+      coordinator_(coordinator) {
+  // Create the main view
+  view_ = new ClashOfGptsView(coordinator);
+  
+  // Widget will be set by the coordinator after creation
+}
+
+ClashOfGptsWindow::~ClashOfGptsWindow() {
+  // The widget will delete the view when it's destroyed
+}
+
+void ClashOfGptsWindow::Show() {
+  // Widget is created and managed by the coordinator
+  // This method is no longer responsible for widget creation
+}
+
+void ClashOfGptsWindow::Close() {
+  // Widget is managed by the coordinator
+}
+
+bool ClashOfGptsWindow::IsShowing() const {
+  return widget_ && widget_->IsVisible();
+}
+
+std::u16string ClashOfGptsWindow::GetWindowTitle() const {
+  return u"Council";
+}
+
+bool ClashOfGptsWindow::CanResize() const {
+  return true;
+}
+
+bool ClashOfGptsWindow::CanMaximize() const {
+  return true;
+}
+
+bool ClashOfGptsWindow::CanMinimize() const {
+  return true;
+}
+
+bool ClashOfGptsWindow::ShouldShowCloseButton() const {
+  return true;
+}
+
+views::View* ClashOfGptsWindow::GetContentsView() {
+  return view_;
+}
+
+ui::ImageModel ClashOfGptsWindow::GetWindowIcon() {
+  return ui::ImageModel::FromVectorIcon(vector_icons::kSettingsIcon,
+                                       ui::kColorIcon, 16);
+}
+
+ui::ImageModel ClashOfGptsWindow::GetWindowAppIcon() {
+  return GetWindowIcon();
+}
+
+views::Widget* ClashOfGptsWindow::GetWidget() {
+  return widget_;
+}
+
+const views::Widget* ClashOfGptsWindow::GetWidget() const {
+  return widget_;
+}
