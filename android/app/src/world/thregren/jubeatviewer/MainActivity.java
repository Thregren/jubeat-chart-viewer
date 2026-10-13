package world.thregren.jubeatviewer;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.Manifest;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 安卓壳：WebView + 一个只服务 127.0.0.1 的本地 http 服务。
 *
 * 前端（index.html / static/）编译进 APK，所以「最小安装包」永远带着和它配套的界面；
 * 曲库（media / markers / data）由「曲库资源包」导入到
 * {@code Android/media/<包名>/site}，也可以插 USB 直接拷。
 */
public final class MainActivity extends Activity {
    private static final int REQ_PICK = 1001;
    private static final int REQ_PERM = 1002;

    private FrameLayout root;
    private File siteDir;
    private LocalServer server;
    private WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean importing;
    private volatile boolean destroyed;
    private Thread importThread;
    private volatile String serverUrl;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        root = new FrameLayout(this);
        setContentView(root);
        siteDir = SiteStore.siteDir(this);
        refresh();
    }

    // ------------------------------------------------------------ 主流程

    /** 前端同步写进站点目录（几百 KB，很快），再决定显示 WebView 还是导入面板。 */
    private void refresh() {
        if (importing) return;
        if (web != null) {
            root.removeAllViews();
            web.destroy();
            web = null;
        }
        stopServer();
        siteDir = SiteStore.siteDir(this);
        ensureStorage();
        try {
            ArchiveImport.recoverPending(siteDir);
            stageFrontend();
        } catch (IOException e) {
            showFatal("恢复或更新站点失败：" + e.getMessage() + "\n\n目录：" + siteDir);
            return;
        }
        if (SiteStore.ready(siteDir)) {
            showWeb();
        } else {
            showPanel(null);
        }
    }

    private void showWeb() {
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        // 谱面播放里有脚本触发的打点音，没有这句 WebView 会把它们当成「没手势的自动播放」拦掉
        s.setMediaPlaybackRequiresUserGesture(false);
        web.setBackgroundColor(0xFF101014);
        web.addJavascriptInterface(new PreferencesBridge(getSharedPreferences("viewer-settings", MODE_PRIVATE)), "JubeatPreferences");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                // The app is a local site. Prevent foreign documents/subframes from seeing the bridge.
                String url = request.getUrl().toString();
                if (serverUrl != null && url.startsWith(serverUrl)) return null;
                if (url.startsWith("blob:" + serverUrl)) return null;
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", null,
                        new ByteArrayInputStream(new byte[0]));
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                if (url != null && serverUrl != null && url.startsWith(serverUrl)) return false;
                if (url != null && (url.startsWith("http://") || url.startsWith("https://"))) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception ignored) {
                        // 没有浏览器就算了
                    }
                    return true;
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient());
        root.removeAllViews();
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        try {
            serverUrl = getServer().start();
            web.loadUrl(serverUrl);
        } catch (IOException e) {
            showFatal("本地服务起不来：" + e.getMessage());
        }
    }

    private LocalServer getServer() {
        if (server == null) server = new LocalServer(siteDir);
        return server;
    }

    private void stopServer() {
        if (server != null) {
            server.stop();
            server = null;
        }
    }

    // ------------------------------------------------------------ 导入面板

    private void showPanel(String note) {
        ScrollView scroll = new ScrollView(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        box.setPadding(pad, pad, pad, pad);
        scroll.addView(box);

        TextView title = new TextView(this);
        title.setText("还没有曲库");
        title.setTextSize(22);
        box.addView(title);

        TextView desc = new TextView(this);
        desc.setTextSize(14);
        desc.setPadding(0, dp(12), 0, dp(12));
        desc.setText("这个安装包只带界面，不含歌曲、封面和音源。两种方式把曲库放进来：\n\n"
                + "① 点下面的「导入资源包」，选 jubeat-library-*.zip（推荐）\n\n"
                + "② 手机连电脑后，把资源包解压到目录：\n" + siteDir + "\n"
                + "（这个目录需要能读到 data/library.json、media/、markers/ 三样）\n\n"
                + "放好之后点「重新检测」。" + (note == null ? "" : "\n\n" + note));
        box.addView(desc);

        ProgressBar bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setVisibility(View.GONE);
        box.addView(bar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        final TextView status = new TextView(this);
        status.setTextSize(13);
        status.setVisibility(View.GONE);
        box.addView(status);

        Button pick = new Button(this);
        pick.setText("导入资源包 (zip)");
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(16);
        pick.setLayoutParams(lp);
        pick.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                pickZip();
            }
        });
        box.addView(pick);

        Button again = new Button(this);
        again.setText("重新检测");
        again.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                refresh();
            }
        });
        box.addView(again);

        root.removeAllViews();
        root.addView(scroll, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void pickZip() {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");
        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try {
            startActivityForResult(i, REQ_PICK);
        } catch (Exception e) {
            toast("这台设备没有可用的文件选择器");
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_PICK || res != RESULT_OK || data == null) return;
        List<Uri> uris = new ArrayList<Uri>();
        if (data.getData() != null) uris.add(data.getData());
        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                Uri u = data.getClipData().getItemAt(i).getUri();
                if (u != null && !uris.contains(u)) uris.add(u);
            }
        }
        if (!uris.isEmpty()) doImport(uris);
    }

    private void doImport(final List<Uri> uris) {
        if (importing || destroyed) return;
        importing = true;
        stopServer();
        if (web != null) web.stopLoading();
        final ScrollView scroll = new ScrollView(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        box.setPadding(pad, pad, pad, pad);
        scroll.addView(box);
        final TextView title = new TextView(this);
        title.setTextSize(20);
        title.setText("正在导入…");
        box.addView(title);
        final ProgressBar bar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(1000);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(16);
        box.addView(bar, lp);
        final TextView status = new TextView(this);
        status.setTextSize(13);
        status.setPadding(0, dp(10), 0, 0);
        box.addView(status);
        root.removeAllViews();
        root.addView(scroll, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        final File dir = siteDir;
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                int files = 0;
                try {
                    for (int i = 0; i < uris.size(); i++) {
                        final int idx = i + 1;
                        final int total = uris.size();
                        files += ResImporter.extract(MainActivity.this, uris.get(i), dir,
                                new ResImporter.Progress() {
                                    @Override
                                    public void onStep(final long done, final long tot, final String name) {
                                        ui.post(new Runnable() {
                                            @Override
                                            public void run() {
                                                if (destroyed) return;
                                                bar.setIndeterminate(tot <= 0);
                                                if (tot > 0) bar.setProgress((int) Math.min(1000, done * 1000 / tot));
                                                if (total > 1) {
                                                    status.setText("第 " + idx + "/" + total + " 个包："
                                                            + SiteStore.human(done) + " / " + SiteStore.human(tot));
                                                } else {
                                                    status.setText(SiteStore.human(done) + " / " + SiteStore.human(tot)
                                                            + "\n" + name);
                                                }
                                            }
                                        });
                                    }
                                });
                    }
                    final int n = files;
                    ui.post(new Runnable() {
                        @Override
                        public void run() {
                            if (destroyed) return;
                            importing = false;
                            importThread = null;
                            toast("导入完成，共 " + n + " 个文件");
                            refresh();
                        }
                    });
                } catch (final Throwable e) {
                    ui.post(new Runnable() {
                        @Override
                        public void run() {
                            if (destroyed) return;
                            importing = false;
                            importThread = null;
                            showFatal("导入失败：" + e.getMessage());
                        }
                    });
                }
            }
        }, "jubeat-import");
        importThread = t;
        t.setDaemon(true);
        t.start();
    }

    // ------------------------------------------------------------ 杂项

    /**
     * Android 6~9 上往 Android/media/<包名> 写有可能被拒。先探一下，真写不动才去要
     * 权限（要到了下次进 refresh() 就换回外部目录，要不到也不影响用，只是曲库落在
     * App 私有目录里，插 USB 看不见）。
     */
    private void ensureStorage() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                || Build.VERSION.SDK_INT > Build.VERSION_CODES.P) return;
        File ext = SiteStore.externalBase(this);
        if (ext == null || SiteStore.canWrite(ext)) return;
        if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                == PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[] {Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQ_PERM);
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] granted) {
        super.onRequestPermissionsResult(req, perms, granted);
        if (req == REQ_PERM) refresh();
    }

    /** 把 APK 里的前端铺到站点目录（每次启动都盖一遍，保证界面和 App 版本配套）。 */
    private void stageFrontend() throws IOException {
        AssetManager am = getAssets();
        copyAsset(am, "www/index.html", new File(siteDir, "index.html"));
        String[] names = am.list("www/static");
        if (names == null || names.length == 0) throw new IOException("安装包里的前端不全");
        File dir = new File(siteDir, "static");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("建目录失败：" + dir);
        for (String n : names) copyAsset(am, "www/static/" + n, new File(dir, n));
    }

    private static void copyAsset(AssetManager am, String name, File dest) throws IOException {
        InputStream in = am.open(name);
        try {
            OutputStream out = new FileOutputStream(dest);
            try {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            } finally {
                out.close();
            }
        } finally {
            in.close();
        }
    }

    private void showFatal(String msg) {
        root.removeAllViews();
        TextView tv = new TextView(this);
        tv.setText(msg);
        tv.setTextSize(15);
        tv.setPadding(dp(20), dp(20), dp(20), dp(20));
        root.addView(tv);
        new AlertDialog.Builder(this)
                .setTitle("出错了")
                .setMessage(msg)
                .setPositiveButton("好", (DialogInterface.OnClickListener) null)
                .show();
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_LONG).show();
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        if (importThread != null) importThread.interrupt();
        ui.removeCallbacksAndMessages(null);
        stopServer();
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
