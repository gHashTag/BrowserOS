diff --git a/chrome/browser/ui/views/side_panel/clash_of_gpts/clash_of_gpts_coordinator.h b/chrome/browser/ui/views/side_panel/clash_of_gpts/clash_of_gpts_coordinator.h
new file mode 100644
index 0000000000000..80c7895b1e08b
--- /dev/null
+++ b/chrome/browser/ui/views/side_panel/clash_of_gpts/clash_of_gpts_coordinator.h
@@ -0,0 +1,214 @@
+// Copyright 2025 The Chromium Authors
+// Use of this source code is governed by a BSD-style license that can be
+// found in the LICENSE file.
+
+#ifndef CHROME_BROWSER_UI_VIEWS_SIDE_PANEL_CLASH_OF_GPTS_CLASH_OF_GPTS_COORDINATOR_H_
+#define CHROME_BROWSER_UI_VIEWS_SIDE_PANEL_CLASH_OF_GPTS_CLASH_OF_GPTS_COORDINATOR_H_
+
+#include <array>
+#include <map>
+#include <memory>
+#include <string>
+#include <vector>
+
+#include "base/memory/raw_ptr.h"
+#include "base/memory/weak_ptr.h"
+#include "base/scoped_multi_source_observation.h"
+#include "base/scoped_observation.h"
+#include "chrome/browser/ui/browser_list_observer.h"
+#include "chrome/browser/profiles/profile_observer.h"
+#include "content/public/browser/web_contents_delegate.h"
+#include "content/public/browser/web_contents_observer.h"
+#include "third_party/blink/public/mojom/window_features/window_features.mojom-forward.h"
+#include "ui/base/window_open_disposition.h"
+#include "ui/views/controls/webview/unhandled_keyboard_event_handler.h"
+#include "ui/views/view_observer.h"
+#include "ui/views/widget/widget.h"
+#include "url/gurl.h"
+
+class Browser;
+class BrowserList;
+class ClashOfGptsView;
+class ClashOfGptsWindow;
+class Profile;
+class SidePanelRegistry;
+
+namespace content {
+class WebContents;
+}  // namespace content
+
+namespace input {
+struct NativeWebKeyboardEvent;
+}  // namespace input
+
+namespace user_prefs {
+class PrefRegistrySyncable;
+}  // namespace user_prefs
+
+namespace views {
+class Widget;
+}  // namespace views
+
+// Forward declare LlmProviderInfo from third_party_llm
+struct LlmProviderInfo;
+
+// ClashOfGptsCoordinator manages the Clash of GPTs window with multiple WebViews
+// for comparing LLM responses side-by-side.
+class ClashOfGptsCoordinator : public BrowserListObserver,
+                                public ProfileObserver,
+                                public content::WebContentsDelegate,
+                                public views::ViewObserver {
+ public:
+  // Configuration constants
+  static constexpr int kMinPanes = 1;
+  static constexpr int kMaxPanes = 3;
+  static constexpr int kDefaultPaneCount = 3;
+
+  explicit ClashOfGptsCoordinator(Browser* browser);
+  ~ClashOfGptsCoordinator() override;
+
+  // Shows the Clash of GPTs window
+  void Show();
+
+  // Closes the window
+  void Close();
+
+  // Returns true if the window is showing
+  bool IsShowing() const;
+
+  // Cycles to the next provider for a specific pane
+  void CycleProviderInPane(int pane_index);
+
+  // Copies content from active tab to all panes
+  void CopyContentToAll();
+
+  // Gets the current provider index for a pane
+  size_t GetProviderIndexForPane(int pane_index) const;
+
+  // Sets the provider for a pane by index
+  void SetProviderForPane(int pane_index, size_t provider_index);
+
+  // Gets the provider list
+  const std::vector<LlmProviderInfo>& GetProviders() const { return providers_; }
+
+  // Gets the current number of panes
+  int GetPaneCount() const { return current_pane_count_; }
+
+  // Sets the number of panes (2 or 3)
+  void SetPaneCount(int count);
+
+  // Accessor for owning browser instance.
+  Browser& GetBrowser() const;
+
+  // Creates and registers a side panel entry
+  void CreateAndRegisterEntry(SidePanelRegistry* registry);
+
+  // Gets or creates WebContents for a specific pane
+  content::WebContents* GetOrCreateWebContentsForPane(int pane_index);
+
+  // content::WebContentsDelegate:
+  bool HandleKeyboardEvent(content::WebContents* source,
+                           const input::NativeWebKeyboardEvent& event) override;
+  content::WebContents* AddNewContents(
+      content::WebContents* source,
+      std::unique_ptr<content::WebContents> new_contents,
+      const GURL& target_url,
+      WindowOpenDisposition disposition,
+      const blink::mojom::WindowFeatures& window_features,
+      bool user_gesture,
+      bool* was_blocked) override;
+
+  // views::ViewObserver:
+  void OnViewIsDeleting(views::View* observed_view) override;
+
+  // BrowserListObserver:
+  void OnBrowserRemoved(Browser* browser) override;
+
+  // ProfileObserver:
+  void OnProfileWillBeDestroyed(Profile* profile) override;
+
+  // Static preference registration
+  static void RegisterProfilePrefs(user_prefs::PrefRegistrySyncable* registry);
+
+ private:
+  friend class ClashOfGptsView;
+
+  // Creates the window if it doesn't exist
+  void CreateWindowIfNeeded();
+
+  // Saves the current state to preferences
+  void SaveState();
+
+  // Loads state from preferences
+  void LoadState();
+
+  // Provider management (loads from shared prefs)
+  std::vector<LlmProviderInfo> GetDefaultProviders() const;
+  void LoadProvidersFromPrefs();
+
+  // Clean up WebContents early to avoid shutdown crashes
+  void CleanupWebContents();
+
+  // WebContents observer for a specific pane
+  class PaneWebContentsObserver : public content::WebContentsObserver {
+   public:
+    PaneWebContentsObserver(ClashOfGptsCoordinator* coordinator,
+                           content::WebContents* web_contents);
+    ~PaneWebContentsObserver() override;
+
+    // content::WebContentsObserver:
+    void DidFinishLoad(content::RenderFrameHost* render_frame_host,
+                       const GURL& validated_url) override;
+
+   private:
+    raw_ptr<ClashOfGptsCoordinator> coordinator_;
+  };
+
+  // Shared provider list (loaded from preferences)
+  std::vector<LlmProviderInfo> providers_;
+
+  // Current number of panes (2 or 3)
+  int current_pane_count_ = kDefaultPaneCount;
+
+  // Current provider index selection for each pane (sized for max panes)
+  std::array<size_t, kMaxPanes> pane_provider_indices_;
+
+  // Last URLs for each provider in each pane (pane_index, provider_index)
+  std::map<std::pair<int, size_t>, GURL> last_urls_;
+
+  // The window (delegate) containing the UI
+  std::unique_ptr<ClashOfGptsWindow> window_;
+  
+  // The widget for the window (following CLIENT_OWNS_WIDGET pattern)
+  std::unique_ptr<views::Widget> widget_;
+
+  // Weak pointer to the view (owned by the window)
+  raw_ptr<ClashOfGptsView> view_ = nullptr;
+
+  // WebContents observers for each pane (sized for max panes)
+  std::array<std::unique_ptr<PaneWebContentsObserver>, kMaxPanes> pane_observers_;
+
+  // We need to own the WebContents for each pane because WebView doesn't take ownership
+  // when we call SetWebContents with externally created WebContents
+  std::array<std::unique_ptr<content::WebContents>, kMaxPanes> owned_web_contents_;
+
+  // Observe lifetime of UI views
+  base::ScopedMultiSourceObservation<views::View, views::ViewObserver>
+      view_observation_{this};
+
+  // Observer registrations for early cleanup notifications
+  base::ScopedObservation<BrowserList, BrowserListObserver>
+      browser_list_observation_{this};
+  base::ScopedObservation<Profile, ProfileObserver>
+      profile_observation_{this};
+
+  raw_ptr<Browser> browser_ = nullptr;
+
+  // Handler for unhandled keyboard events
+  views::UnhandledKeyboardEventHandler unhandled_keyboard_event_handler_;
+
+  // Weak pointer factory for callbacks
+  base::WeakPtrFactory<ClashOfGptsCoordinator> weak_factory_{this};
+};
+
+#endif  // CHROME_BROWSER_UI_VIEWS_SIDE_PANEL_CLASH_OF_GPTS_CLASH_OF_GPTS_COORDINATOR_H_
