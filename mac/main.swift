// Kestrel EFB for Mac. A native window around the web app, with a real menu bar.
// The menus call the functions the web app exposes as window.Kestrel (see js/desktop.js).
// Build with mac/build.sh. No Xcode project and no third-party code.
import Cocoa
import WebKit

let siteURL = URL(string: "https://algophobic-dev.github.io/Kestrel-EFB-App/")!
let helpURL = URL(string: "https://github.com/algophobic-dev/Kestrel-EFB-App#readme")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var downloads: [WKDownload: URL] = [:]

    // MARK: Launch

    func applicationDidFinishLaunching(_ note: Notification) {
        let config = WKWebViewConfiguration()
        // The web app prints with window.print(), which a web view ignores. Route it to the native print dialog.
        let script = "window.print = function () { window.webkit.messageHandlers.kestrel.postMessage('print'); };"
        config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(self, name: "kestrel")

        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Kestrel EFB"
        window.minSize = NSSize(width: 420, height: 560)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("KestrelMainWindow")
        window.makeKeyAndOrderFront(nil)

        NSApp.mainMenu = buildMenu()
        web.load(URLRequest(url: siteURL))
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: Menu bar

    /// A menu item that runs one web-app function.
    func item(_ title: String, _ js: String, key: String = "", mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: #selector(runScript(_:)), keyEquivalent: key)
        it.keyEquivalentModifierMask = mods
        it.representedObject = js
        it.target = self
        return it
    }
    func native(_ title: String, _ action: Selector, key: String = "", mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
        let it = NSMenuItem(title: title, action: action, keyEquivalent: key)
        it.keyEquivalentModifierMask = mods
        it.target = self
        return it
    }
    func menu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
        let m = NSMenu(title: title)
        items.forEach { m.addItem($0) }
        let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        top.submenu = m
        return top
    }
    var sep: NSMenuItem { .separator() }

    func buildMenu() -> NSMenu {
        let main = NSMenu()

        // Kestrel EFB
        let services = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        services.submenu = NSMenu(title: "Services"); NSApp.servicesMenu = services.submenu
        let hideOthers = NSMenuItem(title: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        main.addItem(menu("Kestrel EFB", [
            NSMenuItem(title: "About Kestrel EFB", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""),
            sep,
            item("Aircraft and Settings…", "Kestrel.tab('more')", key: ","),
            item("Sync Now", "Kestrel.syncNow()", key: "s", mods: [.command, .shift]),
            sep, services, sep,
            NSMenuItem(title: "Hide Kestrel EFB", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"),
            hideOthers,
            NSMenuItem(title: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: ""),
            sep,
            NSMenuItem(title: "Quit Kestrel EFB", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"),
        ]))

        // File
        main.addItem(menu("File", [
            item("New Flight Plan", "Kestrel.newPlan()", key: "n"),
            item("Save Flight", "Kestrel.savePlan()", key: "s"),
            sep,
            native("Print NavLog…", #selector(printNavlog(_:)), key: "p"),
            sep,
            NSMenuItem(title: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"),
        ]))

        // Edit (standard items, so copy, paste and undo work in text fields)
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        main.addItem(menu("Edit", [
            NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"), redo, sep,
            NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"),
            NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"),
            NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"),
            NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"),
            sep,
            item("Find Airport or Enter Route", "Kestrel.search()", key: "f"),
        ]))

        // View: one item per tab, then reload and full screen
        let tabs: [(String, String, String)] = [
            ("Airports", "airports", "1"), ("Maps", "maps", "2"), ("Plates", "plates", "3"), ("Documents", "documents", "4"), ("Imagery", "imagery", "5"),
            ("Flights", "flights", "6"), ("ScratchPads", "scratch", "7"), ("Checklist", "checklist", "8"), ("Logbook", "logbook", "9"), ("More", "more", "0"),
        ]
        let fullScreen = NSMenuItem(title: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        main.addItem(menu("View", tabs.map { item($0.0, "Kestrel.tab('\($0.1)')", key: $0.2) } + [
            sep,
            native("Reload", #selector(reload(_:)), key: "r"),
            fullScreen,
        ]))

        // Map: charts, base maps, overlays, zoom, position
        let charts = [("None", "none"), ("VFR Sectional", "sec"), ("VFR Terminal", "tac"), ("IFR Low", "low"), ("IFR High", "high")]
        let bases = [("Dark", "dark"), ("Light", "light"), ("Topographic", "topo"), ("Satellite", "sat")]
        let overlays = [("Airports and Navaids", "aero"), ("Airspace", "airspace"), ("Radar", "radar"), ("Flight Category", "cat"), ("SIGMETs", "sigmet"),
                        ("Icing Advisories", "ice"), ("Turbulence Advisories", "turb"), ("IFR Advisories", "ifr"),
                        ("Terrain Hazard", "hazard"), ("Obstacles", "obstacles"), ("Traffic", "traffic")]
        main.addItem(menu("Map", [
            menu("Chart", charts.map { item($0.0, "Kestrel.chart('\($0.1)')") }),
            menu("Base Map", bases.map { item($0.0, "Kestrel.base('\($0.1)')") }),
            menu("Show or Hide Layer", overlays.map { item($0.0, "Kestrel.layer('\($0.1)')") }),
            sep,
            item("Zoom In", "Kestrel.zoom(1)", key: "+"),
            item("Zoom Out", "Kestrel.zoom(-1)", key: "-"),
            item("Center on Route", "Kestrel.centre()", key: "e"),
            sep,
            item("Follow My Position", "Kestrel.follow()", key: "l"),
            item("Start or Stop Track Log", "Kestrel.record()", key: "t", mods: [.command, .shift]),
        ]))

        // Flight: the flight plan panel
        main.addItem(menu("Flight", [
            item("Show or Hide Flight Plan", "Kestrel.toggleFpl()", key: "d"),
            sep,
            item("Edit Route", "Kestrel.mode('edit')", key: "1", mods: [.command, .option]),
            item("NavLog", "Kestrel.mode('navlog')", key: "2", mods: [.command, .option]),
            item("Profile", "Kestrel.mode('profile')", key: "3", mods: [.command, .option]),
            item("3D View", "Kestrel.mode('3d')", key: "4", mods: [.command, .option]),
            sep,
            item("Suggest Routes…", "Kestrel.routes()", key: "r", mods: [.command, .shift]),
            item("Procedures…", "Kestrel.procedures()", key: "p", mods: [.command, .shift]),
            item("Reverse Route", "Kestrel.reverse()"),
        ]))

        // Window
        let windowMenu = menu("Window", [
            NSMenuItem(title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"),
            NSMenuItem(title: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: ""),
            sep,
            NSMenuItem(title: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: ""),
        ])
        main.addItem(windowMenu); NSApp.windowsMenu = windowMenu.submenu

        // Help
        let help = menu("Help", [native("Kestrel EFB Help", #selector(openHelp(_:)), key: "?")])
        main.addItem(help); NSApp.helpMenu = help.submenu
        return main
    }

    // MARK: Menu actions

    @objc func runScript(_ sender: NSMenuItem) {
        guard let js = sender.representedObject as? String else { return }
        // Beep if the page has not finished loading yet, so the item does not fail silently.
        web.evaluateJavaScript("window.Kestrel ? (\(js), true) : false") { result, _ in
            if (result as? Bool) != true { NSSound.beep() }
        }
    }
    @objc func reload(_ sender: Any?) {
        if web.url == nil || web.url?.scheme == "about" { web.load(URLRequest(url: siteURL)) } else { web.reload() }
    }
    @objc func openHelp(_ sender: Any?) { NSWorkspace.shared.open(helpURL) }
    @objc func printNavlog(_ sender: Any?) {
        web.evaluateJavaScript("window.Kestrel ? Kestrel.preparePrint() : false") { result, _ in
            if (result as? Bool) == true { self.runPrint() } else { NSSound.beep() }
        }
    }
    func runPrint() {
        let info = NSPrintInfo.shared
        info.horizontalPagination = .fit
        info.isVerticallyCentered = false
        info.orientation = .landscape
        let op = web.printOperation(with: info)
        op.view?.frame = web.bounds
        op.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.body as? String == "print" { runPrint() }
    }

    // MARK: Links, new windows, file pickers

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { decisionHandler(.download); return }
        guard let url = action.request.url, let scheme = url.scheme else { decisionHandler(.allow); return }
        let isWeb = scheme == "http" || scheme == "https"
        let mainFrame = action.targetFrame?.isMainFrame ?? true
        // Keep the app's own pages in the window. Send every other site to the default browser.
        if isWeb && mainFrame && url.host != siteURL.host {
            NSWorkspace.shared.open(url); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }   // target="_blank" links
        return nil
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    // MARK: Downloads (logbook CSV, track GPX) go to the Downloads folder

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let base = (suggestedFilename as NSString).deletingPathExtension, ext = (suggestedFilename as NSString).pathExtension
        var dest = folder.appendingPathComponent(suggestedFilename), n = 1
        while FileManager.default.fileExists(atPath: dest.path) {   // never overwrite an existing file
            n += 1
            dest = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
        }
        downloads[download] = dest
        completionHandler(dest)
    }
    func downloadDidFinish(_ download: WKDownload) {
        if let dest = downloads.removeValue(forKey: download) { NSWorkspace.shared.activateFileViewerSelecting([dest]) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) { downloads.removeValue(forKey: download) }

    // MARK: No connection

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let code = (error as NSError).code
        if code == NSURLErrorCancelled || code == 102 { return }   // 102: the load turned into a download
        let html = """
        <html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#10161a;color:#eef3f6;font:15px -apple-system,sans-serif;text-align:center">
        <div><h2 style="margin:0 0 8px">Kestrel EFB could not load</h2>
        <p style="color:#93a3ae;margin:0 0 16px">Check your internet connection, then select Reload.</p>
        <a href="\(siteURL.absoluteString)" style="background:#2bb3a0;color:#06211d;padding:8px 16px;border-radius:6px;font-weight:600;text-decoration:none">Reload</a></div>
        </body></html>
        """
        webView.loadHTMLString(html, baseURL: siteURL)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
