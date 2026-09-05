package org.tvdoctor.observer.securityprobe;

import android.app.Activity;
import android.os.Bundle;
import android.text.InputType;
import android.util.Log;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

public final class ProbeActivity extends Activity {
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        TextView marker = new TextView(this);
        marker.setText("TVDOCTOR_PUBLIC_SECURITY_PROBE");
        layout.addView(marker);
        EditText password = new EditText(this);
        password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        password.setText("TVDOCTOR_PASSWORD_SENTINEL");
        password.setContentDescription("TVDOCTOR_PASSWORD_DESCRIPTION");
        layout.addView(password);
        setContentView(layout);
        password.requestFocus();
        Log.i("TVDoctorSecurityProbe", "TVDOCTOR_PUBLIC_SECURITY_LOG");
    }
}
