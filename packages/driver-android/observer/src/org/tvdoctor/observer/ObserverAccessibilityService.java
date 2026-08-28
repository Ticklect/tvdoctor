package org.tvdoctor.observer;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

public final class ObserverAccessibilityService extends AccessibilityService {
    private static final int PROTOCOL_VERSION = 2;
    private static final int PORT = 38_337;
    private static final int MAX_FRAME_BYTES = 2 * 1024 * 1024;
    private static final int MAX_NODES = 4_096;
    private static final int MAX_DEPTH = 64;
    private static final int MAX_STRING = 1_024;
    private static final String OBSERVER_VERSION = "0.1.5";

    private final AtomicLong eventSequence = new AtomicLong();
    private final AtomicBoolean running = new AtomicBoolean();
    private final Map<Long, ActionContext> actions = new ConcurrentHashMap<>();
    private final Set<Long> cancelledRequests = ConcurrentHashMap.newKeySet();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile long lastEventElapsedMs;
    private volatile String lastPackageName;
    private volatile String lastWindowClassName;
    private volatile int lastWindowId = -1;
    private volatile String lastStructureFingerprint = "";
    private volatile String lastStateFingerprint = "";
    private ServerSocket serverSocket;
    private Thread serverThread;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        startServer();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        long now = SystemClock.elapsedRealtime();
        long sequence = eventSequence.incrementAndGet();
        lastEventElapsedMs = now;
        CharSequence packageName = event.getPackageName();
        CharSequence className = event.getClassName();
        if (packageName != null) lastPackageName = bounded(packageName.toString());
        if (className != null && event.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            lastWindowClassName = bounded(className.toString());
        }
        lastWindowId = event.getWindowId();
        for (ActionContext action : actions.values()) {
            if (sequence > action.baselineSequence && action.firstEventElapsedMs < 0) {
                action.firstEventElapsedMs = now;
            }
        }
        synchronized (eventSequence) {
            eventSequence.notifyAll();
        }
    }

    @Override
    public void onInterrupt() {
        synchronized (eventSequence) {
            eventSequence.notifyAll();
        }
    }

    @Override
    public void onDestroy() {
        stopServer();
        super.onDestroy();
    }

    private void startServer() {
        if (!running.compareAndSet(false, true)) return;
        serverThread = new Thread(this::serverLoop, "tvdoctor-observer-server");
        serverThread.setDaemon(true);
        serverThread.start();
    }

    private void stopServer() {
        running.set(false);
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {
            // Android owns service teardown; there is no caller to notify here.
        }
        synchronized (eventSequence) {
            eventSequence.notifyAll();
        }
    }

    private void serverLoop() {
        try (ServerSocket server = new ServerSocket(PORT, 1, InetAddress.getByName("127.0.0.1"))) {
            server.setReuseAddress(true);
            serverSocket = server;
            while (running.get()) {
                try (Socket socket = server.accept()) {
                    socket.setTcpNoDelay(true);
                    serveConnection(socket);
                } catch (IOException error) {
                    if (running.get()) System.err.println("TVDoctor observer connection ended.");
                }
            }
        } catch (IOException error) {
            if (running.get()) System.err.println("TVDoctor observer server could not bind loopback.");
        } finally {
            running.set(false);
            serverSocket = null;
        }
    }

    private void serveConnection(Socket socket) throws IOException {
        DataInputStream input = new DataInputStream(new BufferedInputStream(socket.getInputStream()));
        DataOutputStream output = new DataOutputStream(new BufferedOutputStream(socket.getOutputStream()));
        AtomicBoolean authenticated = new AtomicBoolean(false);
        Object outputLock = new Object();
        ThreadPoolExecutor workers = new ThreadPoolExecutor(
            2,
            4,
            10,
            TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(16),
            runnable -> {
                Thread thread = new Thread(runnable, "tvdoctor-observer-request");
                thread.setDaemon(true);
                return thread;
            },
            new ThreadPoolExecutor.AbortPolicy()
        );
        try {
            while (running.get() && !socket.isClosed()) {
                int length;
                try {
                    length = input.readInt();
                } catch (EOFException end) {
                    break;
                }
                if (length <= 0 || length > MAX_FRAME_BYTES) throw new IOException("Invalid frame length.");
                byte[] payload = new byte[length];
                input.readFully(payload);
                final JSONObject request;
                try {
                    request = new JSONObject(new String(payload, StandardCharsets.UTF_8));
                } catch (JSONException error) {
                    throw new IOException("Malformed observer JSON.", error);
                }
                try {
                    workers.execute(() -> {
                        JSONObject response = handleRequest(request, authenticated);
                        try {
                            writeFrame(output, outputLock, response);
                        } catch (IOException ignored) {
                            try {
                                socket.close();
                            } catch (IOException ignoredClose) {
                                // Socket is already unusable.
                            }
                        }
                    });
                } catch (RuntimeException rejected) {
                    writeFrame(output, outputLock, errorResponse(request.optLong("id", 0), "busy", "Observer request capacity is exhausted."));
                }
            }
        } finally {
            workers.shutdownNow();
            actions.clear();
            cancelledRequests.clear();
        }
    }

    private JSONObject handleRequest(JSONObject request, AtomicBoolean authenticated) {
        long id = request.optLong("id", -1);
        try {
            if (request.optInt("version", -1) != PROTOCOL_VERSION) {
                return errorResponse(Math.max(0, id), "protocol_version", "Unsupported observer protocol version.");
            }
            if (id < 0) return errorResponse(0, "invalid_id", "Request id must be non-negative.");
            String type = requiredString(request, "type", 64);
            if (!authenticated.get() && !"hello".equals(type)) {
                return errorResponse(id, "authentication_required", "HELLO must be the first request.");
            }
            switch (type) {
                case "hello": return hello(request, authenticated, id);
                case "ping": return ok(id, "pong");
                case "device_info": return deviceInfo(id);
                case "current_state": return stateResponse(id, "current_state", captureOnMain(request.optBoolean("forceFull", false)));
                case "begin_action": return beginAction(request, id);
                case "settle_action": return settleAction(request, id);
                case "resync": return resync(id);
                case "cancel": return cancel(request, id);
                case "shutdown": return shutdown(id);
                default: return errorResponse(id, "unknown_operation", "Unsupported observer operation.");
            }
        } catch (Exception error) {
            String message = error.getMessage() == null ? "Observer operation failed." : bounded(error.getMessage());
            return errorResponse(Math.max(0, id), "operation_failed", message);
        }
    }

    private JSONObject hello(JSONObject request, AtomicBoolean authenticated, long id) throws JSONException {
        String token = requiredString(request, "token", 256);
        requiredString(request, "hostVersion", 64);
        String expected = getSharedPreferences(SetupActivity.PREFERENCES, MODE_PRIVATE)
            .getString(SetupActivity.TOKEN_KEY, "");
        if (expected == null || expected.length() != 64 || !constantTimeEquals(expected, token)) {
            return errorResponse(id, "authentication_failed", "Observer session token was rejected.");
        }
        authenticated.set(true);
        return ok(id, "hello")
            .put("protocolVersion", PROTOCOL_VERSION)
            .put("observerVersion", OBSERVER_VERSION)
            .put("serviceEnabled", true);
    }

    private JSONObject deviceInfo(long id) throws JSONException {
        JSONObject device = new JSONObject()
            .put("manufacturer", bounded(Build.MANUFACTURER))
            .put("model", bounded(Build.MODEL))
            .put("sdkLevel", Build.VERSION.SDK_INT)
            .put("release", bounded(Build.VERSION.RELEASE))
            .put("fingerprint", bounded(Build.FINGERPRINT));
        return ok(id, "device_info").put("device", device);
    }

    private JSONObject beginAction(JSONObject request, long id) throws Exception {
        String key = requiredString(request, "key", 16);
        if (!key.matches("UP|DOWN|LEFT|RIGHT|SELECT|BACK")) {
            return errorResponse(id, "invalid_key", "Unsupported remote key.");
        }
        if (lastStateFingerprint.isEmpty()) captureOnMain(false);
        ActionContext context = new ActionContext(
            id,
            eventSequence.get(),
            SystemClock.elapsedRealtime(),
            lastStateFingerprint
        );
        if (actions.size() >= 32) actions.clear();
        actions.put(id, context);
        return ok(id, "begin_action")
            .put("actionId", id)
            .put("baselineSequence", context.baselineSequence);
    }

    private JSONObject settleAction(JSONObject request, long requestId) throws Exception {
        long actionId = request.optLong("actionId", -1);
        int timeoutMs = boundedDuration(request, "timeoutMs");
        int quietWindowMs = boundedDuration(request, "quietWindowMs");
        int noResponseGraceMs = boundedDuration(request, "noResponseGraceMs");
        ActionContext action = actions.remove(actionId);
        if (action == null) return errorResponse(requestId, "unknown_action", "Action identity is stale or unknown.");
        long deadline = SystemClock.elapsedRealtime() + timeoutMs;
        boolean activityObserved = false;
        while (true) {
            if (cancelledRequests.remove(requestId)) {
                return errorResponse(requestId, "cancelled", "Observer settling was cancelled.");
            }
            long now = SystemClock.elapsedRealtime();
            long sequence = eventSequence.get();
            activityObserved = sequence > action.baselineSequence;
            boolean quiet = activityObserved && now - lastEventElapsedMs >= quietWindowMs;
            boolean noResponseWindow = !activityObserved && now - action.startedElapsedMs >= noResponseGraceMs;
            if (quiet || noResponseWindow) break;
            if (now >= deadline) return errorResponse(requestId, "settle_timeout", "Android UI did not settle before the deadline.");
            long waitMs = Math.min(25, Math.max(1, deadline - now));
            synchronized (eventSequence) {
                eventSequence.wait(waitMs);
            }
        }
        StateCapture capture = captureOnMain(false);
        boolean noOpConfirmed = capture.stateFingerprint.equals(action.baselineStateFingerprint);
        if (noOpConfirmed) {
            long confirmDeadline = Math.min(deadline, SystemClock.elapsedRealtime() + quietWindowMs);
            long confirmSequence = eventSequence.get();
            while (SystemClock.elapsedRealtime() < confirmDeadline && eventSequence.get() == confirmSequence) {
                synchronized (eventSequence) {
                    eventSequence.wait(Math.min(20, Math.max(1, confirmDeadline - SystemClock.elapsedRealtime())));
                }
            }
            StateCapture confirmation = captureOnMain(false);
            noOpConfirmed = confirmation.stateFingerprint.equals(capture.stateFingerprint);
            capture = confirmation;
        }
        long settledElapsed = Math.max(0, SystemClock.elapsedRealtime() - action.startedElapsedMs);
        long eventsObserved = Math.max(0, eventSequence.get() - action.baselineSequence);
        JSONObject timing = new JSONObject()
            .put("eventLatencyMs", action.firstEventElapsedMs < 0
                ? JSONObject.NULL
                : Math.max(0, action.firstEventElapsedMs - action.startedElapsedMs))
            .put("snapshotGenerationMs", capture.generationMs)
            .put("settlingMs", settledElapsed)
            .put("eventsObserved", eventsObserved)
            .put("noOpConfirmed", noOpConfirmed);
        return stateResponse(requestId, "settle_action", capture).put("timing", timing);
    }

    private JSONObject resync(long id) throws Exception {
        actions.clear();
        cancelledRequests.clear();
        lastStructureFingerprint = "";
        lastStateFingerprint = "";
        long deadline = SystemClock.elapsedRealtime() + 3_000;
        while (SystemClock.elapsedRealtime() < deadline
            && SystemClock.elapsedRealtime() - lastEventElapsedMs < 100) {
            synchronized (eventSequence) {
                eventSequence.wait(Math.min(20, Math.max(1, deadline - SystemClock.elapsedRealtime())));
            }
        }
        return stateResponse(id, "resync", captureOnMain(true));
    }

    private JSONObject cancel(JSONObject request, long id) throws JSONException {
        long targetId = request.optLong("targetId", -1);
        if (targetId < 0) return errorResponse(id, "invalid_target", "Cancellation target is invalid.");
        cancelledRequests.add(targetId);
        synchronized (eventSequence) {
            eventSequence.notifyAll();
        }
        return ok(id, "cancel");
    }

    private JSONObject shutdown(long id) throws JSONException {
        JSONObject response = ok(id, "shutdown");
        mainHandler.postDelayed(this::stopServer, 100);
        return response;
    }

    private StateCapture captureOnMain(boolean forceFull) throws Exception {
        if (Looper.myLooper() == Looper.getMainLooper()) return captureState(forceFull);
        CountDownLatch latch = new CountDownLatch(1);
        CaptureHolder holder = new CaptureHolder();
        mainHandler.post(() -> {
            try {
                holder.capture = captureState(forceFull);
            } catch (Exception error) {
                holder.error = error;
            } finally {
                latch.countDown();
            }
        });
        if (!latch.await(5, TimeUnit.SECONDS)) throw new IOException("Canonical snapshot generation timed out.");
        if (holder.error != null) throw holder.error;
        if (holder.capture == null) throw new IOException("Canonical snapshot was unavailable.");
        return holder.capture;
    }

    private StateCapture captureState(boolean forceFull) throws JSONException {
        long started = SystemClock.elapsedRealtime();
        AccessibilityNodeInfo root = getRootInActiveWindow();
        JSONArray roots = new JSONArray();
        StringBuilder structure = new StringBuilder();
        FocusHolder focus = new FocusHolder();
        Counter counter = new Counter();
        int maximumDepth = 0;
        if (root != null) {
            maximumDepth = appendNode(root, roots, structure, focus, counter, 0, "root");
            root.recycle();
        }
        String structureFingerprint = sha256(structure.toString());
        String focusSignature = focus.stableId == null ? "none" : focus.stableId;
        String stateFingerprint = sha256(structureFingerprint + "\u001f" + focusSignature);
        boolean treeChanged = forceFull || !structureFingerprint.equals(lastStructureFingerprint);
        lastStructureFingerprint = structureFingerprint;
        lastStateFingerprint = stateFingerprint;
        JSONObject state = new JSONObject()
            .put("sequence", eventSequence.get())
            .put("timestampMs", System.currentTimeMillis())
            .put("packageName", nullable(lastPackageName))
            .put("windowClassName", nullable(lastWindowClassName))
            .put("windowId", lastWindowId < 0 ? JSONObject.NULL : lastWindowId)
            .put("focused", focus.json == null ? JSONObject.NULL : focus.json)
            .put("structureFingerprint", structureFingerprint)
            .put("stateFingerprint", stateFingerprint)
            .put("treeChanged", treeChanged)
            .put("nodeCount", counter.value)
            .put("maxDepth", maximumDepth);
        if (treeChanged) state.put("nodes", roots);
        return new StateCapture(
            state,
            structureFingerprint,
            stateFingerprint,
            Math.max(0, SystemClock.elapsedRealtime() - started)
        );
    }

    private int appendNode(
        AccessibilityNodeInfo node,
        JSONArray destination,
        StringBuilder structure,
        FocusHolder focus,
        Counter counter,
        int depth,
        String path
    ) throws JSONException {
        if (counter.value >= MAX_NODES || depth >= MAX_DEPTH) return depth;
        counter.value += 1;
        String className = nullableString(node.getClassName());
        String packageName = nullableString(node.getPackageName());
        String text = nullableString(node.getText());
        String description = nullableString(node.getContentDescription());
        String role = roleFor(className, node.isClickable());
        String viewId = boundedNullable(node.getViewIdResourceName());
        String stableId = viewId == null
            ? "synthetic:" + sha256(path + "\u001f" + nullToEmpty(description) + "\u001f" + nullToEmpty(text)).substring(0, 20)
            : bounded(viewId + "#" + sha256(path).substring(0, 12));
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        JSONObject boundsJson = bounds.width() > 0 && bounds.height() > 0
            ? new JSONObject()
                .put("x", bounds.left)
                .put("y", bounds.top)
                .put("width", bounds.width())
                .put("height", bounds.height())
            : null;
        JSONArray children = new JSONArray();
        JSONObject json = new JSONObject()
            .put("stableId", stableId)
            .put("role", nullable(role))
            .put("name", nullable(description != null ? description : text))
            .put("text", nullable(text))
            .put("bounds", boundsJson == null ? JSONObject.NULL : boundsJson)
            .put("visible", node.isVisibleToUser())
            .put("enabled", node.isEnabled())
            .put("focusable", node.isFocusable())
            .put("focused", node.isFocused())
            .put("modal", JSONObject.NULL)
            .put("selectionState", node.isCheckable()
                ? (node.isChecked() ? "on" : "off")
                : node.isSelected() ? "on" : JSONObject.NULL)
            .put("valueNow", JSONObject.NULL)
            .put("className", nullable(className))
            .put("packageName", nullable(packageName))
            .put("clickable", node.isClickable())
            .put("scrollable", node.isScrollable())
            .put("selected", node.isSelected())
            .put("children", children);
        destination.put(json);
        structure.append(stableId).append('\u001f')
            .append(nullToEmpty(role)).append('\u001f')
            .append(normalise(text)).append('\u001f')
            .append(normalise(description)).append('\u001f')
            .append(node.isEnabled()).append('\u001f')
            .append(node.isSelected()).append('\u001f')
            .append(node.isChecked()).append('\u001f')
            .append(node.getChildCount()).append('\u001e');
        if (node.isFocused()) {
            focus.stableId = stableId;
            focus.json = new JSONObject()
                .put("stableId", stableId)
                .put("role", nullable(role))
                .put("name", nullable(description != null ? description : text))
                .put("bounds", boundsJson == null ? JSONObject.NULL : boundsJson);
        }
        int deepest = depth;
        int childCount = Math.min(node.getChildCount(), MAX_NODES - counter.value);
        for (int index = 0; index < childCount; index += 1) {
            AccessibilityNodeInfo child = node.getChild(index);
            if (child == null) continue;
            try {
                deepest = Math.max(deepest, appendNode(
                    child,
                    children,
                    structure,
                    focus,
                    counter,
                    depth + 1,
                    path + "/" + index
                ));
            } finally {
                child.recycle();
            }
        }
        return deepest;
    }

    private JSONObject stateResponse(long id, String type, StateCapture capture) throws JSONException {
        return ok(id, type).put("state", capture.json);
    }

    private static JSONObject ok(long id, String type) throws JSONException {
        return new JSONObject()
            .put("version", PROTOCOL_VERSION)
            .put("id", id)
            .put("ok", true)
            .put("type", type);
    }

    private static JSONObject errorResponse(long id, String code, String message) {
        try {
            return new JSONObject()
                .put("version", PROTOCOL_VERSION)
                .put("id", id)
                .put("ok", false)
                .put("type", "error")
                .put("error", new JSONObject().put("code", code).put("message", bounded(message)));
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static void writeFrame(DataOutputStream output, Object lock, JSONObject response) throws IOException {
        byte[] payload = response.toString().getBytes(StandardCharsets.UTF_8);
        if (payload.length <= 0 || payload.length > MAX_FRAME_BYTES) throw new IOException("Response frame exceeded its bound.");
        synchronized (lock) {
            output.writeInt(payload.length);
            output.write(payload);
            output.flush();
        }
    }

    private static String requiredString(JSONObject value, String key, int maximumLength) throws JSONException {
        String result = value.getString(key);
        if (result.isEmpty() || result.length() > maximumLength || result.indexOf('\0') >= 0) {
            throw new JSONException(key + " is invalid.");
        }
        return result;
    }

    private static int boundedDuration(JSONObject value, String key) throws JSONException {
        int result = value.getInt(key);
        if (result <= 0 || result > 60_000) throw new JSONException(key + " is invalid.");
        return result;
    }

    private static boolean constantTimeEquals(String left, String right) {
        byte[] leftBytes = left.getBytes(StandardCharsets.UTF_8);
        byte[] rightBytes = right.getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(leftBytes, rightBytes);
    }

    private static Object nullable(String value) {
        return value == null ? JSONObject.NULL : value;
    }

    private static String nullableString(CharSequence value) {
        if (value == null) return null;
        String result = bounded(value.toString().trim());
        return result.isEmpty() ? null : result;
    }

    private static String boundedNullable(String value) {
        if (value == null) return null;
        String result = bounded(value.trim());
        return result.isEmpty() ? null : result;
    }

    private static String bounded(String value) {
        if (value == null) return "";
        return value.length() <= MAX_STRING ? value : value.substring(0, MAX_STRING);
    }

    private static String normalise(String value) {
        return value == null ? "" : bounded(value.trim().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT));
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }

    private static String roleFor(String className, boolean clickable) {
        if (className == null) return clickable ? "button" : null;
        String shortName = className.substring(className.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        switch (shortName) {
            case "button":
            case "imagebutton": return "button";
            case "checkbox": return "checkbox";
            case "radiobutton": return "radio";
            case "switch":
            case "switchcompat":
            case "togglebutton": return "switch";
            case "seekbar": return "slider";
            case "edittext": return "textbox";
            case "imageview": return "img";
            case "listview":
            case "recyclerview": return "list";
            case "textview": return clickable ? "button" : "text";
            default: return clickable ? "button" : null;
        }
    }

    private static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(digest.length * 2);
            for (byte item : digest) result.append(String.format(Locale.ROOT, "%02x", item & 0xff));
            return result.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static final class Counter {
        int value;
    }

    private static final class FocusHolder {
        String stableId;
        JSONObject json;
    }

    private static final class CaptureHolder {
        StateCapture capture;
        Exception error;
    }

    private static final class StateCapture {
        final JSONObject json;
        final String structureFingerprint;
        final String stateFingerprint;
        final long generationMs;

        StateCapture(JSONObject json, String structureFingerprint, String stateFingerprint, long generationMs) {
            this.json = json;
            this.structureFingerprint = structureFingerprint;
            this.stateFingerprint = stateFingerprint;
            this.generationMs = generationMs;
        }
    }

    private static final class ActionContext {
        final long id;
        final long baselineSequence;
        final long startedElapsedMs;
        final String baselineStateFingerprint;
        volatile long firstEventElapsedMs = -1;

        ActionContext(long id, long baselineSequence, long startedElapsedMs, String baselineStateFingerprint) {
            this.id = id;
            this.baselineSequence = baselineSequence;
            this.startedElapsedMs = startedElapsedMs;
            this.baselineStateFingerprint = baselineStateFingerprint;
        }
    }
}
