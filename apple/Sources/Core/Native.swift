#if os(iOS)
import Combine
import SwiftUI
import UserNotifications

/// iPhone notifications through Apple's push service (server: apns.py). The website's Notifications switch asks for
/// them through the bridge in WebAppView; the device token goes to the server, which sends "approved", "ready to watch"…
/// Tapping a notification opens its page (`url` in the payload) in the app.
@MainActor
final class Push: NSObject, ObservableObject {
    static let shared = Push()

    /// A page to open, from a tapped notification ("/?item=movie:603").
    @Published var openPath: String?
    /// Notifications turned on in this app (remembered so the website's switch shows the right state at launch).
    var isOn: Bool {
        get { UserDefaults.standard.bool(forKey: "pushOn") }
        set { UserDefaults.standard.set(newValue, forKey: "pushOn") }
    }
    private var token: String? {
        get { UserDefaults.standard.string(forKey: "apnsToken") }
        set { UserDefaults.standard.set(newValue, forKey: "apnsToken") }
    }
    private var waiting: CheckedContinuation<String, Error>?

    /// Ask iOS, get a device token, give it to the server. Throws a message worth showing.
    func turnOn() async throws {
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        guard granted else {
            throw APIError(status: 0, message: "Notifications are off for NuniFlix. Turn them on in iPhone Settings → Notifications → NuniFlix.")
        }
        let t = try await deviceToken()
        _ = try await API.shared.post("/push/apns", ["token": t])
        isOn = true
    }

    func turnOff() async {
        if let token { _ = try? await API.shared.post("/push/apns/remove", ["token": token]) }
        isOn = false
    }

    /// At launch: tokens can change, so hand the server the current one again.
    func refresh() {
        guard isOn else { return }
        Task {
            guard let t = try? await deviceToken() else { return }
            _ = try? await API.shared.post("/push/apns", ["token": t])
        }
    }

    private func deviceToken() async throws -> String {
        try await withCheckedThrowingContinuation { c in
            waiting?.resume(throwing: CancellationError())
            waiting = c
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func registered(_ data: Data) {
        let t = data.map { String(format: "%02x", $0) }.joined()
        token = t
        waiting?.resume(returning: t)
        waiting = nil
    }

    func failed(_ error: Error) {
        waiting?.resume(throwing: APIError(status: 0, message: "iOS couldn't set up notifications: \(error.localizedDescription)"))
        waiting = nil
    }
}

extension Push: UNUserNotificationCenterDelegate {
    /// Show it even while the app is open.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let path = response.notification.request.content.userInfo["url"] as? String
        await MainActor.run { if let path, path.hasPrefix("/") { Push.shared.openPath = path } }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = Push.shared
        Push.shared.refresh()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in Push.shared.registered(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in Push.shared.failed(error) }
    }
}

/// Little taps for things worth feeling: a request sent, a swipe right, a match.
enum Haptics {
    @MainActor static func play(_ style: String) {
        switch style {
        case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
        case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
        case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
    }
}
#endif
