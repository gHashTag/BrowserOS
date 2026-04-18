#ifndef CHROME_BROWSER_BROWSEROS_CORE_BROWSEROS_PREFS_H_
#define CHROME_BROWSER_BROWSEROS_CORE_BROWSEROS_PREFS_H_

namespace browseros {
// Forward declarations
void SyncDefaultTheme(class PrefService*);
bool IsBrowserOSAction(int action_id);
bool ShouldShowToolbarLabels(class Profile*);
}  // namespace browseros

#endif  // CHROME_BROWSER_BROWSEROS_CORE_BROWSEROS_PREFS_H_
