package world.thregren.jubeatviewer;
import android.content.SharedPreferences;
import android.webkit.JavascriptInterface;
/** Fixed small string preferences persist independently of the local HTTP port. */
public final class PreferencesBridge {
    private final SharedPreferences preferences;
    PreferencesBridge(SharedPreferences preferences) { this.preferences = preferences; }
    private void validate(String key, String value) {
        if (!PreferenceRules.allowed(key, value)) throw new IllegalArgumentException("Invalid viewer preference");
    }
    @JavascriptInterface public String getItem(String key) {
        validate(key, null); return preferences.getString(key, null);
    }
    @JavascriptInterface public void setItem(String key, String value) {
        validate(key, value);
        if (!preferences.edit().putString(key, value).commit()) throw new IllegalStateException("Preference storage unavailable");
    }
    @JavascriptInterface public void removeItem(String key) {
        validate(key, null);
        if (!preferences.edit().remove(key).commit()) throw new IllegalStateException("Preference storage unavailable");
    }
}
