import SwiftUI

/// One profile in the owner's Plex Home (server: /api/profiles).
struct PlexProfile: Decodable, Identifiable, Hashable {
    var id: String
    var name: String
    var thumb: String?
    var pin: Bool
    var admin: Bool
    var kid: Bool
    var current: Bool
}

struct PlexProfiles: Decodable { var profiles: [PlexProfile] }

#if os(tvOS)
/// "Who's watching?": right after signing in on the Apple TV (and from Settings → Switch profile), pick which Plex Home
/// profile this TV is. Profiles with a PIN get a number pad. Switching makes a fresh session as that profile.
struct ProfilePicker: View {
    @EnvironmentObject var model: AppModel
    @State private var asking: PlexProfile?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ZStack {
            model.appTheme.backgroundView.ignoresSafeArea()
            Color.black.opacity(0.45).ignoresSafeArea()
            if let p = asking {
                PinPad(profile: p, busy: busy, error: error) { pin in pick(p, pin) } cancel: { asking = nil; error = nil }
            } else {
                people
            }
        }
    }

    private var people: some View {
        VStack(spacing: 50) {
            Text("Who's watching?").font(.system(size: 64, weight: .heavy)).foregroundStyle(.white)
            HStack(spacing: 50) {
                ForEach(model.profiles) { p in
                    Button { p.current ? model.choosingProfile = false : (p.pin ? (asking = p) : pick(p, nil)) } label: {
                        VStack(spacing: 16) {
                            ProfileAvatar(profile: p, size: 200)
                            Text(p.name).font(.title3.weight(.semibold)).foregroundStyle(.white).lineLimit(1)
                            Text([p.current ? "Signed in" : nil, p.admin ? "Owner" : nil, p.kid ? "Kids" : nil, p.pin ? "🔒 PIN" : nil]
                                    .compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.white.opacity(0.7))
                        }
                        .frame(width: 240)
                    }
                    .buttonStyle(.card)
                    .disabled(busy)
                }
            }
            if busy { ProgressView() }
            if let error { Text(error).foregroundStyle(.red) }
        }
    }

    private func pick(_ p: PlexProfile, _ pin: String?) {
        busy = true; error = nil
        Task {
            defer { busy = false }
            do {
                var body = ["user": p.id, "device": AppModel.deviceName]
                if let pin { body["pin"] = pin }
                let (d, _) = try await API.shared.post("/profiles/switch", body)
                try model.didSignIn(d, askProfile: false)
                await model.loadProfiles()
                model.choosingProfile = false
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

struct ProfileAvatar: View {
    var profile: PlexProfile
    var size: CGFloat
    var body: some View {
        ZStack {
            Circle().fill(Color(hex: 0xE5A00D))
            Text(String(profile.name.prefix(1)).uppercased()).font(.system(size: size * 0.42, weight: .heavy)).foregroundStyle(Color(hex: 0x1F1F1F))
            if let t = profile.thumb { Picture(url: t).clipShape(Circle()) }
        }
        .frame(width: size, height: size)
    }
}

/// Four digits, typed with the remote on an on-screen pad (no keyboard screen).
private struct PinPad: View {
    var profile: PlexProfile
    var busy: Bool
    var error: String?
    var done: (String) -> Void
    var cancel: () -> Void
    @State private var digits = ""

    var body: some View {
        VStack(spacing: 36) {
            ProfileAvatar(profile: profile, size: 140)
            Text("Enter \(profile.name)'s PIN").font(.title2.weight(.bold)).foregroundStyle(.white)
            HStack(spacing: 24) {
                ForEach(0..<4, id: \.self) { i in
                    Circle().fill(i < digits.count ? Color.white : Color.white.opacity(0.2)).frame(width: 26, height: 26)
                }
            }
            if let error { Text(error).foregroundStyle(.red) }
            VStack(spacing: 20) {
                ForEach([["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["⌫", "0", "✕"]], id: \.self) { row in
                    HStack(spacing: 20) {
                        ForEach(row, id: \.self) { k in
                            Button { tap(k) } label: { Text(k).font(.system(size: 40, weight: .semibold)).frame(width: 120, height: 90) }
                                .disabled(busy)
                        }
                    }
                }
            }
        }
        .onChange(of: error) { _, e in if e != nil { digits = "" } }
    }

    private func tap(_ k: String) {
        switch k {
        case "⌫": if !digits.isEmpty { digits.removeLast() }
        case "✕": cancel()
        default:
            guard digits.count < 4 else { return }
            digits += k
            if digits.count == 4 { done(digits) }
        }
    }
}
#endif
