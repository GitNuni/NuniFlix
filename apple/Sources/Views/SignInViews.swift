import SwiftUI
import CoreImage.CIFilterBuiltins
#if os(iOS)
import AuthenticationServices
#endif

/// First run: where's the NuniFlix server?
struct ServerView: View {
    @EnvironmentObject var model: AppModel
    @State private var address = ""
    @State private var checking = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 30) {
            model.appTheme.wordmark("NuniFlix", size: 64)
            Text("What's your NuniFlix address?").font(.title2)
            #if os(tvOS)
            Text("Or open NuniFlix on your iPhone on the same Wi-Fi: it'll offer to set up this TV.").font(.callout).foregroundStyle(.green)
            #endif
            Text("The same one you open in the browser, like http://192.168.0.49:8095 or https://requests.example.com")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            TextField("http://192.168.0.49:8095", text: $address)
                .textContentType(.URL)
                .autocorrectionDisabled()
                #if os(iOS)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .textFieldStyle(.roundedBorder)
                #endif
                .frame(maxWidth: 700)
                .onSubmit { Task { await connect() } }
            if let error { Text(error).foregroundStyle(.red).multilineTextAlignment(.center) }
            Button {
                Task { await connect() }
            } label: {
                if checking { ProgressView() } else { Text("Connect").frame(minWidth: 200) }
            }
            .disabled(address.trimmingCharacters(in: .whitespaces).isEmpty || checking)
        }
        .padding(Metrics.gutter)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(model.appTheme.backgroundView)
    }

    private func connect() async {
        var s = address.trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasSuffix("/") { s.removeLast() }
        if !s.contains("://") { s = "http://" + s }
        guard let u = URL(string: s), u.host != nil else { error = "That doesn't look like an address."; return }
        checking = true; error = nil
        defer { checking = false }
        if await API.shared.check(u) { model.setServer(u) }
        else { error = "No NuniFlix there. Check the address, and that your \(platformName) is on the same network (or use the https address)." }
    }

    private var platformName: String {
        #if os(tvOS)
        return "Apple TV"
        #else
        return "phone"
        #endif
    }
}

/// Signing in. On the TV: a code to approve on your phone (no typing passwords with a remote).
/// On the phone: Plex / Discord / Fluxer in the browser, or a Jellyfin username and password.
struct SignInView: View {
    @EnvironmentObject var model: AppModel
    @State private var options: AuthOptions?
    @State private var error: String?
    @State private var showPassword = false

    var body: some View {
        GeometryReader { geo in
            ScrollView {
                VStack(spacing: Metrics.spacing * 2.4) {
                    VStack(spacing: 8) {
                        model.appTheme.wordmark(model.brand, size: logoSize)
                        Text(model.server?.host() ?? "").font(.footnote.monospaced()).foregroundStyle(.secondary)
                    }
                    #if os(tvOS)
                    TVCodeView()
                    if options?.jellyfin == true {
                        Button(showPassword ? "Hide" : "Sign in with a Jellyfin username and password") { showPassword.toggle() }
                        if showPassword { JellyfinForm() }
                    }
                    #else
                    VStack(spacing: 12) {
                        Text("Sign in to request and watch").font(.headline).frame(maxWidth: .infinity, alignment: .leading)
                        PhoneSignIn(options: options)
                        if options?.jellyfin == true {
                            SignInButton(title: "Sign in with Jellyfin", icon: "server.rack", tint: Color(hex: 0xAA5CC3)) {
                                withAnimation { showPassword.toggle() }
                            }
                            if showPassword { JellyfinForm().transition(.opacity.combined(with: .move(edge: .top))) }
                        }
                    }
                    .frame(maxWidth: 420)
                    #endif
                    if let error { Text(error).foregroundStyle(.red).multilineTextAlignment(.center) }
                    Button("Use a different server") { Task { await model.clearServer() } }
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        #if os(iOS)
                        .buttonStyle(.borderless)
                        #endif
                }
                .padding(Metrics.gutter * 1.5)
                .frame(maxWidth: .infinity, minHeight: geo.size.height)  // centred when it fits, scrolls when it doesn't
            }
        }
        .background(model.appTheme.backgroundView)
        .task {
            do { options = try await API.shared.get("/auth/options") }
            catch { if !(error is CancellationError) { self.error = error.localizedDescription } }
        }
    }

    private var logoSize: CGFloat {
        #if os(tvOS)
        return 96
        #else
        return 52
        #endif
    }
}

#if os(iOS)
/// One look for every sign-in option: full width, same height, the service's colour.
struct SignInButton: View {
    var title: String
    var icon: String
    var tint: Color
    var text: Color = .white
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 50)
                .foregroundStyle(text)
                .background(tint, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}
#endif

#if os(tvOS)
struct TVCodeView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject private var quick = QuickConnectTV.shared
    @State private var code: TVCode?
    @State private var error: String?

    var body: some View {
        HStack(alignment: .center, spacing: 80) {
            if let code, let qr = QR.image(code.url) {
                Image(uiImage: qr).interpolation(.none).resizable().frame(width: 360, height: 360)
                    .padding(20).background(.white, in: RoundedRectangle(cornerRadius: 24))
            }
            VStack(alignment: .leading, spacing: 24) {
                if quick.phoneConnected {
                    Label("Confirm on your iPhone", systemImage: "iphone.radiowaves.left.and.right").font(.title2.bold()).foregroundStyle(.green)
                    Text("Your iPhone will ask if it matches this code:").foregroundStyle(.secondary)
                } else {
                    Text("Sign in with your phone").font(.title2.bold())
                    Text("Got NuniFlix on your iPhone? Open it on the same Wi-Fi and it'll offer to set up this TV.").foregroundStyle(.secondary)
                }
                Text("Scan the code with your phone's camera, or open this address in NuniFlix on your phone or computer:")
                    .foregroundStyle(.secondary)
                Text(code?.link ?? " ").font(.title3.monospaced())
                Text("and enter").foregroundStyle(.secondary)
                Text(code.map { spaced($0.code) } ?? "······")
                    .font(.system(size: 90, weight: .heavy, design: .monospaced))
                    .foregroundStyle(.white)
                if let error { Text(error).foregroundStyle(.red) }
            }
            .frame(maxWidth: 900, alignment: .leading)
        }
        .task { await run() }
    }

    private func spaced(_ c: String) -> String { String(c.prefix(3)) + " " + String(c.dropFirst(3)) }

    /// Get a code, then ask every couple of seconds whether someone approved it. New code when it expires.
    private func run() async {
        while !Task.isCancelled {
            do {
                let (data, _) = try await API.shared.post("/auth/tv/start")
                let c: TVCode = try API.shared.decode(data)
                code = c; error = nil
                QuickConnectTV.shared.offer(code: c.code)
                let until = Date().addingTimeInterval(TimeInterval(c.expires - 10))
                while Date() < until && !Task.isCancelled {
                    try await Task.sleep(for: .seconds(2.5))
                    do {
                        let (d, status) = try await API.shared.post("/auth/tv/check", ["state": c.state, "device": AppModel.deviceName])
                        if status == 200 { try model.didSignIn(d); return }
                    } catch let e as APIError where e.status == 410 {
                        break
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                self.error = error.localizedDescription
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }
}

enum QR {
    static func image(_ text: String) -> UIImage? {
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(text.utf8)
        f.correctionLevel = "M"
        guard let out = f.outputImage, let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
#endif

#if os(iOS)
struct PhoneSignIn: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.openURL) private var openURL
    var options: AuthOptions?
    @State private var waiting: String?
    @State private var error: String?
    @State private var poll: Task<Void, Never>?
    @State private var web = WebSignIn()

    var body: some View {
        VStack(spacing: 12) {
            if options?.plex == true {
                SignInButton(title: "Sign in with Plex", icon: "play.rectangle.fill", tint: Color(hex: 0xE5A00D), text: .black) { start("plex") }
            }
            if options?.discord == true {
                SignInButton(title: "Sign in with Discord", icon: "bubble.left.and.bubble.right.fill", tint: Color(hex: 0x5865F2)) { start("discord") }
            }
            if options?.fluxer == true {
                SignInButton(title: "Sign in with Fluxer", icon: "bubble.left.fill", tint: Color(hex: 0x4641D9)) { start("fluxer") }
            }
            if let waiting {
                HStack { ProgressView(); Text("Signing in with \(waiting)…") }
                    .font(.callout).foregroundStyle(.secondary)
            }
            if let error { Text(error).foregroundStyle(.red).multilineTextAlignment(.center) }
        }
        .onDisappear { poll?.cancel(); web.close() }
    }

    /// Plex / Discord / Fluxer open in Apple's sign-in sheet on top of the app (not off in Safari), so the app stays
    /// awake to see the sign-in finish, then closes the sheet itself. Closing the sheet early stops waiting.
    private func start(_ kind: String) {
        poll?.cancel()
        web.close()
        error = nil
        poll = Task {
            do {
                let (data, _) = try await API.shared.post("/auth/\(kind)/start")
                let s: StartURL = try API.shared.decode(data)
                guard let u = URL(string: s.url) else { return }
                waiting = ["plex": "Plex", "discord": "Discord", "fluxer": "Fluxer"][kind] ?? kind
                web.open(u) { poll?.cancel(); waiting = nil }
                let until = Date().addingTimeInterval(600)
                while Date() < until && !Task.isCancelled {
                    try await Task.sleep(for: .seconds(1.5))
                    do {
                        let (d, status) = try await API.shared.post("/auth/\(kind)/check", ["state": s.state, "device": AppModel.deviceName])
                        if status == 200 { web.close(); try model.didSignIn(d); return }
                    } catch let e as APIError where e.status == 0 {
                        continue  // a blip on the network: keep waiting rather than calling the whole thing off
                    }
                }
                web.close()
                waiting = nil
            } catch is CancellationError {
            } catch {
                web.close()
                waiting = nil
                self.error = error.localizedDescription
            }
        }
    }
}

/// Apple's in-app sign-in sheet. NuniFlix finds out the sign-in finished by asking its server, not from a redirect,
/// so the callback scheme is never actually used; it's just what the sheet requires.
@MainActor
final class WebSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func open(_ url: URL, onClosed: @escaping @MainActor () -> Void) {
        let s = ASWebAuthenticationSession(url: url, callbackURLScheme: "nuniflix") { [weak self] _, _ in
            Task { @MainActor in
                guard self?.session != nil else { return }  // we closed it ourselves (signed in): nothing to undo
                self?.session = nil
                onClosed()
            }
        }
        s.presentationContextProvider = self
        s.prefersEphemeralWebBrowserSession = false  // remember the Plex/Discord login for next time
        session = s
        s.start()
    }

    func close() {
        let s = session
        session = nil
        s?.cancel()
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
        }
    }
}
#endif

struct JellyfinForm: View {
    @EnvironmentObject var model: AppModel
    @State private var user = ""
    @State private var pass = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 16) {
            TextField("Jellyfin username", text: $user)
                .textContentType(.username).autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never).textFieldStyle(.roundedBorder)
                #endif
            SecureField("Password", text: $pass)
                .textContentType(.password)
                #if os(iOS)
                .textFieldStyle(.roundedBorder)
                #endif
            if let error { Text(error).foregroundStyle(.red) }
            Button {
                Task {
                    busy = true; error = nil
                    defer { busy = false }
                    do {
                        let (d, _) = try await API.shared.post("/auth/jellyfin", ["username": user, "password": pass, "device": AppModel.deviceName])
                        try model.didSignIn(d)
                    } catch { self.error = error.localizedDescription }
                }
            } label: {
                Group { if busy { ProgressView() } else { Text("Sign in").font(.body.weight(.semibold)) } }
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            .disabled(user.isEmpty || busy)
            #if os(iOS)
            .buttonStyle(.borderedProminent).tint(Color(hex: 0xAA5CC3))
            #endif
        }
        .frame(maxWidth: 600)
    }
}
