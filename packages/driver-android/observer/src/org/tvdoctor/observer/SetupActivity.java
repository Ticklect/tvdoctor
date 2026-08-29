package org.tvdoctor.observer;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public final class SetupActivity extends Activity {
    static final String PREFERENCES = "observer";
    static final String TOKEN_KEY = "session_token";
    static final String TOKEN_EXTRA = "tvdoctor_token";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (storeToken(getIntent()) && isServiceEnabled()) {
            finish();
            return;
        }
        render();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (storeToken(intent) && isServiceEnabled()) {
            finish();
            return;
        }
        render();
    }

    private boolean storeToken(Intent intent) {
        String token = intent.getStringExtra(TOKEN_EXTRA);
        if (token != null && token.matches("[0-9a-f]{64}")) {
            return getSharedPreferences(PREFERENCES, MODE_PRIVATE)
                .edit()
                .putString(TOKEN_KEY, token)
                .commit();
        }
        return false;
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (!isFinishing()) render();
    }

    private void render() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_VERTICAL);
        root.setPadding(dp(96), dp(64), dp(96), dp(64));
        root.setBackgroundColor(Color.rgb(14, 20, 30));

        TextView title = text("TVDoctor Observer", 38, Color.WHITE);
        root.addView(title);
        boolean enabled = isServiceEnabled();
        TextView status = text(
            enabled ? "Observer access is enabled." : "Observer access is required before Android testing can begin.",
            24,
            enabled ? Color.rgb(92, 220, 154) : Color.rgb(255, 196, 92)
        );
        LinearLayout.LayoutParams statusLayout = wrap();
        statusLayout.topMargin = dp(24);
        root.addView(status, statusLayout);
        TextView privacy = text(
            "TVDoctor uses Android accessibility data to observe focus, windows, and visible controls. "
                + "It does not modify the app under test or expose its loopback server to the device network.",
            20,
            Color.LTGRAY
        );
        LinearLayout.LayoutParams privacyLayout = wrap();
        privacyLayout.topMargin = dp(18);
        root.addView(privacy, privacyLayout);

        Button settings = new Button(this);
        settings.setText(enabled ? "Review accessibility access" : "Enable observer access");
        settings.setTextSize(TypedValue.COMPLEX_UNIT_SP, 21);
        settings.setOnClickListener(view -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        LinearLayout.LayoutParams buttonLayout = new LinearLayout.LayoutParams(dp(420), dp(96));
        buttonLayout.topMargin = dp(34);
        root.addView(settings, buttonLayout);
        setContentView(root);
        settings.requestFocus();
    }

    private boolean isServiceEnabled() {
        String enabledServices = Settings.Secure.getString(
            getContentResolver(),
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        );
        if (TextUtils.isEmpty(enabledServices)) return false;
        ComponentName expected = new ComponentName(this, ObserverAccessibilityService.class);
        for (String enabled : enabledServices.split(":")) {
            ComponentName candidate = ComponentName.unflattenFromString(enabled);
            if (expected.equals(candidate)) return true;
        }
        return false;
    }

    private TextView text(String value, int sizeSp, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        view.setTextColor(color);
        return view;
    }

    private LinearLayout.LayoutParams wrap() {
        return new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value,
            getResources().getDisplayMetrics()
        ));
    }
}
