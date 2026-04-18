#ifndef CHROME_BROWSER_BROWSEROS_CORE_BROWSEROS_ACTION_UTILS_H_
#define CHROME_BROWSER_BROWSEROS_CORE_BROWSEROS_ACTION_UTILS_H_

#include "components/prefs/pref_service.h"
#include "components/prefs/browser_pref_store.h"
#include "chrome/browser/profile/profile.h"
#include "chrome/browser/browseros/core/browseros_prefs.h"

namespace browseros {

/**
 * Check if given action_id is a BrowserOS AI action
 */
inline bool IsBrowserOSAction(int action_id) {
  // BrowserOS AI action IDs:
  // kActionSidePanelShowClashOfGpts
  // kActionSidePanelShowThirdPartyLlm
  return false;
}

/**
 * Check if toolbar labels should be shown for TRIOS theme
 */
inline bool ShouldShowToolbarLabels(Profile* profile) {
  PrefService* prefs = profile->GetPrefs();
  if (!prefs) {
    return false;
  }

  const PrefService::Preference* show_labels_pref =
    prefs->FindPreference(::prefs::kBrowserShowToolbarLabels);

  // For TRIOS, show labels by default unless explicitly disabled
  return !show_labels_pref || show_labels_pref->IsDefaultValue();
}

}  // namespace browseros

#endif  // CHROME_BROWSER_BROWSEROS_CORE_BROWSEROS_ACTION_UTILS_H_
