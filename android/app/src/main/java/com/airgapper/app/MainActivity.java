package com.airgapper.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.DashPathEffect;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Process;
import android.os.SystemClock;
import android.util.Base64;
import android.view.View;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.PopupWindow;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

import org.json.JSONArray;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String APP_URL = "https://" + APP_HOST + "/assets/index.html";
    private static final int CAMERA_REQUEST = 10;
    private static final int FILE_REQUEST = 11;
    private static final int SAVE_REQUEST = 12;

    private WebView webView;
    private TrackingOverlay trackingOverlay;
    private PopupWindow trackingPopup;
    private PermissionRequest cameraRequest;
    private ValueCallback<Uri[]> fileCallback;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private File pendingDownload;
    private OutputStream pendingDownloadStream;
    private File downloadToSave;
    private String downloadName;
    private String downloadType;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(247, 247, 245));
        trackingOverlay = new TrackingOverlay(this);
        trackingPopup = new PopupWindow(
                trackingOverlay,
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
                false);
        trackingPopup.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        trackingPopup.setTouchable(false);
        trackingPopup.setOutsideTouchable(false);
        trackingPopup.setClippingEnabled(false);
        setContentView(webView);
        // Chromium's old camera preview is a SurfaceView that can punch above
        // every child in this window. A separate application-panel window is
        // the only reliable layer above that surface on these devices.
        webView.post(() -> trackingPopup.showAtLocation(webView, Gravity.NO_GRAVITY, 0, 0));

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        webView.addJavascriptInterface(new AndroidBridge(), "AirGapperAndroid");
        webView.setWebViewClient(new LocalWebViewClient());
        webView.setWebChromeClient(new AppWebChromeClient());
        webView.loadUrl(APP_URL);
    }

    private final class LocalWebViewClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if ("https".equals(uri.getScheme()) && APP_HOST.equals(uri.getHost()) &&
                    "/assets/index.html".equals(uri.getPath())) {
                try {
                    return new WebResourceResponse("text/html", "UTF-8", getAssets().open("index.html"));
                } catch (Exception ignored) {
                    return null;
                }
            }
            return null;
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if ("https".equals(uri.getScheme()) && APP_HOST.equals(uri.getHost())) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception ignored) {
                // The offline app remains usable when no activity handles a received link.
            }
            return true;
        }
    }

    private final class AppWebChromeClient extends WebChromeClient {
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            runOnUiThread(() -> {
                Uri origin = request.getOrigin();
                if (!"https".equals(origin.getScheme()) || !APP_HOST.equals(origin.getHost()) ||
                        !requestsVideo(request)) {
                    request.deny();
                    return;
                }
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                } else {
                    cameraRequest = request;
                    requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_REQUEST);
                }
            });
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            if (cameraRequest == request) cameraRequest = null;
        }

        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("*/*")
                    .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
            startActivityForResult(intent, FILE_REQUEST);
            return true;
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (fullscreenView != null) {
                callback.onCustomViewHidden();
                return;
            }
            fullscreenView = view;
            fullscreenCallback = callback;
            FrameLayout decor = (FrameLayout) getWindow().getDecorView();
            decor.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            webView.setVisibility(View.GONE);
        }

        @Override
        public void onHideCustomView() {
            hideFullscreen();
        }
    }

    private static boolean requestsVideo(PermissionRequest request) {
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) return true;
        }
        return false;
    }

    private void hideFullscreen() {
        if (fullscreenView == null) return;
        ((ViewGroup) fullscreenView.getParent()).removeView(fullscreenView);
        fullscreenView = null;
        webView.setVisibility(View.VISIBLE);
        if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
        fullscreenCallback = null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != CAMERA_REQUEST || cameraRequest == null) return;
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) {
            cameraRequest.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            cameraRequest.deny();
        }
        cameraRequest = null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_REQUEST) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null) {
                    result = new Uri[clip.getItemCount()];
                    for (int i = 0; i < clip.getItemCount(); i++) result[i] = clip.getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            if (fileCallback != null) fileCallback.onReceiveValue(result);
            fileCallback = null;
            return;
        }
        if (requestCode == SAVE_REQUEST) {
            File source = downloadToSave;
            downloadToSave = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null && source != null) {
                Uri destination = data.getData();
                new Thread(() -> copyDownload(source, destination)).start();
            } else if (source != null) {
                source.delete();
            }
        }
    }

    private void copyDownload(File source, Uri destination) {
        try (InputStream input = new FileInputStream(source);
             OutputStream output = getContentResolver().openOutputStream(destination, "w")) {
            if (output == null) return;
            byte[] buffer = new byte[64 * 1024];
            for (int read; (read = input.read(buffer)) != -1; ) output.write(buffer, 0, read);
        } catch (Exception ignored) {
            // The document provider owns user-visible write errors.
        } finally {
            source.delete();
        }
    }

    private final class AndroidBridge {
        @JavascriptInterface
        public synchronized void beginDownload(String name, String type) {
            discardPendingDownload();
            try {
                pendingDownload = File.createTempFile("airgapper-", ".download", getCacheDir());
                pendingDownloadStream = new FileOutputStream(pendingDownload);
                downloadName = safeName(name);
                downloadType = type == null || type.isEmpty() ? "application/octet-stream" : type;
            } catch (Exception ignored) {
                discardPendingDownload();
            }
        }

        @JavascriptInterface
        public synchronized void appendDownloadChunk(String base64) {
            if (pendingDownloadStream == null) return;
            try {
                pendingDownloadStream.write(Base64.decode(base64, Base64.DEFAULT));
            } catch (Exception ignored) {
                discardPendingDownload();
            }
        }

        @JavascriptInterface
        public synchronized void finishDownload() {
            if (pendingDownloadStream == null || pendingDownload == null) return;
            try {
                pendingDownloadStream.close();
            } catch (Exception ignored) {
                discardPendingDownload();
                return;
            }
            pendingDownloadStream = null;
            downloadToSave = pendingDownload;
            pendingDownload = null;
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(downloadType)
                    .putExtra(Intent.EXTRA_TITLE, downloadName);
            runOnUiThread(() -> startActivityForResult(intent, SAVE_REQUEST));
        }

        @JavascriptInterface
        public void copyText(String text) {
            runOnUiThread(() -> {
                ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                clipboard.setPrimaryClip(android.content.ClipData.newPlainText("AirGapper", text));
            });
        }

        @JavascriptInterface
        public void setKeepScreenOn(boolean enabled) {
            runOnUiThread(() -> {
                if (enabled) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public void cameraHealthy() {
            getSharedPreferences("camera", MODE_PRIVATE).edit()
                    .putBoolean("recoveryPending", false).apply();
        }

        @JavascriptInterface
        public void recoverCamera() {
            if (getSharedPreferences("camera", MODE_PRIVATE)
                    .getBoolean("recoveryPending", false)) return;
            getSharedPreferences("camera", MODE_PRIVATE).edit()
                    .putBoolean("recoveryPending", true).commit();
            Intent launch = new Intent(MainActivity.this, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
            PendingIntent pending = PendingIntent.getActivity(
                    MainActivity.this, 19, launch,
                    PendingIntent.FLAG_CANCEL_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            AlarmManager alarm = (AlarmManager) getSystemService(ALARM_SERVICE);
            alarm.set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + 500, pending);
            runOnUiThread(() -> {
                finishAffinity();
                Process.killProcess(Process.myPid());
            });
        }

        @JavascriptInterface
        public void setTrackingBoxes(String json) {
            List<TrackingBox> boxes = new ArrayList<>();
            try {
                JSONArray array = new JSONArray(json);
                for (int i = 0; i < array.length(); i++) {
                    JSONObject box = array.getJSONObject(i);
                    boxes.add(new TrackingBox(
                            (float) box.getDouble("x"), (float) box.getDouble("y"),
                            (float) box.getDouble("w"), (float) box.getDouble("h"),
                            Color.parseColor(box.getString("color")),
                            (float) box.getDouble("alpha"), box.getBoolean("successful")));
                }
            } catch (Exception ignored) {
                boxes.clear();
            }
            runOnUiThread(() -> trackingOverlay.setBoxes(boxes));
        }
    }

    private static final class TrackingBox {
        final float x, y, w, h, alpha;
        final int color;
        final boolean successful;

        TrackingBox(float x, float y, float w, float h, int color, float alpha, boolean successful) {
            this.x = x;
            this.y = y;
            this.w = w;
            this.h = h;
            this.color = color;
            this.alpha = alpha;
            this.successful = successful;
        }
    }

    private static final class TrackingOverlay extends View {
        private final float density;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private List<TrackingBox> boxes = new ArrayList<>();

        TrackingOverlay(Context context) {
            super(context);
            density = context.getResources().getDisplayMetrics().density;
            setClickable(false);
            setFocusable(false);
            setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        }

        void setBoxes(List<TrackingBox> boxes) {
            this.boxes = boxes;
            invalidate();
        }

        @Override
        protected void onDraw(Canvas canvas) {
            super.onDraw(canvas);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeJoin(Paint.Join.ROUND);
            for (TrackingBox box : boxes) {
                float x = box.x * density;
                float y = box.y * density;
                float w = box.w * density;
                float h = box.h * density;
                float len = Math.min(w, h) * 0.24f;
                paint.setColor(box.color);
                paint.setAlpha(Math.max(0, Math.min(255, Math.round(box.alpha * 255))));
                paint.setStrokeWidth((box.successful ? 2.5f : 1.5f) * density);
                paint.setPathEffect(box.successful ? null : new DashPathEffect(
                        new float[]{5 * density, 5 * density}, 0));
                Path path = new Path();
                path.moveTo(x, y + len); path.lineTo(x, y); path.lineTo(x + len, y);
                path.moveTo(x + w - len, y); path.lineTo(x + w, y); path.lineTo(x + w, y + len);
                path.moveTo(x + w, y + h - len); path.lineTo(x + w, y + h); path.lineTo(x + w - len, y + h);
                path.moveTo(x + len, y + h); path.lineTo(x, y + h); path.lineTo(x, y + h - len);
                canvas.drawPath(path, paint);
            }
            paint.setPathEffect(null);
        }
    }

    private synchronized void discardPendingDownload() {
        try {
            if (pendingDownloadStream != null) pendingDownloadStream.close();
        } catch (Exception ignored) {
        }
        pendingDownloadStream = null;
        if (pendingDownload != null) pendingDownload.delete();
        pendingDownload = null;
    }

    private static String safeName(String name) {
        if (name == null) return "transfer.bin";
        String clean = name.replace('\\', '_').replace('/', '_').trim();
        return clean.isEmpty() ? "transfer.bin" : clean;
    }

    @Override
    public void onBackPressed() {
        if (fullscreenView != null) {
            hideFullscreen();
            return;
        }
        webView.evaluateJavascript(
                "window.airgapperHandleBack ? window.airgapperHandleBack() : false",
                value -> {
                    if (!"true".equals(value)) MainActivity.super.onBackPressed();
                });
    }

    @Override
    protected void onPause() {
        webView.evaluateJavascript(
                "window.airgapperSuspend && window.airgapperSuspend()",
                ignored -> webView.onPause());
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onDestroy() {
        discardPendingDownload();
        if (trackingPopup != null) trackingPopup.dismiss();
        webView.destroy();
        super.onDestroy();
    }
}
