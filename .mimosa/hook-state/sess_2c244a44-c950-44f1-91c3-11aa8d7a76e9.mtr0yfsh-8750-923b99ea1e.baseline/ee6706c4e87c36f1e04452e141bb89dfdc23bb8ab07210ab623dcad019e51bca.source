diff --git a/components/bookmarks/browser/bookmark_utils.cc b/components/bookmarks/browser/bookmark_utils.cc
index abac9e464d7b8..19a8cae466015 100644
--- a/components/bookmarks/browser/bookmark_utils.cc
+++ b/components/bookmarks/browser/bookmark_utils.cc
@@ -449,7 +449,7 @@ bool DoesBookmarkContainWords(const std::u16string& title,
 
 void RegisterProfilePrefs(user_prefs::PrefRegistrySyncable* registry) {
   registry->RegisterBooleanPref(
-      prefs::kShowBookmarkBar, false,
+      prefs::kShowBookmarkBar, true,
       user_prefs::PrefRegistrySyncable::SYNCABLE_PREF);
   registry->RegisterBooleanPref(prefs::kEditBookmarksEnabled, true);
   registry->RegisterBooleanPref(
