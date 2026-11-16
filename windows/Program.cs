// Kestrel EFB for Windows. A native window around the web app, with a menu bar.
// The menus call the functions the web app exposes as window.Kestrel (see js/desktop.js).
// Built by .github/workflows/windows.yml. Uses the WebView2 runtime that ships with Windows 11 and current Windows 10.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Program
{
    [STAThread]
    static void Main()
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainForm());
    }
}

sealed class MainForm : Form
{
    const string SiteUrl = "https://algophobic-dev.github.io/Kestrel-EFB/";
    const string Help = "https://github.com/algophobic-dev/Kestrel-EFB#readme";
    const string OfflinePage =
        "<html><body style=\"margin:0;height:100vh;display:grid;place-items:center;background:#10161a;color:#eef3f6;font:15px Segoe UI,sans-serif;text-align:center\">" +
        "<div><h2 style=\"margin:0 0 8px\">Kestrel EFB could not load</h2>" +
        "<p style=\"color:#93a3ae;margin:0 0 16px\">Check your internet connection, then select Reload.</p>" +
        "<a href=\"" + SiteUrl + "\" style=\"background:#2bb3a0;color:#06211d;padding:8px 16px;border-radius:6px;font-weight:600;text-decoration:none\">Reload</a></div></body></html>";

    readonly WebView2 web = new WebView2 { Dock = DockStyle.Fill };
    readonly Dictionary<Keys, ToolStripMenuItem> shortcuts = new Dictionary<Keys, ToolStripMenuItem>();
    readonly MenuStrip menu;
    bool fullScreen;
    FormWindowState beforeFullScreen;

    public MainForm()
    {
        Text = "Kestrel EFB";
        ClientSize = new Size(1280, 860);
        MinimumSize = new Size(480, 600);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(16, 22, 26);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        menu = BuildMenu();
        MainMenuStrip = menu;
        Controls.Add(web);
        Controls.Add(menu);
        Load += async (s, e) => await Start();
    }

    // ---- Start the web view

    async Task Start()
    {
        try
        {
            // Keep the app's data (aircraft, flights, sync code) in the user's own profile.
            string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "KestrelEFB");
            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, data);
            await web.EnsureCoreWebView2Async(env);
        }
        catch (Exception)
        {
            MessageBox.Show(this, "Kestrel EFB needs the Microsoft Edge WebView2 Runtime, which is missing on this PC.\n\nSelect OK to open the download page, install it, then start Kestrel EFB again.",
                "Kestrel EFB", MessageBoxButtons.OK, MessageBoxIcon.Information);
            OpenExternal("https://developer.microsoft.com/microsoft-edge/webview2/");
            Close();
            return;
        }
        CoreWebView2 core = web.CoreWebView2;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
        // Links to other sites and target="_blank" links open in the default browser.
        core.NewWindowRequested += (s, e) => { e.Handled = true; OpenExternal(e.Uri); };
        core.NavigationStarting += (s, e) =>
        {
            Uri uri;
            if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out uri)) return;
            bool isWeb = uri.Scheme == "http" || uri.Scheme == "https";
            if (isWeb && !string.Equals(uri.Host, new Uri(SiteUrl).Host, StringComparison.OrdinalIgnoreCase)) { e.Cancel = true; OpenExternal(e.Uri); }
        };
        core.NavigationCompleted += (s, e) =>
        {
            if (!e.IsSuccess && e.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled && e.WebErrorStatus != CoreWebView2WebErrorStatus.ConnectionAborted)
                web.NavigateToString(OfflinePage);
        };
        // Menu shortcuts still work while the page has keyboard focus.
        web.KeyDown += (s, e) =>
        {
            ToolStripMenuItem item;
            if (shortcuts.TryGetValue(e.KeyData, out item)) { item.PerformClick(); e.Handled = true; e.SuppressKeyPress = true; }
        };
        core.Navigate(SiteUrl);
    }

    static void OpenExternal(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    // ---- Menu bar

    /// Runs one web-app function. Does nothing until the page has loaded.
    void Run(string js)
    {
        if (web.CoreWebView2 != null) web.CoreWebView2.ExecuteScriptAsync("window.Kestrel && (" + js + ")");
    }

    ToolStripMenuItem Item(string text, Action action, Keys keys = Keys.None)
    {
        ToolStripMenuItem item = new ToolStripMenuItem(text);
        item.Click += (s, e) => action();
        if (keys != Keys.None)
        {
            try { item.ShortcutKeys = keys; shortcuts[keys] = item; } catch (Exception) { }   // skip a shortcut Windows rejects
        }
        return item;
    }
    ToolStripMenuItem Js(string text, string js, Keys keys = Keys.None) { return Item(text, () => Run(js), keys); }
    static ToolStripMenuItem Menu(string text, params ToolStripItem[] items)
    {
        ToolStripMenuItem m = new ToolStripMenuItem(text);
        m.DropDownItems.AddRange(items);
        return m;
    }
    static ToolStripItem Sep() { return new ToolStripSeparator(); }

    MenuStrip BuildMenu()
    {
        const Keys C = Keys.Control, S = Keys.Shift;
        MenuStrip strip = new MenuStrip();

        strip.Items.Add(Menu("&File",
            Js("&New Flight Plan", "Kestrel.newPlan()", C | Keys.N),
            Js("&Save Flight", "Kestrel.savePlan()", C | Keys.S),
            Sep(),
            Js("&Print NavLog…", "Kestrel.preparePrint() && window.print()", C | Keys.P),
            Sep(),
            Js("&Aircraft and Settings…", "Kestrel.tab('more')", C | Keys.Oemcomma),
            Js("S&ync Now", "Kestrel.syncNow()", C | S | Keys.S),
            Sep(),
            Item("E&xit", Close, Keys.Alt | Keys.F4)));

        strip.Items.Add(Menu("&Edit",
            Js("&Find Airport or Enter Route", "Kestrel.search()", C | Keys.F)));

        string[][] tabs =
        {
            new[] { "&Airports", "airports" }, new[] { "&Maps", "maps" }, new[] { "&Plates", "plates" }, new[] { "&Documents", "documents" }, new[] { "&Imagery", "imagery" },
            new[] { "&Flights", "flights" }, new[] { "&ScratchPads", "scratch" }, new[] { "&Checklist", "checklist" }, new[] { "&Logbook", "logbook" }, new[] { "M&ore", "more" },
        };
        Keys[] digits = { Keys.D1, Keys.D2, Keys.D3, Keys.D4, Keys.D5, Keys.D6, Keys.D7, Keys.D8, Keys.D9, Keys.D0 };
        ToolStripMenuItem view = new ToolStripMenuItem("&View");
        for (int i = 0; i < tabs.Length; i++) view.DropDownItems.Add(Js(tabs[i][0], "Kestrel.tab('" + tabs[i][1] + "')", C | digits[i]));
        view.DropDownItems.Add(Sep());
        view.DropDownItems.Add(Item("&Reload", Reload, Keys.F5));
        view.DropDownItems.Add(Item("F&ull Screen", ToggleFullScreen, Keys.F11));
        strip.Items.Add(view);

        string[][] charts = { new[] { "None", "none" }, new[] { "VFR Sectional", "sec" }, new[] { "VFR Terminal", "tac" }, new[] { "IFR Low", "low" }, new[] { "IFR High", "high" } };
        string[][] bases = { new[] { "Dark", "dark" }, new[] { "Light", "light" }, new[] { "Topographic", "topo" }, new[] { "Satellite", "sat" } };
        string[][] layers =
        {
            new[] { "Airports and Navaids", "aero" }, new[] { "Airspace", "airspace" }, new[] { "Radar", "radar" }, new[] { "Flight Category", "cat" }, new[] { "SIGMETs", "sigmet" },
            new[] { "Icing Advisories", "ice" }, new[] { "Turbulence Advisories", "turb" }, new[] { "IFR Advisories", "ifr" },
            new[] { "Terrain Hazard", "hazard" }, new[] { "Obstacles", "obstacles" }, new[] { "Traffic", "traffic" },
        };
        strip.Items.Add(Menu("&Map",
            Sub("&Chart", charts, "Kestrel.chart"),
            Sub("&Base Map", bases, "Kestrel.base"),
            Sub("Show or Hide &Layer", layers, "Kestrel.layer"),
            Sep(),
            Js("Zoom &In", "Kestrel.zoom(1)", C | Keys.Oemplus),
            Js("Zoom &Out", "Kestrel.zoom(-1)", C | Keys.OemMinus),
            Js("C&enter on Route", "Kestrel.centre()", C | Keys.E),
            Sep(),
            Js("&Follow My Position", "Kestrel.follow()", C | Keys.L),
            Js("Start or Stop &Track Log", "Kestrel.record()", C | S | Keys.T)));

        strip.Items.Add(Menu("F&light",
            Js("Show or Hide &Flight Plan", "Kestrel.toggleFpl()", C | Keys.D),
            Sep(),
            Js("&Edit Route", "Kestrel.mode('edit')", C | S | Keys.D1),
            Js("&NavLog", "Kestrel.mode('navlog')", C | S | Keys.D2),
            Js("&Profile", "Kestrel.mode('profile')", C | S | Keys.D3),
            Js("&3D View", "Kestrel.mode('3d')", C | S | Keys.D4),
            Sep(),
            Js("Suggest &Routes…", "Kestrel.routes()", C | S | Keys.R),
            Js("Pro&cedures…", "Kestrel.procedures()", C | S | Keys.P),
            Js("Re&verse Route", "Kestrel.reverse()")));

        strip.Items.Add(Menu("&Help",
            Item("Kestrel EFB &Help", () => OpenExternal(Help), Keys.F1),
            Item("&About Kestrel EFB", () => MessageBox.Show(this, "Kestrel EFB 1.0\nFree flight planning for US pilots.", "About Kestrel EFB", MessageBoxButtons.OK, MessageBoxIcon.Information))));
        return strip;
    }

    ToolStripMenuItem Sub(string text, string[][] entries, string fn)
    {
        ToolStripMenuItem m = new ToolStripMenuItem(text);
        foreach (string[] e in entries) m.DropDownItems.Add(Js(e[0], fn + "('" + e[1] + "')"));
        return m;
    }

    void Reload()
    {
        if (web.CoreWebView2 == null) return;
        if (web.Source != null && web.Source.Scheme.StartsWith("http")) web.CoreWebView2.Reload(); else web.CoreWebView2.Navigate(SiteUrl);
    }

    void ToggleFullScreen()
    {
        fullScreen = !fullScreen;
        if (fullScreen) { beforeFullScreen = WindowState; WindowState = FormWindowState.Normal; FormBorderStyle = FormBorderStyle.None; WindowState = FormWindowState.Maximized; }
        else { FormBorderStyle = FormBorderStyle.Sizable; WindowState = beforeFullScreen; }
    }
}
