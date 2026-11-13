import Network
import SwiftUI

// Quick connect: set up the Apple TV from a signed-in iPhone, no typing with the remote.
//
//   TV     advertises "_nuniflix._tcp" on the home network while it isn't signed in
//   phone  finds it, asks "Set up NuniFlix on <TV>?", connects and sends {"server": "<address>"}
//   TV     checks the address, starts its usual code sign-in (/api/auth/tv/start), sends back {"code": "…"}
//   phone  asks "Does your TV show <code>?"; yes -> POST /api/auth/tv/approve as the person; the TV's own polling signs it in
//
// No sign-in token crosses the network, only the server address and the code shown on the TV. Checking that code
// against the TV's screen is what stops another device on the Wi-Fi from posing as the TV.

let quickConnectService = "_nuniflix._tcp"

private func line(_ obj: [String: String]) -> Data {
    (try? JSONSerialization.data(withJSONObject: obj)).map { $0 + Data([0x0A]) } ?? Data()
}

private func parseLines(_ buffer: inout Data) -> [[String: String]] {
    var out: [[String: String]] = []
    while let nl = buffer.firstIndex(of: 0x0A) {
        let chunk = buffer[buffer.startIndex..<nl]
        buffer.removeSubrange(buffer.startIndex...nl)
        if let obj = try? JSONSerialization.jsonObject(with: chunk) as? [String: String] { out.append(obj) }
    }
    return out
}

#if os(tvOS)
@MainActor
final class QuickConnectTV: ObservableObject {
    static let shared = QuickConnectTV()
    /// A phone has connected and given us the server: show "Confirm on your iPhone".
    @Published var phoneConnected = false
    var onServer: ((URL) -> Void)?
    private var listener: NWListener?
    private var conn: NWConnection?
    private var buffer = Data()
    private var code: String?

    func start() {
        guard listener == nil, let l = try? NWListener(using: .tcp) else { return }
        l.service = NWListener.Service(name: AppModel.deviceName, type: quickConnectService)
        l.newConnectionHandler = { [weak self] c in Task { @MainActor in self?.accept(c) } }
        l.start(queue: .main)
        listener = l
    }

    func stop() {
        listener?.cancel(); listener = nil
        conn?.cancel(); conn = nil
        phoneConnected = false
    }

    /// The TV's current sign-in code (TVCodeView calls this each time it gets one).
    func offer(code: String) {
        self.code = code
        if phoneConnected { send(["code": code]) }
    }

    private func accept(_ c: NWConnection) {
        conn?.cancel()
        conn = c; buffer = Data()
        c.start(queue: .main)
        receive(c)
    }

    private func receive(_ c: NWConnection) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, done, err in
            Task { @MainActor in
                guard let self, c === self.conn else { return }
                if let data { self.buffer.append(data) }
                for msg in parseLines(&self.buffer) { await self.handle(msg) }
                if done || err != nil { self.phoneConnected = false; return }
                self.receive(c)
            }
        }
    }

    private func handle(_ msg: [String: String]) async {
        guard let s = msg["server"], let url = URL(string: s), url.host != nil else { return }
        guard await API.shared.check(url) else { send(["error": "The TV couldn't reach \(s). Is it on the same network?"]); return }
        onServer?(url)
        phoneConnected = true
        if let code { send(["code": code]) }
    }

    private func send(_ obj: [String: String]) {
        conn?.send(content: line(obj), completion: .contentProcessed { _ in })
    }
}
#endif

#if os(iOS)
/// The iPhone side: looks for TVs that want setting up, and walks through the handoff.
@MainActor
final class QuickConnectPhone: ObservableObject {
    static let shared = QuickConnectPhone()
    struct TV: Equatable { var name: String; var endpoint: NWEndpoint }
    @Published var waiting: TV?          // found, not yet asked about
    @Published var confirm: (tv: TV, code: String)?
    @Published var status: String?
    private var browser: NWBrowser?
    private var conn: NWConnection?
    private var buffer = Data()
    private var dismissed = Set<String>()

    func start() {
        guard browser == nil else { return }
        let b = NWBrowser(for: .bonjour(type: quickConnectService, domain: nil), using: .tcp)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in
                guard let self, self.confirm == nil else { return }
                let tvs = results.compactMap { r -> TV? in
                    if case let .service(name, _, _, _) = r.endpoint { return TV(name: name, endpoint: r.endpoint) }
                    return nil
                }
                self.waiting = tvs.first { !self.dismissed.contains($0.name) }
                #if DEBUG
                if ProcessInfo.processInfo.environment["NF_QC_AUTO"] != nil, let w = self.waiting { self.connect(w) }  // simulator testing only
                #endif
            }
        }
        b.start(queue: .main)
        browser = b
    }

    func notNow() {
        if let w = waiting { dismissed.insert(w.name) }
        waiting = nil
    }

    /// Connect, hand over the server address, wait for the TV's code.
    func connect(_ tv: TV) {
        guard let server = API.shared.base else { return }
        waiting = nil
        status = "Connecting to \(tv.name)…"
        conn?.cancel()
        let c = NWConnection(to: tv.endpoint, using: .tcp)
        conn = c; buffer = Data()
        c.stateUpdateHandler = { [weak self] st in
            Task { @MainActor in
                if case .failed = st { self?.status = "Couldn't reach \(tv.name). Try again from the TV." }
            }
        }
        c.start(queue: .main)
        c.send(content: line(["server": server.absoluteString]), completion: .contentProcessed { _ in })
        receive(c, tv)
        Task { try? await Task.sleep(for: .seconds(25)); if self.conn === c, self.confirm == nil { self.status = "\(tv.name) didn't answer."; c.cancel() } }
    }

    private func receive(_ c: NWConnection, _ tv: TV) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, done, err in
            Task { @MainActor in
                guard let self, c === self.conn else { return }
                if let data { self.buffer.append(data) }
                for msg in parseLines(&self.buffer) {
                    if let code = msg["code"] {
                        self.status = nil; self.confirm = (tv, code)
                        #if DEBUG
                        if ProcessInfo.processInfo.environment["NF_QC_AUTO"] != nil { Task { await self.approve() } }  // simulator testing only
                        #endif
                    }
                    if let e = msg["error"] { self.status = e }
                }
                if !(done || err != nil) { self.receive(c, tv) }
            }
        }
    }

    /// "Yes, it matches": approve the TV's code as this person.
    func approve() async {
        guard let pending = confirm else { return }
        confirm = nil
        do {
            _ = try await API.shared.post("/auth/tv/approve", ["code": pending.code])
            Haptics.play("success")
            status = "\(pending.tv.name) is signed in."
            dismissed.insert(pending.tv.name)
        } catch {
            status = error.localizedDescription
        }
        conn?.cancel(); conn = nil
        Task { try? await Task.sleep(for: .seconds(4)); self.status = nil }
    }

    func reject() {
        if let p = confirm { dismissed.insert(p.tv.name) }
        confirm = nil
        conn?.cancel(); conn = nil
    }
}

/// The banner and the code check, over the website in the iPhone app.
struct QuickConnectOverlay: View {
    @ObservedObject var qc = QuickConnectPhone.shared

    var body: some View {
        VStack {
            Spacer()
            if let tv = qc.waiting {
                card {
                    Label("Set up NuniFlix on \(tv.name)?", systemImage: "appletv.fill").font(.headline)
                    Text("Signs the TV in as you. No typing with the remote.").font(.footnote).foregroundStyle(.secondary)
                    HStack {
                        Button("Not now") { qc.notNow() }.buttonStyle(.bordered)
                        Button("Set up") { qc.connect(tv) }.buttonStyle(.borderedProminent)
                    }
                }
            } else if let s = qc.status {
                card { Text(s).font(.callout) }
            }
        }
        .padding(.bottom, 96)
        .animation(.spring(duration: 0.3), value: qc.waiting)
        .alert("Does \(qc.confirm?.tv.name ?? "the TV") show this code?",
               isPresented: Binding(get: { qc.confirm != nil }, set: { if !$0 { qc.reject() } })) {
            Button("Yes, sign it in") { Task { await qc.approve() } }
            Button("No", role: .cancel) { qc.reject() }
        } message: {
            Text(qc.confirm.map { String($0.code.prefix(3)) + " " + String($0.code.dropFirst(3)) } ?? "")
        }
    }

    private func card<C: View>(@ViewBuilder _ c: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10, content: c)
            .padding(16)
            .frame(maxWidth: 420, alignment: .leading)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .padding(.horizontal, 16)
            .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}
#endif
