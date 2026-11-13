#if os(iOS)
import SwiftUI
import WebKit

/// On the iPhone and iPad the app is the NuniFlix website itself, so it always matches the web app and every server
/// update shows up without a new app build. (The Apple TV has no web views, so it keeps the native screens.)
///
/// - Signed in natively first; the session token is handed to the website as its sign-in cookie.
/// - Videos ("Play here") play in the website's <video>, which on iOS is Apple's own player: full screen, AirPlay, PiP.
/// - Plex / Discord / Fluxer sign-in popups (used when linking accounts) open as a sheet the website can close.
/// - Links elsewhere (Play in Plex, Jellyfin, trailers) open in their own app or Safari.
/// - Signing out on the website (its cookie goes away) signs the app out too.
struct WebAppView: View {
    @EnvironmentObject var model: AppModel
    @State private var failed: String?
    @State private var loading = true
    @State private var reload = 0

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let server = model.server, let token = API.shared.token {
                WebView(server: server, token: token, reload: reload, loading: $loading, failed: $failed) {
                    Task { await model.signOut() }
                }
                .ignoresSafeArea()
            }
            if loading && failed == nil {
                ProgressView().controlSize(.large).tint(.white)
            }
            if let failed {
                VStack(spacing: 16) {
                    Image(systemName: "wifi.exclamationmark").font(.system(size: 44)).foregroundStyle(.secondary)
                    Text("Can't reach NuniFlix").font(.title3.bold())
                    Text(failed).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Try again") { self.failed = nil; loading = true; reload += 1 }.buttonStyle(.borderedProminent)
                    Button("Use a different server") { Task { await model.clearServer() } }.font(.footnote).foregroundStyle(.secondary)
                }
                .padding(32)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black)
            }
        }
        .preferredColorScheme(.dark)
    }
}

private struct WebView: UIViewRepresentable {
    let server: URL
    let token: String
    let reload: Int
    @Binding var loading: Bool
    @Binding var failed: String?
    let signedOut: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true
        config.allowsAirPlayForMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []   // the website's muted trailers play by themselves
        config.applicationNameForUserAgent = "NuniFlixApp/1.0 Mobile/15E148 Safari/604.1"
        config.websiteDataStore = .default()
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.backgroundColor = .black
        web.scrollView.contentInsetAdjustmentBehavior = .never  // the website handles the notch and home bar itself
        context.coordinator.web = web
        config.websiteDataStore.httpCookieStore.add(context.coordinator)
        context.coordinator.signInAndLoad()
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.loadedReload != reload {
            context.coordinator.loadedReload = reload
            context.coordinator.signInAndLoad()
        }
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKHTTPCookieStoreObserver {
        var parent: WebView
        weak var web: WKWebView?
        var loadedReload = 0
        private var cookieSet = false
        private weak var popup: UIViewController?

        init(_ parent: WebView) {
            self.parent = parent
            loadedReload = parent.reload
        }

        static let cookieName = "nf_token"  // server: main.py COOKIE

        /// Give the website the app's session, then open it.
        func signInAndLoad() {
            guard let web, let host = parent.server.host() else { return }
            var props: [HTTPCookiePropertyKey: Any] = [
                .name: Self.cookieName, .value: parent.token, .domain: host, .path: "/",
                .expires: Date().addingTimeInterval(90 * 86400),
            ]
            if parent.server.scheme == "https" { props[.secure] = "TRUE" }
            guard let cookie = HTTPCookie(properties: props) else { return }
            web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { [weak self] in
                guard let self else { return }
                self.cookieSet = true
                web.load(URLRequest(url: self.parent.server))
            }
        }

        // MARK: signed out on the website -> sign the app out
        nonisolated func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
            Task { @MainActor in
                guard cookieSet, let host = parent.server.host() else { return }
                let cookies = await cookieStore.allCookies()
                let mine = cookies.first { $0.name == Self.cookieName && host.hasSuffix($0.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) }
                if mine == nil {
                    cookieSet = false
                    parent.signedOut()
                }
            }
        }

        // MARK: loading
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            parent.loading = false
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            fail(error)
        }

        private func fail(_ error: Error) {
            if (error as NSError).code == NSURLErrorCancelled { return }
            parent.loading = false
            parent.failed = "\(error.localizedDescription)\n\(parent.server.absoluteString)"
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()  // iOS reclaimed the page's memory while the app was in the background
        }

        // MARK: where links go
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url else { return .cancel }
            if isOurs(url) || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return .allow }
            // Embedded players (the YouTube trailer on title pages) load inside the page: never send those out.
            // Only the page itself going somewhere else (a link tapped) opens another app.
            if action.targetFrame?.isMainFrame == false { return .allow }
            if webView !== web { return .allow }  // inside a sign-in popup: plex.tv, discord.com, ...
            openOutside(url)
            return .cancel
        }

        private func isOurs(_ url: URL) -> Bool {
            url.host() == parent.server.host() && url.port == parent.server.port
        }

        /// Plex links open the Plex app when it's installed; everything else opens in its app or Safari.
        private func openOutside(_ url: URL) {
            if let app = DetailView.plexAppURL(url.absoluteString) {
                UIApplication.shared.open(app) { ok in if !ok { UIApplication.shared.open(url) } }
            } else {
                UIApplication.shared.open(url)
            }
        }

        // MARK: popups (window.open)
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url, url.scheme?.hasPrefix("http") == true, !isOurs(url) {
                // A link with target=_blank: Play in Plex, Jellyfin, the Trailer chip. Only when someone actually tapped
                // it: a click inside the embedded YouTube player (its logo, "Watch on YouTube") stays put.
                if action.navigationType == .linkActivated, action.sourceFrame.isMainFrame { openOutside(url) }
                return nil
            }
            // window.open("") for Plex / Discord / Fluxer sign-in: a real window the website can steer and close.
            let pop = WKWebView(frame: .zero, configuration: configuration)
            pop.navigationDelegate = self
            pop.uiDelegate = self
            let vc = UIViewController()
            vc.view = pop
            vc.isModalInPresentation = false
            topController()?.present(vc, animated: true)
            popup = vc
            return pop
        }

        func webViewDidClose(_ webView: WKWebView) {
            if webView !== web { popup?.dismiss(animated: true) }
        }

        private func topController() -> UIViewController? {
            var top = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?.rootViewController
            while let next = top?.presentedViewController { top = next }
            return top
        }

        // alert() / confirm() from the website
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
            await withCheckedContinuation { done in
                let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
                a.addAction(UIAlertAction(title: "OK", style: .default) { _ in done.resume() })
                topController()?.present(a, animated: true)
            }
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
            await withCheckedContinuation { done in
                let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
                a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done.resume(returning: false) })
                a.addAction(UIAlertAction(title: "OK", style: .default) { _ in done.resume(returning: true) })
                topController()?.present(a, animated: true)
            }
        }
    }
}
#endif
