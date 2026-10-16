package world.thregren.jubeatviewer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
/** The bridge exposes viewer settings only, never paths or arbitrary preference names. */
public final class PreferenceRules {
    private static final Set<String> KEYS = new HashSet<String>(Arrays.asList(
        "markerNormalSpeed", "marker", "metroSound", "metroVolume", "showCombo", "firstMarker", "showNumbers",
        "numScale", "numAlpha", "numGlowAlpha", "numCorner", "numColorMode", "numColor", "showChordGlow",
        "chordGlowStyle", "phraseMult", "phraseFloor", "phraseMax", "chordGlowPair", "settingsVersion",
        "autoPreview", "collapsed", "sort", "holdFilter"));
    private PreferenceRules() {}
    public static boolean allowed(String key, String value) {
        return key != null && key.startsWith("jubeat.") && KEYS.contains(key.substring(7)) &&
            (value == null || value.getBytes(StandardCharsets.UTF_8).length <= 4096);
    }
}
