package com.airgapper.app;

import android.app.Activity;
import android.webkit.WebView;

/** Compatibility shell kept only until MainActivity no longer names the old backend. */
final class NativeCameraBridge {
    NativeCameraBridge(Activity activity, WebView webView) {}
    boolean onRequestPermissionsResult(int requestCode, int[] results) { return false; }
    void stop() {}
    void close() {}
}
