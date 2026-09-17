diff --git a/chrome/browser/extensions/api/browser_os/browser_os_api.cc b/chrome/browser/extensions/api/browser_os/browser_os_api.cc
new file mode 100644
index 0000000000000..7a9f8d92f7668
--- /dev/null
+++ b/chrome/browser/extensions/api/browser_os/browser_os_api.cc
@@ -0,0 +1,492 @@
+// Copyright 2024 The Chromium Authors
+// Use of this source code is governed by a BSD-style license that can be
+// found in the LICENSE file.
+
+#include "chrome/browser/extensions/api/browser_os/browser_os_api.h"
+
+#include <optional>
+#include <string>
+#include <utility>
+#include <vector>
+
+#include "base/files/file_util.h"
+#include "base/functional/bind.h"
+#include "base/logging.h"
+#include "base/strings/utf_string_conversions.h"
+#include "base/values.h"
+#include "base/version_info/version_info.h"
+#include "chrome/browser/browser_process.h"
+#include "chrome/browser/browseros/metrics/browseros_metrics.h"
+#include "chrome/browser/extensions/api/browser_os/browser_os_api_helpers.h"
+#include "chrome/browser/extensions/api/browser_os/browser_os_api_utils.h"
+#include "chrome/browser/platform_util.h"
+#include "chrome/browser/profiles/profile.h"
+#include "chrome/browser/ui/chrome_select_file_policy.h"
+#include "chrome/common/extensions/api/browser_os.h"
+#include "components/prefs/pref_service.h"
+#include "content/public/browser/render_frame_host.h"
+#include "content/public/browser/web_contents.h"
+#include "ui/gfx/geometry/point_f.h"
+#include "ui/shell_dialogs/selected_file_info.h"
+
+namespace extensions {
+namespace api {
+
+namespace {
+
+// Helper to find which PrefService contains a preference
+// Tries Local State first, then Profile prefs
+PrefService* FindPrefService(const std::string& pref_name, Profile* profile) {
+  PrefService* local_state = g_browser_process->local_state();
+  if (local_state && local_state->FindPreference(pref_name)) {
+    return local_state;
+  }
+
+  PrefService* profile_prefs = profile->GetPrefs();
+  if (profile_prefs && profile_prefs->FindPreference(pref_name)) {
+    return profile_prefs;
+  }
+
+  return nullptr;
+}
+
+// Helper to determine preference type name from value
+std::string GetPrefTypeName(const base::Value* value) {
+  switch (value->type()) {
+    case base::Value::Type::BOOLEAN:
+      return "boolean";
+    case base::Value::Type::INTEGER:
+    case base::Value::Type::DOUBLE:
+      return "number";
+    case base::Value::Type::STRING:
+      return "string";
+    case base::Value::Type::LIST:
+      return "list";
+    case base::Value::Type::DICT:
+      return "dictionary";
+    default:
+      return "unknown";
+  }
+}
+
+}  // namespace
+
+// Implementation of BrowserOSGetPageLoadStatusFunction
+
+ExtensionFunction::ResponseAction BrowserOSGetPageLoadStatusFunction::Run() {
+  std::optional<browser_os::GetPageLoadStatus::Params> params =
+      browser_os::GetPageLoadStatus::Params::Create(args());
+  EXTENSION_FUNCTION_VALIDATE(params);
+
+  // Get the target tab
+  std::string error_message;
+  auto tab_info = GetTabFromOptionalId(params->tab_id, browser_context(),
+                                       include_incognito_information(),
+                                       &error_message);
+  if (!tab_info) {
+    return RespondNow(Error(error_message));
+  }
+  
+  content::WebContents* web_contents = tab_info->web_contents;
+  
+  // Get the primary main frame
+  content::RenderFrameHost* rfh = web_contents->GetPrimaryMainFrame();
+  if (!rfh) {
+    return RespondNow(Error("No render frame"));
+  }
+  
+  // Build the status object
+  browser_os::PageLoadStatus status;
+  
+  // Check if any resources are still loading
+  status.is_resources_loading = web_contents->IsLoading();
+  
+  // Check if DOMContentLoaded has fired
+  status.is_dom_content_loaded = rfh->IsDOMContentLoaded();
+  
+  // Check if onload has completed (all resources loaded)
+  status.is_page_complete = rfh->IsDocumentOnLoadCompletedInMainFrame();
+  
+  return RespondNow(ArgumentList(
+      browser_os::GetPageLoadStatus::Results::Create(status)));
+}
+
+// BrowserOSGetPrefFunction
+ExtensionFunction::ResponseAction BrowserOSGetPrefFunction::Run() {
+  std::optional<browser_os::GetPref::Params> params =
+      browser_os::GetPref::Params::Create(args());
+  EXTENSION_FUNCTION_VALIDATE(params);
+
+  Profile* profile = Profile::FromBrowserContext(browser_context());
+  PrefService* prefs = FindPrefService(params->name, profile);
+
+  if (!prefs) {
+    return RespondNow(Error("Preference not found: " + params->name));
+  }
+
+  browser_os::PrefObject pref_obj;
+  pref_obj.key = params->name;
+
+  const base::Value* value = prefs->GetUserPrefValue(params->name);
+  if (!value) {
+    value = prefs->GetDefaultPrefValue(params->name);
+  }
+
+  pref_obj.type = GetPrefTypeName(value);
+  pref_obj.value = value->Clone();
+
+  return RespondNow(ArgumentList(
+      browser_os::GetPref::Results::Create(pref_obj)));
+}
+
+// BrowserOSSetPrefFunction
+ExtensionFunction::ResponseAction BrowserOSSetPrefFunction::Run() {
+  std::optional<browser_os::SetPref::Params> params =
+      browser_os::SetPref::Params::Create(args());
+  EXTENSION_FUNCTION_VALIDATE(params);
+
+  // Security: only allow modifying browseros.* prefs
+  if (!params->name.starts_with("browseros.")) {
+    return RespondNow(Error("Only browseros.* preferences can be modified"));
+  }
+
+  Profile* profile = Profile::FromBrowserContext(browser_context());
+  PrefService* prefs = FindPrefService(params->name, profile);
+
+  if (!prefs) {
+    return RespondNow(Error("Preference not found: " + params->name));
+  }
+
+  prefs->Set(params->name, params->value);
+
+  return RespondNow(ArgumentList(
+      browser_os::SetPref::Results::Create(true)));
+}
+
+// BrowserOSGetAllPrefsFunction
+ExtensionFunction::ResponseAction BrowserOSGetAllPrefsFunction::Run() {
+  Profile* profile = Profile::FromBrowserContext(browser_context());
+  PrefService* profile_prefs = profile->GetPrefs();
+  PrefService* local_state = g_browser_process->local_state();
+
+  // Build a combined browseros prefs dict from both sources
+  base::DictValue combined_browseros;
+
+  // Lambda to merge browseros prefs from a PrefService
+  auto merge_prefs_from_service = [&](PrefService* prefs, const std::string& source_name) {
+    if (!prefs) {
+      return;
+    }
+
+    // Get all preference values (returns nested Dict structure)
+    base::DictValue pref_dict = prefs->GetPreferenceValues(
+        PrefService::INCLUDE_DEFAULTS);
+
+    // Look for "browseros" key in the top-level dict
+    const base::Value* browseros_value = pref_dict.Find("browseros");
+    if (browseros_value && browseros_value->is_dict()) {
+      // Merge this browseros dict into combined
+      combined_browseros.Merge(browseros_value->GetDict().Clone());
+      LOG(INFO) << "[browseros] GetAllPrefs: Found browseros.* prefs in " << source_name;
+    }
+  };
+
+  // Merge from both Local State and Profile prefs
+  merge_prefs_from_service(local_state, "local_state");
+  merge_prefs_from_service(profile_prefs, "profile_prefs");
+
+  // Create single PrefObject with the entire browseros dict
+  std::vector<browser_os::PrefObject> pref_objects;
+  browser_os::PrefObject pref_obj;
+  pref_obj.key = "browseros";
+  pref_obj.type = "dictionary";
+  pref_obj.value = base::Value(std::move(combined_browseros));
+  pref_objects.push_back(std::move(pref_obj));
+
+  return RespondNow(ArgumentList(
+      browser_os::GetAllPrefs::Results::Create(pref_objects)));
+}
+
+// BrowserOSLogMetricFunction
+ExtensionFunction::ResponseAction BrowserOSLogMetricFunction::Run() {
+  std::optional<browser_os::LogMetric::Params> params =
+      browser_os::LogMetric::Params::Create(args());
+  EXTENSION_FUNCTION_VALIDATE(params);
+
+  const std::string& event_name = params->event_name;
+  
+  // Add "extension." prefix to distinguish from native events
+  std::string prefixed_event = "extension." + event_name;
+  
+  if (params->properties.has_value()) {
+    // The properties parameter is a Properties struct with additional_properties member
+    base::DictValue properties = params->properties->additional_properties.Clone();
+    
+    // Add extension ID as a property
+    properties.Set("extension_id", extension_id());
+    
+    browseros_metrics::BrowserOSMetrics::Log(prefixed_event, std::move(properties));
+  } else {
+    // No properties, just log with extension ID
+    browseros_metrics::BrowserOSMetrics::Log(prefixed_event, {
+      {"extension_id", base::Value(extension_id())}
+    });
+  }
+  
+  // Return void callback
+  return RespondNow(NoArguments());
+}
+
+// BrowserOSGetVersionNumberFunction
+ExtensionFunction::ResponseAction BrowserOSGetVersionNumberFunction::Run() {
+  // Get the version number from version_info
+  std::string version = std::string(version_info::GetVersionNumber());
+
+  return RespondNow(ArgumentList(
+      browser_os::GetVersionNumber::Results::Create(version)));
+}
+
+// BrowserOSGetBrowserosVersionNumberFunction
+ExtensionFunction::ResponseAction BrowserOSGetBrowserosVersionNumberFunction::Run() {
+  std::string version = std::string(version_info::GetBrowserOSVersionNumber());
+
+  return RespondNow(ArgumentList(
+      browser_os::GetBrowserosVersionNumber::Results::Create(version)));
+}
+
+// BrowserOSExecuteJavaScriptFunction
+ExtensionFunction::ResponseAction BrowserOSExecuteJavaScriptFunction::Run() {
+  std::optional<browser_os::ExecuteJavaScript::Params> params =
+      browser_os::ExecuteJavaScript::Params::Create(args());
+  EXTENSION_FUNCTION_VALIDATE(params);
+
+  // Get the target tab
+  std::string error_message;
+  auto tab_info = GetTabFromOptionalId(params->tab_id, browser_context(),
+                                       include_incognito_information(),
+                                       &error_message);
+  if (!tab_info) {
+    return RespondNow(Error(error_message));
+  }
+  
+  content::WebContents* web_contents = tab_info->web_contents;
+  
+  // Get the primary main frame
+  content::RenderFrameHost* rfh = web_contents->GetPrimaryMainFrame();
+  if (!rfh) {
+    return RespondNow(Error("No render frame"));
+  }
+  
+  LOG(INFO) << "[browseros] ExecuteJavaScript: Executing code in tab " << tab_info->tab_id;
+  
+  // Convert JavaScript code string to UTF16
+  std::u16string js_code = base::UTF8ToUTF16(params->code);
+  
+  // Execute the JavaScript code using ExecuteJavaScriptForTests
+  // This will return the result of the execution
+  rfh->ExecuteJavaScriptForTests(
+      js_code,
+      base::BindOnce(&BrowserOSExecuteJavaScriptFunction::OnJavaScriptExecuted,
+                     this),
+      /*honor_js_content_settings=*/false);
+  
+  return RespondLater();
+}
+
+void BrowserOSExecuteJavaScriptFunction::OnJavaScriptExecuted(base::Value result) {
+  LOG(INFO) << "[browseros] ExecuteJavaScript: Execution completed";
+
+  if (result.is_none()) {
+      // JavaScript returned undefined or execution failed
+      // Return an empty object instead of NONE to satisfy the validator
+      result = base::Value(base::Value::Type::DICT);
+  }
+  
+  // Return the result directly
+  Respond(ArgumentList(
+      browser_os::ExecuteJavaScript::Results::Create(result)));
+}
+
+// Implementation of BrowserOSClickCoordinatesFunction
+ExtensionFunction::ResponseAction BrowserOSClickCoordinatesFunction::Run() {
+  std::optional<browser_os::ClickCoordinates::Params> params =
+      browser_os::ClickCoordinates::Params::Create(args());
+  EXTENSION_FUNCTION_VALIDATE(params);
+
+  // Get the target tab
+  std::string error_message;
+  auto tab_info = GetTabFromOptionalId(params->tab_id, browser_context(),
+                                       include_incognito_information(),
+                                       &error_message);
+  if (!tab_info) {
+    LOG(ERROR) << "[browseros] ClickCoordinates: " << error_message;
+    browser_os::InteractionResponse response;
+    response.success = false;
+    return RespondNow(ArgumentList(
+        browser_os::ClickCoordinates::Results::Create(response)));
+  }
+  
+  content::WebContents* web_contents = tab_info->web_contents;
+  
+  // Create the click point from the coordinates
+  gfx::PointF click_point(params->x, params->y);
+  
+  LOG(INFO) << "[browseros] ClickCoordinates: Clicking at (" 
+            << params->x << ", " << params->y << ")";
+  
+  // Perform the click with change detection
+  bool success = ClickCoordinatesWithDetection(web_contents, click_point);
+  
+  // Prepare the response
+  browser_os::InteractionResponse response;
+  response.success = success;
+  
+  LOG(INFO) << "[browseros] ClickCoordinates: Result = " 
+            << (success ? "success" : "no change detected");
+  
+  return RespondNow(ArgumentList(
+      browser_os::ClickCoordinates::Results::Create(response)));
+}
+
+// Implementation of BrowserOSTypeAtCoordinatesFunction  
+ExtensionFunction::ResponseAction BrowserOSTypeAtCoordinatesFunction::Run() {
+  std::optional<browser_os::TypeAtCoordinates::Params> params =
+      browser_os::TypeAtCoordinates::Params::Create(args());
+  EXTENSION_FUNCTION_VALIDATE(params);
+
+  // Get the target tab
+  std::string error_message;
+  auto tab_info = GetTabFromOptionalId(params->tab_id, browser_context(),
+                                       include_incognito_information(),
+                                       &error_message);
+  if (!tab_info) {
+    LOG(ERROR) << "[browseros] TypeAtCoordinates: " << error_message;
+    browser_os::InteractionResponse response;
+    response.success = false;
+    return RespondNow(ArgumentList(
+        browser_os::TypeAtCoordinates::Results::Create(response)));
+  }
+  
+  content::WebContents* web_contents = tab_info->web_contents;
+  
+  // Create the click point from the coordinates
+  gfx::PointF click_point(params->x, params->y);
+  
+  LOG(INFO) << "[browseros] TypeAtCoordinates: Clicking at (" 
+            << params->x << ", " << params->y << ") and typing: " << params->text;
+  
+  // Perform the click and type operation
+  bool success = TypeAtCoordinatesWithDetection(web_contents, click_point, params->text);
+  
+  // Prepare the response
+  browser_os::InteractionResponse response;
+  response.success = success;
+  
+  LOG(INFO) << "[browseros] TypeAtCoordinates: Result = " 
+            << (success ? "success" : "failed");
+  
+  return RespondNow(ArgumentList(
+      browser_os::TypeAtCoordinates::Results::Create(response)));
+}
+
+// BrowserOSChoosePathFunction implementation
+
+namespace {
+
+constexpr char kCouldNotShowSelectFileDialogError[] =
+    "Could not show file dialog";
+
+ui::SelectFileDialog::Type GetDialogType(
+    const std::optional<browser_os::SelectionType>& type) {
+  if (type.has_value() && *type == browser_os::SelectionType::kFolder) {
+    return ui::SelectFileDialog::SELECT_FOLDER;
+  }
+  // Default: file
+  return ui::SelectFileDialog::SELECT_OPEN_FILE;
+}
+
+}  // namespace
+
+BrowserOSChoosePathFunction::BrowserOSChoosePathFunction() = default;
+
+BrowserOSChoosePathFunction::~BrowserOSChoosePathFunction() {
+  // Clean up pending file dialogs to prevent callbacks to a destroyed object.
+  if (select_file_dialog_.get()) {
+    select_file_dialog_->ListenerDestroyed();
+  }
+}
+
+ExtensionFunction::ResponseAction BrowserOSChoosePathFunction::Run() {
+  std::optional<browser_os::ChoosePath::Params> params =
+      browser_os::ChoosePath::Params::Create(args());
+  EXTENSION_FUNCTION_VALIDATE(params);
+
+  content::WebContents* web_contents = GetSenderWebContents();
+  if (!web_contents) {
+    return RespondNow(Error(kCouldNotShowSelectFileDialogError));
+  }
+
+  // Determine dialog type based on options
+  ui::SelectFileDialog::Type dialog_type = ui::SelectFileDialog::SELECT_OPEN_FILE;
+  std::u16string title;
+  base::FilePath starting_path;
+
+  if (params->options) {
+    dialog_type = GetDialogType(params->options->type);
+
+    if (params->options->title) {
+      title = base::UTF8ToUTF16(*params->options->title);
+    }
+
+    if (params->options->starting_directory) {
+      starting_path =
+          base::FilePath::FromUTF8Unsafe(*params->options->starting_directory);
+      // Validate path exists; if not, use empty path (OS default)
+      if (!base::DirectoryExists(starting_path)) {
+        starting_path = base::FilePath();
+      }
+    }
+  }
+
+  // Get parent window for the dialog
+  gfx::NativeWindow owning_window =
+      platform_util::GetTopLevel(web_contents->GetNativeView());
+
+  // Create and show the file dialog
+  select_file_dialog_ = ui::SelectFileDialog::Create(
+      this, std::make_unique<ChromeSelectFilePolicy>(web_contents));
+
+  select_file_dialog_->SelectFile(
+      dialog_type,
+      title,
+      starting_path,
+      nullptr,  // file_types
+      0,        // file_type_index
+      base::FilePath::StringType(),  // default_extension
+      owning_window);
+
+  // prevent destruction while dialog is showing
+  AddRef();
+  return RespondLater();
+}
+
+void BrowserOSChoosePathFunction::FileSelected(const ui::SelectedFileInfo& file,
+                                               int index) {
+  browser_os::SelectedPath result;
+  result.path = file.path().AsUTF8Unsafe();
+  result.name = file.path().BaseName().AsUTF8Unsafe();
+
+  Respond(ArgumentList(browser_os::ChoosePath::Results::Create(result)));
+  Release();
+}
+
+void BrowserOSChoosePathFunction::FileSelectionCanceled() {
+  // Return null to indicate cancellation (not an error)
+  base::ListValue results;
+  results.Append(base::Value());
+  Respond(ArgumentList(std::move(results)));
+  Release();
+}
+
+}  // namespace api
+}  // namespace extensions
