import SwiftUI
import CoreImage.CIFilterBuiltins

/// First run: where's the NuniFlix server?
struct ServerView: View {
    @EnvironmentObject var model: AppModel
    @State private var address = ""
    @State private var checking = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 30) {
            Text("NuniFlix").font(.system(size: 64, weight: .black)).foregroundStyle(Color(hex: 0xE50914))
            Text("What's your NuniFlix address?").font(.title2)
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
        .background(ServiceTheme.nuniflix.backgroundView)
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
        ScrollView {
            VStack(spacing: 34) {
                Text(model.brand).font(.system(size: 56, weight: .black)).foregroundStyle(Color(hex: 0xE50914))
                #if os(tvOS)
                TVCodeView()
                #else
                PhoneSignIn(options: options)
                #endif
                if options?.jellyfin == true {
                    Button(showPassword ? "Hide" : "Sign in with a Jellyfin username and password") { showPassword.toggle() }
                        #if os(iOS)
                        .buttonStyle(.bordered)
                        #endif
                    if showPassword { JellyfinForm() }
                }
                if let error { Text(error).foregroundStyle(.red) }
                Button("Use a different server") { Task { await model.clearServer() } }
                    .font(.callout)
                    #if os(iOS)
                    .buttonStyle(.borderless)
                    #endif
            }
            .padding(Metrics.gutter)
            .frame(maxWidth: .infinity)
        }
        .background(ServiceTheme.nuniflix.backgroundView)
        .task {
            do { options = try await API.shared.get("/auth/options") } catch { self.error = error.localizedDescription }
        }
    }
}

#if os(tvOS)
struct TVCodeView: View {
    @EnvironmentObject var model: AppModel
    @State private var code: TVCode?
    @State private var error: String?

    var body: some View {
        HStack(alignment: .center, spacing: 80) {
            if let code, let qr = QR.image(code.url) {
                Image(uiImage: qr).interpolation(.none).resizable().frame(width: 360, height: 360)
                    .padding(20).background(.white, in: RoundedRectangle(cornerRadius: 24))
            }
            VStack(alignment: .leading, spacing: 24) {
                Text("Sign in with your phone").font(.title2.bold())
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

    var body: some View {
        VStack(spacing: 16) {
            if options?.plex == true {
                Button { start("plex") } label: { Label("Sign in with Plex", systemImage: "play.rectangle.fill").frame(maxWidth: 320) }
                    .buttonStyle(.borderedProminent).tint(Color(hex: 0xE5A00D)).foregroundStyle(.black)
            }
            if options?.discord == true {
                Button { start("discord") } label: { Label("Sign in with Discord", systemImage: "bubble.left.and.bubble.right.fill").frame(maxWidth: 320) }
                    .buttonStyle(.borderedProminent).tint(Color(hex: 0x5865F2))
            }
            if options?.fluxer == true {
                Button { start("fluxer") } label: { Label("Sign in with Fluxer", systemImage: "bubble.left.fill").frame(maxWidth: 320) }
                    .buttonStyle(.borderedProminent).tint(Color(hex: 0x4641D9))
            }
            if let waiting {
                HStack { ProgressView(); Text("Finish signing in with \(waiting), then come back here.") }
                    .font(.callout).foregroundStyle(.secondary)
            }
            if let error { Text(error).foregroundStyle(.red).multilineTextAlignment(.center) }
        }
        .controlSize(.large)
        .onDisappear { poll?.cancel() }
    }

    private func start(_ kind: String) {
        poll?.cancel()
        error = nil
        poll = Task {
            do {
                let (data, _) = try await API.shared.post("/auth/\(kind)/start")
                let s: StartURL = try API.shared.decode(data)
                guard let u = URL(string: s.url) else { return }
                waiting = ["plex": "Plex", "discord": "Discord", "fluxer": "Fluxer"][kind] ?? kind
                openURL(u)
                let until = Date().addingTimeInterval(600)
                while Date() < until && !Task.isCancelled {
                    try await Task.sleep(for: .seconds(2))
                    let (d, status) = try await API.shared.post("/auth/\(kind)/check", ["state": s.state, "device": AppModel.deviceName])
                    if status == 200 { try model.didSignIn(d); return }
                }
                waiting = nil
            } catch is CancellationError {
            } catch {
                waiting = nil
                self.error = error.localizedDescription
            }
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
            } label: { if busy { ProgressView() } else { Text("Sign in").frame(minWidth: 160) } }
            .disabled(user.isEmpty || busy)
            #if os(iOS)
            .buttonStyle(.borderedProminent).tint(Color(hex: 0xAA5CC3))
            #endif
        }
        .frame(maxWidth: 600)
    }
}
