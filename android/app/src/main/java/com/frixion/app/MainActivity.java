package com.frixion.app;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

// Frixion for Android phones: the Frixion website, full screen, like the app for computers. The website does all the
// real work; this only adds what a browser tab on a phone can't: an app icon, Frixion links opening here, the back
// button, picking files, and notifications as phone notifications. The website talks to it through
// window.FrixionAndroid (see "THE FRIXION APP FOR ANDROID" in the website's script.js).
public class MainActivity extends Activity {
    static final String HOST = "frixionbeta.pages.dev";
    static final String SITE = "https://" + HOST + "/";
    // Frixion's other addresses: their pages open on the main one, where you're signed in
    static final String[] OTHER_HOSTS = { "equilibrium-incarnate.pages.dev", "frixionalpha.pages.dev", "skymc.pages.dev", "airmc.pages.dev" };
    static final int PICK_FILES = 1;
    static final String CHANNEL = "messages";

    private WebView web;
    private ValueCallback<Uri[]> picking;
    private String version = "";
    private String pendingOpen;   // a notification tapped before the page was ready
    private int nextId = 1;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        try { version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { }
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#1E1F22"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(s.getUserAgentString() + " FrixionAndroid/" + version);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new Bridge(), "FrixionAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String scheme = u.getScheme() == null ? "" : u.getScheme();
                if (!request.isForMainFrame()) return false;
                if (!scheme.equals("http") && !scheme.equals("https")) {
                    if (scheme.equals("file") || scheme.equals("about") || scheme.equals("data") || scheme.equals("blob")) return false;
                    openOutside(u);   // mailto:, tel: and the like
                    return true;
                }
                if (HOST.equals(u.getHost())) return false;
                if (isOtherFrixion(u)) { view.loadUrl(onSite(u)); return true; }
                openOutside(u);       // everything else opens in the phone's browser
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) view.loadUrl("file:///android_asset/offline.html");
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (pendingOpen != null && url != null && url.startsWith(SITE)) { openInPage(pendingOpen); pendingOpen = null; }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (picking != null) picking.onReceiveValue(null);
                picking = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                List<String> types = new ArrayList<>();
                for (String t : params.getAcceptTypes()) {
                    if (t == null) continue;
                    for (String x : t.split(",")) { x = x.trim(); if (x.contains("/")) types.add(x); }
                }
                if (types.size() == 1) pick.setType(types.get(0));
                else if (types.size() > 1) pick.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(pick, null), PICK_FILES);
                } catch (ActivityNotFoundException e) {
                    picking = null;
                    return false;
                }
                return true;
            }
        });
        web.setDownloadListener((url, userAgent, disposition, mimeType, length) -> openOutside(Uri.parse(url)));

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 2);

        Intent intent = getIntent();
        pendingOpen = intent != null ? intent.getStringExtra("open") : null;
        web.loadUrl(linkIn(intent) != null ? linkIn(intent) : SITE);
    }

    // A notification tapped, or a Frixion link opened, while the app is already running.
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String open = intent.getStringExtra("open");
        if (open != null) { openInPage(open); return; }
        String link = linkIn(intent);
        if (link != null) {
            String q = JSONObject.quote(link);
            js("window.frixionAndroidLink ? window.frixionAndroidLink(" + q + ") : (location.href = " + q + ")");
        }
    }

    // Back puts away what's on top in Frixion (a menu, a chat, a page); with nothing left, the app goes to the
    // background instead of closing, like other chat apps.
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("(window.frixionAndroidBack && window.frixionAndroidBack()) ? 1 : 0", answer -> {
            if ("1".equals(answer)) return;
            if (web.canGoBack()) web.goBack();
            else moveTaskToBack(true);
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request != PICK_FILES || picking == null) { super.onActivityResult(request, result, data); return; }
        Uri[] files = null;
        if (result == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                files = new Uri[clip.getItemCount()];
                for (int i = 0; i < files.length; i++) files[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                files = new Uri[] { data.getData() };
            }
        }
        picking.onReceiveValue(files);
        picking = null;
    }

    // What the website can call (window.FrixionAndroid)
    class Bridge {
        @JavascriptInterface
        public String version() { return version; }

        // A message notification: { title, body, open } (open: the chat to show when it's tapped)
        @JavascriptInterface
        public void notification(String json) { runOnUiThread(() -> showNotification(json)); }
    }

    private void showNotification(String json) {
        try {
            JSONObject n = new JSONObject(json);
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null)
                nm.createNotificationChannel(new NotificationChannel(CHANNEL, getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH));
            int id = nextId++;
            Intent tap = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            JSONObject open = n.optJSONObject("open");
            if (open != null) tap.putExtra("open", open.toString());
            PendingIntent onTap = PendingIntent.getActivity(this, id, tap, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            String body = n.optString("body", "");
            Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
            b.setSmallIcon(R.drawable.ic_notify)
                .setColor(Color.parseColor("#5865F2"))
                .setContentTitle(n.optString("title", "Frixion"))
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(onTap);
            if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL);
            nm.notify(id, b.build());
        } catch (Exception e) { }
    }

    // open is JSON this app made from the website's own (see showNotification), so it's safe to hand back as code
    private void openInPage(String open) {
        try { js("window.frixionAndroidOpen && window.frixionAndroidOpen(" + new JSONObject(open) + ")"); } catch (Exception e) { }
    }

    private void js(String code) { web.evaluateJavascript(code, null); }

    // The Frixion page a link opened the app with, on the main address (null if it wasn't a Frixion link)
    private static String linkIn(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction()) || intent.getData() == null) return null;
        Uri u = intent.getData();
        return HOST.equals(u.getHost()) || isOtherFrixion(u) ? onSite(u) : null;
    }

    private static boolean isOtherFrixion(Uri u) {
        for (String h : OTHER_HOSTS) if (h.equals(u.getHost())) return true;
        return false;
    }

    private static String onSite(Uri u) {
        String path = u.getEncodedPath(), query = u.getEncodedQuery(), fragment = u.getEncodedFragment();
        return "https://" + HOST + (path == null || path.isEmpty() ? "/" : path) + (query != null ? "?" + query : "") + (fragment != null ? "#" + fragment : "");
    }

    private void openOutside(Uri u) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException e) { }
    }
}
