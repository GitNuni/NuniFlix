import AVKit
import SwiftUI

// Watching in the app. The server finds the title on the person's own Plex/Jellyfin and passes the video through
// (see server/app/player.py); here it's Apple's own player, which brings the standard controls, AirPlay and
// picture-in-picture. Progress goes back every 10 seconds so Plex/Jellyfin keep the resume point and history.

struct PlayOptions: Decodable {
    var source: String
    var items: [PlayItem]
}

struct PlayItem: Decodable, Identifiable, Hashable {
    var id: String
    var title: String
    var season: Int?
    var episode: Int?
    var resume: Double
    var duration: Double
    var watched: Bool

    /// Worth offering "Resume": past the first minute and not in the end credits.
    var canResume: Bool { resume > 60 && (duration == 0 || resume < duration * 0.93) }
    var code: String? {
        guard let season, let episode else { return nil }
        return "S\(season) · E\(episode)"
    }
}

private struct StreamStart: Decodable {
    var url: String
    var session: String
}

/// One playback: starts the stream, reports progress, moves on to the next episode, and says "stopped" at the end.
@MainActor
final class Playback: ObservableObject {
    let player = AVPlayer()
    @Published var error: String?
    @Published var finished = false
    private var queue: [PlayItem]
    private var current: PlayItem
    private var session: String?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var statusObserver: NSKeyValueObservation?
    private var lastReport = Date.distantPast

    init(item: PlayItem, upNext: [PlayItem]) {
        current = item
        queue = upNext
    }

    static var platform: String {
        #if os(tvOS)
        return "tvos"
        #else
        return "ios"
        #endif
    }

    func start(from position: Double) async {
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        #endif
        do {
            let (data, _) = try await API.shared.post("/play/start", ["id": current.id, "offset": 0, "platform": Self.platform])
            let s: StreamStart = try API.shared.decode(data)
            guard let base = API.shared.base, let url = URL(string: base.absoluteString + s.url) else {
                throw APIError(status: 0, message: "Bad stream address.")
            }
            session = s.session
            let playerItem = AVPlayerItem(url: url)
            playerItem.externalMetadata = metadata()
            player.replaceCurrentItem(with: playerItem)
            watch(playerItem)
            if position > 0 { await player.seek(to: CMTime(seconds: position, preferredTimescale: 600)) }
            player.play()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func metadata() -> [AVMetadataItem] {
        let title = AVMutableMetadataItem()
        title.identifier = .commonIdentifierTitle
        title.value = (current.code.map { "\($0)  " } ?? "") + current.title as NSString
        title.extendedLanguageTag = "und"
        return [title]
    }

    private func watch(_ playerItem: AVPlayerItem) {
        if timeObserver == nil {
            timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 5, preferredTimescale: 1), queue: .main) { [weak self] _ in
                Task { @MainActor in self?.report(force: false) }
            }
        }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: playerItem, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.next() }
        }
        statusObserver = playerItem.observe(\.status) { [weak self] item, _ in
            guard item.status == .failed else { return }
            let msg = item.error?.localizedDescription ?? "The video wouldn't play."
            Task { @MainActor in self?.error = msg }
        }
    }

    private var position: Double {
        let t = player.currentTime().seconds
        return t.isFinite ? max(0, t) : 0
    }

    private var duration: Double {
        let d = player.currentItem?.duration.seconds ?? 0
        return d.isFinite ? d : current.duration
    }

    private func report(force: Bool) {
        guard let session, force || Date().timeIntervalSince(lastReport) >= 10 else { return }
        lastReport = Date()
        let state = player.timeControlStatus == .paused ? "paused" : "playing"
        let body: [String: Any] = ["session": session, "position": position, "duration": duration, "state": state]
        Task { try? await API.shared.post("/play/progress", body) }
    }

    /// Finished one: on to the next episode, or close.
    private func next() async {
        await stopStream()
        guard !queue.isEmpty else { finished = true; return }
        current = queue.removeFirst()
        await start(from: 0)
    }

    private func stopStream() async {
        guard let session else { return }
        self.session = nil
        _ = try? await API.shared.post("/play/progress", ["session": session, "position": position, "duration": duration, "state": "stopped"])
    }

    func close() {
        player.pause()
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        statusObserver = nil
        Task { await stopStream(); player.replaceCurrentItem(with: nil) }
    }
}

/// Full screen: Apple's player.
struct PlayerScreen: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var playback: Playback
    let start: Double

    init(item: PlayItem, upNext: [PlayItem], start: Double) {
        _playback = StateObject(wrappedValue: Playback(item: item, upNext: upNext))
        self.start = start
    }

    var body: some View {
        PlayerController(player: playback.player)
            .ignoresSafeArea()
            .background(Color.black)
            .task { await playback.start(from: start) }
            .onDisappear { playback.close() }
            .onChange(of: playback.finished) { _, done in if done { dismiss() } }
            .alert("Can't play this", isPresented: Binding(get: { playback.error != nil }, set: { if !$0 { playback.error = nil } })) {
                Button("OK") { dismiss() }
            } message: {
                Text(playback.error ?? "")
            }
    }
}

private struct PlayerController: UIViewControllerRepresentable {
    let player: AVPlayer

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let vc = AVPlayerViewController()
        vc.player = player
        #if os(iOS)
        vc.allowsPictureInPicturePlayback = true
        vc.canStartPictureInPictureAutomaticallyFromInline = true
        #endif
        return vc
    }

    func updateUIViewController(_ vc: AVPlayerViewController, context: Context) {}
}

/// A show's episodes, season by season. "Next up" is the first one not watched yet.
struct EpisodePicker: View {
    @Environment(\.dismiss) private var dismiss
    var title: String
    var episodes: [PlayItem]
    var choose: (PlayItem) -> Void

    private var seasons: [(Int, [PlayItem])] {
        Dictionary(grouping: episodes) { $0.season ?? 0 }.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }

    private var nextUp: PlayItem? {
        episodes.first { $0.canResume } ?? episodes.first { !$0.watched } ?? episodes.first
    }

    var body: some View {
        NavigationStack {
            List {
                if let n = nextUp {
                    Section("Next up") { row(n) }
                }
                ForEach(seasons, id: \.0) { season, eps in
                    Section(season == 0 ? "Specials" : "Season \(season)") {
                        ForEach(eps) { row($0) }
                    }
                }
            }
            .navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            #endif
        }
    }

    private func row(_ e: PlayItem) -> some View {
        Button { choose(e) } label: {
            HStack(spacing: 14) {
                Image(systemName: e.watched ? "checkmark.circle.fill" : (e.canResume ? "play.circle" : "circle"))
                    .foregroundStyle(e.watched ? .green : .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(e.title.isEmpty ? "Episode \(e.episode ?? 0)" : e.title)
                    Text([e.code, e.duration > 0 ? "\(Int(e.duration / 60))m" : nil, e.canResume ? "\(Int((e.duration - e.resume) / 60))m left" : nil]
                            .compactMap { $0 }.joined(separator: "  ·  "))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
            }
        }
    }
}

/// "1:02:03" / "4:05"
func clock(_ seconds: Double) -> String {
    let s = Int(seconds), h = s / 3600, m = (s % 3600) / 60, sec = s % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
}
