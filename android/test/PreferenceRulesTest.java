package world.thregren.jubeatviewer;
public final class PreferenceRulesTest {
    public static void main(String[] args) {
        if (!PreferenceRules.allowed("jubeat.marker", "tm0001")) throw new AssertionError();
        for (String key : new String[]{"other", "jubeat.__proto__", "jubeat../secret", "jubeat.unlisted"})
            if (PreferenceRules.allowed(key, "x")) throw new AssertionError(key);
        StringBuilder large = new StringBuilder(); for (int i=0;i<4097;i++) large.append('x');
        if (PreferenceRules.allowed("jubeat.marker", large.toString())) throw new AssertionError();
        System.out.println("Preference key and value boundaries passed");
    }
}
