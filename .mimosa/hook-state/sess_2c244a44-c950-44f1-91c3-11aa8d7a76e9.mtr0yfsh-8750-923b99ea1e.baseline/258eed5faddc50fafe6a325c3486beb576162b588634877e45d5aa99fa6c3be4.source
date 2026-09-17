diff --git a/chrome/browser/ui/views/side_panel/clash_of_gpts/clash_of_gpts_view.h b/chrome/browser/ui/views/side_panel/clash_of_gpts/clash_of_gpts_view.h
new file mode 100644
index 0000000000000..e9bc398177fe3
--- /dev/null
+++ b/chrome/browser/ui/views/side_panel/clash_of_gpts/clash_of_gpts_view.h
@@ -0,0 +1,112 @@
+// Copyright 2025 The Chromium Authors
+// Use of this source code is governed by a BSD-style license that can be
+// found in the LICENSE file.
+
+#ifndef CHROME_BROWSER_UI_VIEWS_SIDE_PANEL_CLASH_OF_GPTS_CLASH_OF_GPTS_VIEW_H_
+#define CHROME_BROWSER_UI_VIEWS_SIDE_PANEL_CLASH_OF_GPTS_CLASH_OF_GPTS_VIEW_H_
+
+#include <array>
+#include <memory>
+#include <vector>
+
+#include "base/memory/raw_ptr.h"
+#include "base/memory/weak_ptr.h"
+#include "ui/base/metadata/metadata_header_macros.h"
+#include "ui/views/view.h"
+
+class ClashOfGptsCoordinator;
+
+namespace base {
+class OneShotTimer;
+}  // namespace base
+
+namespace content {
+class WebContents;
+}  // namespace content
+
+namespace views {
+class Combobox;
+class Label;
+class RadioButton;
+class WebView;
+}  // namespace views
+
+// ClashOfGptsView is the main view containing multiple split WebViews for comparing
+// LLM responses side-by-side. Supports 2 or 3 panes dynamically.
+class ClashOfGptsView : public views::View {
+ public:
+  METADATA_HEADER(ClashOfGptsView, views::View)
+  
+  explicit ClashOfGptsView(ClashOfGptsCoordinator* coordinator);
+  ~ClashOfGptsView() override;
+
+  // Gets the WebContents for a specific pane
+  content::WebContents* GetWebContentsForPane(int pane_index) const;
+
+  // Navigates a specific pane to a URL
+  void NavigatePaneToUrl(int pane_index, const GURL& url);
+
+  // Shows copy feedback message
+  void ShowCopyFeedback();
+
+  // views::View:
+  void OnThemeChanged() override;
+
+  // Updates the view to show the specified number of panes
+  void UpdatePaneCount(int new_count);
+
+ private:
+  friend class ClashOfGptsCoordinator;
+  friend class ClashOfGptsWindow;
+  struct PaneControls {
+    raw_ptr<views::Combobox> provider_selector = nullptr;
+    raw_ptr<views::WebView> web_view = nullptr;
+    raw_ptr<views::Label> pane_label = nullptr;
+  };
+
+  // Creates the UI for a single pane
+  std::unique_ptr<views::View> CreatePaneView(int pane_index);
+
+  // Handles provider selection change for a pane
+  void OnProviderChanged(int pane_index);
+
+  // Opens the current URL of a pane in a new tab
+  void OnOpenInNewTab(int pane_index);
+
+  // Copies content from the active tab
+  void OnCopyContent();
+
+  // Hides the feedback label after a delay
+  void HideFeedbackLabel();
+
+  // Handles pane count radio button selection
+  void OnPaneCountChanged(int pane_count);
+
+  // Recreates the panes container with the new count
+  void RecreatePanesContainer();
+
+  // The coordinator that owns this view
+  raw_ptr<ClashOfGptsCoordinator> coordinator_;
+
+  // Controls for each pane (dynamically sized)
+  std::vector<PaneControls> panes_;
+
+  // Container for the panes
+  raw_ptr<views::View> panes_container_ = nullptr;
+
+  // Radio buttons for selecting pane count
+  raw_ptr<views::RadioButton> one_pane_radio_ = nullptr;
+  raw_ptr<views::RadioButton> two_panes_radio_ = nullptr;
+  raw_ptr<views::RadioButton> three_panes_radio_ = nullptr;
+
+  // Global copy feedback label
+  raw_ptr<views::Label> copy_feedback_label_ = nullptr;
+
+  // Timer for auto-hiding feedback
+  std::unique_ptr<base::OneShotTimer> feedback_timer_;
+
+  // Weak pointer factory for callbacks
+  base::WeakPtrFactory<ClashOfGptsView> weak_factory_{this};
+};
+
+#endif  // CHROME_BROWSER_UI_VIEWS_SIDE_PANEL_CLASH_OF_GPTS_CLASH_OF_GPTS_VIEW_H_
\ No newline at end of file
