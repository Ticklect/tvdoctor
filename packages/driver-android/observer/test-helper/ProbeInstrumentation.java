package org.tvdoctor.observer.securityprobe;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Process;
import android.os.SystemClock;
import org.json.JSONObject;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/** Runs in an ordinary application UID, with only INTERNET permission. */
public final class ProbeInstrumentation extends Instrumentation {
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        result.putString("uid", Integer.toString(Process.myUid()));
        String token = new String(new char[64]).replace('\0', 'b');
        try {
            Bundle extras = new Bundle();
            extras.putString("token", token);
            extras.putString("target_package", "org.tvdoctor.observer.securityprobe");
            getTargetContext().getContentResolver().call(
                Uri.parse("content://org.tvdoctor.observer.provisioning"), "provision", null, extras);
            result.putString("provider", "ALLOWED");
        } catch (SecurityException denied) {
            result.putString("provider", "DENIED");
        } catch (Exception unavailable) {
            result.putString("provider", "UNAVAILABLE");
        }
        try {
            Intent setup = new Intent();
            setup.setClassName("org.tvdoctor.observer", "org.tvdoctor.observer.SetupActivity");
            setup.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            setup.putExtra("tvdoctor_token", token);
            getTargetContext().startActivity(setup);
            SystemClock.sleep(600);
            try (Socket socket = new Socket("127.0.0.1", 38337)) {
                socket.setSoTimeout(3000);
                byte[] payload = new JSONObject().put("version", 2).put("id", 1).put("type", "hello")
                    .put("hostVersion", "0.1.0").put("token", token).toString().getBytes(StandardCharsets.UTF_8);
                DataOutputStream output = new DataOutputStream(socket.getOutputStream());
                output.writeInt(payload.length); output.write(payload); output.flush();
                DataInputStream input = new DataInputStream(socket.getInputStream());
                int length = input.readInt();
                if (length <= 0 || length > 65536) throw new IllegalStateException("Bad response size");
                byte[] response = new byte[length]; input.readFully(response);
                boolean accepted = new JSONObject(new String(response, StandardCharsets.UTF_8)).getBoolean("ok");
                result.putString("activity_socket", accepted ? "ALLOWED" : "DENIED");
            }
        } catch (SecurityException denied) {
            result.putString("activity_socket", "DENIED");
        } catch (Exception failure) {
            result.putString("activity_socket", "UNAVAILABLE");
        }
        finish(Activity.RESULT_OK, result);
    }
}
