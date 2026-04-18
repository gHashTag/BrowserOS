diff --git a/chrome/browser/browseros/core/browseros_prefs.cc b/chrome/browser/browseros/core/browseros_prefs.cc
index 0000000000000..c191fb3963968
--- /dev/null
+++ b/chrome/browser/browseros/core/browseros_prefs.cc
@@ -0,0 +1,100 @@
+// Copyright 2025 The Chromium Authors
+// Use of this source code is governed by a BSD-style license that can be
+// found in the LICENSE file.
+
+#include "chrome/browser/browseros/generated/trios_tokens.h"
+
+#include "chrome/browser/ui/actions/chrome_action_id.h"
+#include "chrome/common/pref_names.h"
+#include "components/pref_registry/pref_registry_syncable.h"
+#include "third_party/skia/include/core/SkColor.h"
+#include "ui/base/mojom/themes.mojom.h"
+
+namespace trios {
+
+namespace prefs {
+
+// Toolbar visibility prefs
+inline constexpr char kShowLLMChat[] = "browseros.show_llm_chat";
+
+// Vertical tabs pref
+inline constexpr char kVerticalTabsEnabled[] = "browseros.vertical_tabs_enabled";
+
+// AI Provider prefs
+inline constexpr char kProviders[] = "browseros.providers";
+inline constexpr char kCustomProviders[] = "browseros.custom_providers";
+inline constexpr char kDefaultProviderId[] = "browseros.default_provider_id";
+
+// NTP focus pref
+inline constexpr char kNtpFocusContent[] = "browseros.ntp_focus_content";
+}
+
+void RegisterProfilePrefs(user_prefs::PrefRegistrySyncable* registry) {
+  // Toolbar visibility prefs
+  registry->RegisterBooleanPref(prefs::kShowLLMChat, true);
+  registry->RegisterBooleanPref(prefs::kShowLLMHub, true);
+  registry->RegisterBooleanPref(prefs::kShowToolbarLabels, true);
+
+  // Vertical tabs pref
+  registry->RegisterBooleanPref(prefs::kVerticalTabsEnabled, true);
+
+  // AI Provider prefs
+  registry->RegisterStringPref(prefs::kProviders, "");
+  registry->RegisterStringPref(prefs::kCustomProviders, "[]");
+  registry->RegisterStringPref(prefs::kDefaultProviderId, "");
+
+  // NTP focus pref
+  registry->RegisterBooleanPref(prefs::kNtpFocusContent, false);
+}
+
+bool ShouldShowLLMChat(PrefService* pref_service) {
+  return pref_service->GetBoolean(prefs::kShowLLMChat);
+}
+
+bool ShouldShowLLMHub(PrefService* pref_service) {
+  return pref_service->GetBoolean(prefs::kShowLLMHub);
+}
+
+bool ShouldShowToolbarLabels(PrefService* pref_service) {
+  return pref_service->GetBoolean(prefs::kShowToolbarLabels);
+}
+
+bool IsVerticalTabsEnabled(PrefService* pref_service) {
+  return pref_service->GetBoolean(prefs::kVerticalTabsEnabled);
+}
+
+void SyncVerticalTabsPref(PrefService* pref_service) {
+  bool vertical_tabs = IsVerticalTabsEnabled(pref_service);
+  pref_service->SetInteger(::prefs::kVerticalTabsEnabled, vertical_tabs);
+}
+
+void SyncDefaultTheme(PrefService* pref_service) {
+  const PrefService::Preference* user_color_pref =
+      pref_service->FindPreference(::prefs::kUserColor);
+  if (user_color_pref && user_color_pref->IsDefaultValue()) {
+    // Use TRIOS pure black seed from generated tokens
+    pref_service->SetInteger(::prefs::kUserColor,
+                             static_cast<int>(trios::kFrameSeedColor));
+    pref_service->SetString(::prefs::kCurrentThemeID, "trios_tokens_id");
+    pref_service->SetInteger(
+        ::prefs::kBrowserColorVariant,
+        static_cast<int>(ui::mojom::BrowserColorVariant::kNeutral));
+  }
+}
+
+bool ShouldShowToolbarAction(actions::ActionId id, PrefService* pref_service) {
+  const char* pref_key = GetVisibilityPrefForAction(id);
+  if (!pref_key) {
+    return true;  // No pref means always visible
+  }
+  return pref_service->GetBoolean(pref_key);
+}
+
+bool IsNtpFocusContentEnabled(PrefService* pref_service) {
+  return pref_service->GetBoolean(prefs::kNtpFocusContent);
+}
+
+const char* GetVisibilityPrefForAction(actions::ActionId id) {
+  switch (id) {
+    case kActionSidePanelShowThirdPartyLlm:
+      return prefs::kShowLLMChat;
+    case kActionSidePanelShowClashOfGpts:
+      return prefs::kShowLLMHub;
+    default:
+      return nullptr;
+  }
+}
+
+}  // namespace trios
