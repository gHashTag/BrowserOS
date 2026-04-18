#include "chrome/browser/browseros/theme/trios_theme.h"
#include "chrome/browser/browser/prefs/pref_service.h"
#include "chrome/browser/browser/prefs/browser_pref_store.h"

namespace browseros {

/**
 * Sync default TRIOS theme on first run
 */
void SyncDefaultTheme(PrefService* pref_service) {
  const PrefService::Preference* user_color_pref =
    pref_service->FindPreference(::prefs::kUserColor);
  if (user_color_pref && user_color_pref->IsDefaultValue()) {
    pref_service->SetInteger(::prefs::kUserColor, 0xFF000000);
    pref_service->SetString(::prefs::kCurrentThemeID, "trios_theme_id");
    pref_service->SetInteger(::prefs::kBrowserColorVariant,
        static_cast<int>(ui::mojom::BrowserColorVariant::kMonochrome));
  }
}

}  // namespace browseros
