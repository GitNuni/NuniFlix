import Foundation
import Security

/// Which server, who's signed in. The token lives in the Keychain.
@MainActor
final class AppModel: ObservableObject {
    @Published var server: URL?
    @Published var signedIn = false
    @Published var me: Me?
    @Published var brand = "NuniFlix"
    /// The service being browsed: title pages opened from it keep its colours.
    @Published var theme = ServiceTheme.nuniflix
    /// The person's theme for NuniFlix's own screens (home, title pages, requests). Remembered on the device too,
    /// so the app opens in it before the server answers.
    @Published var themeID = UserDefaults.standard.string(forKey: "theme") ?? "nuniflix" {
        didSet { UserDefaults.standard.set(themeID, forKey: "theme") }
    }
    var appTheme: ServiceTheme { ServiceTheme.app(themeID) }

    func setTheme(_ id: String) async {
        themeID = id
        theme = appTheme
        _ = try? await API.shared.post("/me/prefs", ["theme": id])
    }

    init() {
        if let s = UserDefaults.standard.string(forKey: "server"), let u = URL(string: s) { server = u }
        API.shared.base = server
        API.shared.token = Keychain.get("token")
        #if DEBUG
        // Simulator testing only (not in TestFlight/App Store builds): start signed in with a given session token.
        if let t = ProcessInfo.processInfo.environment["NF_TEST_TOKEN"] { API.shared.token = t }
        #endif
        signedIn = server != nil && API.shared.token != nil
        API.shared.onUnauthorized = { [weak self] in self?.forget() }
    }

    static var deviceName: String {
        #if os(tvOS)
        return "Apple TV"
        #else
        return "iPhone app"
        #endif
    }

    func setServer(_ u: URL) {
        server = u
        API.shared.base = u
        UserDefaults.standard.set(u.absoluteString, forKey: "server")
    }

    func clearServer() async {
        await signOut()
        server = nil
        API.shared.base = nil
        UserDefaults.standard.removeObject(forKey: "server")
    }

    func didSignIn(_ data: Data) throws {
        let s: SignedIn = try API.shared.decode(data)
        Keychain.set("token", s.token)
        API.shared.token = s.token
        signedIn = true
        Task { await loadMe() }
    }

    func loadMe() async {
        me = try? await API.shared.get("/me")
        if let t = me?.prefs?.theme { themeID = t }
        if let me { UserDefaults.standard.set(me.prefs?.season ?? true, forKey: "season") }  // seasonal background, on unless turned off
        if let o: AuthOptions = try? await API.shared.get("/auth/options"), let n = o.name, !n.isEmpty {
            brand = n.hasSuffix("Flix") ? n : n + "Flix"
        }
    }

    func signOut() async {
        _ = try? await API.shared.post("/auth/logout")
        forget()
    }

    private func forget() {
        Keychain.delete("token")
        API.shared.token = nil
        signedIn = false
        me = nil
    }
}

enum Keychain {
    private static func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "nuniflix", kSecAttrAccount as String: key]
    }
    static func get(_ key: String) -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
    static func set(_ key: String, _ value: String) {
        delete(key)
        var q = query(key)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(q as CFDictionary, nil)
    }
    static func delete(_ key: String) {
        SecItemDelete(query(key) as CFDictionary)
    }
}
