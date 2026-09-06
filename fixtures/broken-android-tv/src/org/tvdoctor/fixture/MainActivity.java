package org.tvdoctor.fixture;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Minimal native TV surface with exactly one deliberate defect. Selecting the
 * Focus Probe clears focus while Safe Control remains visible and focusable.
 */
public final class MainActivity extends Activity {
    private static final String LOG_TAG = "TVDoctorFixture";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setId(R.id.fixture_root);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_VERTICAL);
        root.setPadding(dp(112), dp(72), dp(112), dp(72));
        root.setBackgroundColor(getColor(R.color.fixture_background));
        root.setFocusable(false);
        root.setContentDescription("TVDoctor controlled Android TV fixture");

        TextView heading = text(R.id.fixture_heading, R.string.heading, 42, R.color.fixture_text);
        heading.setTypeface(heading.getTypeface(), android.graphics.Typeface.BOLD);
        root.addView(heading, matchWrap());

        TextView instructions = text(
            R.id.fixture_instructions,
            R.string.instructions,
            22,
            R.color.fixture_text_muted
        );
        LinearLayout.LayoutParams instructionsLayout = matchWrap();
        instructionsLayout.topMargin = dp(14);
        root.addView(instructions, instructionsLayout);

        LinearLayout controls = new LinearLayout(this);
        controls.setId(R.id.control_row);
        controls.setOrientation(LinearLayout.HORIZONTAL);
        controls.setGravity(Gravity.CENTER_VERTICAL);
        controls.setFocusable(false);
        LinearLayout.LayoutParams controlsLayout = matchWrap();
        controlsLayout.topMargin = dp(54);
        root.addView(controls, controlsLayout);

        Button focusProbe = button(
            R.id.focus_probe,
            R.string.focus_probe,
            R.string.focus_probe_description
        );
        Button safeControl = button(
            R.id.safe_control,
            R.string.safe_control,
            R.string.safe_control_description
        );
        focusProbe.setNextFocusRightId(R.id.safe_control);
        safeControl.setNextFocusLeftId(R.id.focus_probe);
        focusProbe.setNextFocusLeftId(R.id.focus_probe);
        focusProbe.setNextFocusUpId(R.id.focus_probe);
        focusProbe.setNextFocusDownId(R.id.focus_probe);
        safeControl.setNextFocusRightId(R.id.safe_control);
        safeControl.setNextFocusUpId(R.id.safe_control);
        safeControl.setNextFocusDownId(R.id.safe_control);

        controls.addView(focusProbe, new LinearLayout.LayoutParams(dp(360), dp(116)));
        LinearLayout.LayoutParams safeLayout = new LinearLayout.LayoutParams(dp(360), dp(116));
        safeLayout.leftMargin = dp(34);
        controls.addView(safeControl, safeLayout);

        TextView status = text(R.id.fixture_status, R.string.status_ready, 21, R.color.fixture_accent);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        LinearLayout.LayoutParams statusLayout = matchWrap();
        statusLayout.topMargin = dp(40);
        root.addView(status, statusLayout);

        View focusSink = new View(this);
        focusSink.setId(R.id.focus_sink);
        focusSink.setAlpha(0f);
        focusSink.setFocusable(true);
        focusSink.setFocusableInTouchMode(true);
        focusSink.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        root.addView(focusSink, new LinearLayout.LayoutParams(1, 1));

        focusProbe.setOnClickListener((view) -> {
            status.setText(R.string.status_lost);
            // Deliberate seed: move input focus to a transparent view that is
            // excluded from accessibility. The visible semantic surface stays
            // unchanged, while no meaningful remote focus target remains.
            boolean diverted = focusSink.requestFocus();
            Log.i(LOG_TAG, "Seeded focus-loss transition activated; diverted=" + diverted);
        });
        safeControl.setOnClickListener((view) -> {
            status.setText(R.string.status_safe);
            Log.i(LOG_TAG, "Safe control selected with focus retained");
        });

        setContentView(root);
        focusProbe.post(() -> {
            boolean focused = focusProbe.requestFocus();
            Log.i(LOG_TAG, "Fixture launched; initial focus=" + focused);
        });
    }

    private Button button(int id, int label, int description) {
        Button button = new Button(this);
        button.setId(id);
        button.setText(label);
        button.setContentDescription(getString(description));
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 23);
        button.setTextColor(getColorStateList(R.color.button_text));
        button.setBackgroundResource(R.drawable.button_background);
        button.setAllCaps(false);
        button.setGravity(Gravity.CENTER);
        button.setFocusable(true);
        button.setFocusableInTouchMode(false);
        button.setEnabled(true);
        return button;
    }

    private TextView text(int id, int text, int sizeSp, int colour) {
        TextView view = new TextView(this);
        view.setId(id);
        view.setText(text);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        view.setTextColor(getColor(colour));
        view.setFocusable(false);
        return view;
    }

    private LinearLayout.LayoutParams matchWrap() {
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
