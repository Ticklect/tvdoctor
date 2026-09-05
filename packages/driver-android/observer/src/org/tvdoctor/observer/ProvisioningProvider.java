package org.tvdoctor.observer;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Binder;
import android.os.Bundle;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Only Android's shell/root/system authority can create a one-use session. */
public final class ProvisioningProvider extends ContentProvider {
    private static final Object LOCK = new Object();
    private static final String PREFERENCES = "observer";
    private static final String TOKEN_KEY = "session_token";
    private static final String TARGET_KEY = "target_package";

    @Override public boolean onCreate() { return true; }

    @Override public Bundle call(String method, String argument, Bundle extras) {
        int uid = Binder.getCallingUid();
        // A manifest permission is defense in depth. The Binder UID remains
        // decisive even if an operator grants a permission to another app.
        if (uid != 0 && uid != 1000 && uid != 2000) {
            throw new SecurityException("Observer provisioning requires Android shell or system authority.");
        }
        if (!"provision".equals(method) || extras == null) throw new IllegalArgumentException("Invalid provisioning request.");
        String token = extras.getString("token");
        String target = extras.getString(TARGET_KEY);
        if (token == null || !token.matches("[0-9a-f]{64}")
            || target == null || target.length() > 255
            || !target.matches("[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+")) {
            throw new IllegalArgumentException("Invalid provisioning values.");
        }
        synchronized (LOCK) {
            if (!preferences(getContext()).edit().clear().putString(TOKEN_KEY, token).putString(TARGET_KEY, target).commit()) {
                throw new IllegalStateException("Observer provisioning could not be stored.");
            }
        }
        Bundle result = new Bundle();
        result.putString("result", "provisioned");
        return result;
    }

    static String consume(Context context, String token) {
        synchronized (LOCK) {
            SharedPreferences preferences = preferences(context);
            String expected = preferences.getString(TOKEN_KEY, "");
            String target = preferences.getString(TARGET_KEY, null);
            if (expected == null || expected.length() != 64 || target == null
                || !MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8), token.getBytes(StandardCharsets.UTF_8))) return null;
            // Persist removal before acknowledging HELLO. Disconnect/restart
            // cannot resurrect the consumed credential or its package binding.
            if (!preferences.edit().clear().commit()) return null;
            return target;
        }
    }

    private static SharedPreferences preferences(Context context) {
        if (context == null) throw new IllegalStateException("Observer context is unavailable.");
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) { throw new SecurityException("Unsupported operation."); }
    @Override public String getType(Uri uri) { return null; }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new SecurityException("Unsupported operation."); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new SecurityException("Unsupported operation."); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new SecurityException("Unsupported operation."); }
}
