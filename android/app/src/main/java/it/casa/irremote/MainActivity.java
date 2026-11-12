package it.casa.irremote;

import android.app.Activity;
import android.content.res.Configuration;
import android.graphics.Insets;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.WindowInsets;
import android.widget.FrameLayout;
import android.view.WindowInsetsController;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** WebView shell: the UI lives in assets/index.html, Java only does HTTP (no CORS limits) and asset reads. */
public class MainActivity extends Activity {
    private WebView web;
    private final ExecutorService pool = Executors.newFixedThreadPool(3);

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        web.setBackgroundColor(dark ? 0xFF111418 : 0xFFF5F6F8);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        web.addJavascriptInterface(new Bridge(), "Native");
        web.setWebChromeClient(new WebChromeClient()); // enables prompt()/confirm() dialogs
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                // the Native bridge must only ever be visible to our own asset pages
                return !"file".equals(r.getUrl().getScheme());
            }
        });
        // WebView ignores its own padding, so the insets go on a wrapping layout
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(dark ? 0xFF111418 : 0xFFF5F6F8);
        root.addView(web);
        setContentView(root);

        if (Build.VERSION.SDK_INT >= 30) {
            // targetSdk 35+ draws edge-to-edge: keep content clear of status/nav bars and the keyboard
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(i.left, i.top, i.right, i.bottom);
                return insets;
            });
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null && !dark) {
                int f = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(f, f);
            }
        }
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }

        if (state != null) web.restoreState(state);
        else web.loadUrl("file:///android_asset/index.html");
    }

    private void handleBack() {
        // the page closes its own sheets/screens first; it returns true when it handled the back press
        web.evaluateJavascript("window.onBack ? onBack() : false", v -> {
            if (!"true".equals(v)) finish();
        });
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        handleBack(); // API < 33
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        pool.shutdownNow();
        web.destroy();
        super.onDestroy();
    }

    static String read(InputStream in) throws IOException {
        if (in == null) return "";
        try (InputStream is = in) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toString("UTF-8");
        }
    }

    /** "192.168.1." for the phone's current IPv4 network, or null when offline. */
    String localPrefix() {
        try {
            android.net.ConnectivityManager cm = (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            android.net.LinkProperties lp = cm.getLinkProperties(cm.getActiveNetwork());
            if (lp == null) return null;
            for (android.net.LinkAddress la : lp.getLinkAddresses()) {
                java.net.InetAddress a = la.getAddress();
                if (a instanceof java.net.Inet4Address && !a.isLoopbackAddress()) {
                    String h = a.getHostAddress();
                    return h.substring(0, h.lastIndexOf('.') + 1);
                }
            }
        } catch (Exception e) {
            return null;
        }
        return null;
    }

    /** api/info JSON (with "ip" added) if an OpenBeken device answers at ip, else null. */
    static String probe(String ip) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL("http://" + ip + "/api/info").openConnection();
            c.setConnectTimeout(600);
            c.setReadTimeout(1500);
            if (c.getResponseCode() != 200) return null;
            JSONObject o = new JSONObject(read(c.getInputStream()));
            if (!o.has("chipset") || !o.has("mac")) return null;
            o.put("ip", ip);
            return o.toString();
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    class Bridge {
        /** Async HTTP; result comes back through window.Native_cb(id, status, text). status 0 = network error. */
        @JavascriptInterface
        public void http(final int id, final String method, final String url, final String body) {
            pool.execute(() -> {
                int code = 0;
                String text;
                HttpURLConnection c = null;
                try {
                    c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(4000);
                    c.setReadTimeout(8000);
                    c.setRequestMethod(method);
                    if (body != null && !body.isEmpty()) {
                        c.setDoOutput(true);
                        try (OutputStream o = c.getOutputStream()) {
                            o.write(body.getBytes(StandardCharsets.UTF_8));
                        }
                    }
                    code = c.getResponseCode();
                    text = read(code >= 400 ? c.getErrorStream() : c.getInputStream());
                } catch (Exception e) {
                    text = String.valueOf(e.getMessage());
                } finally {
                    if (c != null) c.disconnect();
                }
                final String js = "Native_cb(" + id + "," + code + "," + JSONObject.quote(text) + ")";
                web.post(() -> web.evaluateJavascript(js, null));
            });
        }

        /** Finds OpenBeken devices on the phone's Wi-Fi: probes /api/info on every host of the /24 subnet.
         *  Result via Native_cb(id, 200, '{"net":"192.168.1.","devices":[{...api/info...}]}'). */
        @JavascriptInterface
        public void scan(final int id) {
            pool.execute(() -> {
                JSONObject out = new JSONObject();
                org.json.JSONArray found = new org.json.JSONArray();
                String base = localPrefix();
                try {
                    out.put("net", base == null ? "" : base);
                    if (base != null) {
                        // shortcut: scans only the /24 the phone is on (home routers), not larger subnets
                        ExecutorService ex = Executors.newFixedThreadPool(48);
                        java.util.List<java.util.concurrent.Future<String>> fs = new java.util.ArrayList<>();
                        for (int i = 1; i < 255; i++) {
                            final String ip = base + i;
                            fs.add(ex.submit(() -> probe(ip)));
                        }
                        for (java.util.concurrent.Future<String> f : fs) {
                            String s = f.get();
                            if (s != null) found.put(new JSONObject(s));
                        }
                        ex.shutdown();
                    }
                    out.put("devices", found);
                } catch (Exception e) {
                    // return what was found so far
                }
                final String js = "Native_cb(" + id + ",200," + JSONObject.quote(out.toString()) + ")";
                web.post(() -> web.evaluateJavascript(js, null));
            });
        }

        @JavascriptInterface
        public boolean hasIr() {
            return PhoneIr.available(MainActivity.this);
        }

        /** Sends one pattern with the phone blaster; returns "" or an error message. */
        @JavascriptInterface
        public String irTransmit(int freq, String patternJson) {
            try {
                return PhoneIr.transmit(MainActivity.this, freq, PhoneIr.toInts(new org.json.JSONArray(patternJson)));
            } catch (Exception e) {
                return String.valueOf(e.getMessage());
            }
        }

        @JavascriptInterface
        public void setSchedules(String json) {
            PhoneIr.saveSchedules(MainActivity.this, json);
        }

        @JavascriptInterface
        public String asset(String path) {
            try {
                return read(getAssets().open(path));
            } catch (IOException e) {
                return null;
            }
        }
    }
}
