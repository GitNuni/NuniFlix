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

    /// Worth offering "Resume or start over": some real progress, and not already in the end credits.
    var canResume: Bool { resume > 15 && (duration == 0 || resume < duration * 0.95) }
    var code: String? {
        guard let season, let episode else { return nil }
        return "S\(season) · E\(episode)"
    }
}

struct StreamStart: Decodable {
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
    private var starting = false
    /// Until the jump to the resume point is done, progress isn't sent (a 0:00 report would wipe the resume point).
    /// (Closing before then reports the resume point itself.)
    private var holdAt: Double?
    /// The title being watched ("movie"/"tv" + its NuniFlix id), for the subtitle search.
    private(set) var kind: String
    private(set) var extID: Int
    /// Live channels (channels.py): the channel tuned to, and the others for the Channels menu.
    private(set) var channelKey: String?
    var channels: [LiveChannel] = []
    /// The channel bug and "now / next" card that shows for a few seconds after tuning in, or during the ident.
    @Published var bug: LiveBug?
    /// Retro touches on live: a burst of static when changing channel, and "Please stand by" while it buffers.
    @Published var staticBurst = false
    @Published var standBy = false
    private var waitObserver: NSKeyValueObservation?
    private var waitTask: Task<Void, Never>?
    /// The Plex/Jellyfin subtitle track burned in (nil: whatever the server picks; 0: off).
    private(set) var subtitle: Int?
    /// OpenSubtitles text drawn over the picture, and the line showing right now.
    private var cues: [Cue] = []
    @Published var caption = ""
    private var captionObserver: Any?

    struct Cue { var start: Double; var end: Double; var text: String }

    init(item: PlayItem, upNext: [PlayItem], kind: String, extID: Int) {
        current = item
        queue = upNext
        self.kind = kind
        self.extID = extID
    }

    /// Live: tune to a channel instead of playing one title.
    convenience init(channel: String, channels: [LiveChannel]) {
        self.init(item: PlayItem(id: "", title: "", resume: 0, duration: 0, watched: false), upNext: [], kind: "movie", extID: 0)
        channelKey = channel
        self.channels = channels
    }

    static var platform: String {
        #if os(tvOS)
        return "tvos"
        #else
        return "ios"
        #endif
    }

    func start(from position: Double, stream pre: StreamStart? = nil) async {
        guard !starting, session == nil else { return }  // one stream at a time, even if the screen asks twice
        starting = true
        defer { starting = false }
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        #endif
        do {
            let s: StreamStart
            if let pre { s = pre } else {
                // at: the server marks the playlist to begin there (EXT-X-START), so it doesn't load 0:00 first
                var body: [String: Any] = ["id": current.id, "offset": 0, "at": position, "platform": Self.platform]
                if let subtitle { body["subtitle"] = subtitle }
                if channelKey != nil { body["live"] = true }
                let (data, _) = try await API.shared.post("/play/start", body)
                s = try API.shared.decode(data)
            }
            guard let base = API.shared.base, let url = URL(string: base.absoluteString + s.url) else {
                throw APIError(status: 0, message: "Bad stream address.")
            }
            session = s.session
            let playerItem = AVPlayerItem(url: url)
            playerItem.externalMetadata = metadata()
            player.replaceCurrentItem(with: playerItem)
            watch(playerItem)
            if position > 0 {
                holdAt = position
                defer { holdAt = nil }
                // The playlist says where to begin; if it didn't take, jump there once it's ready (a seek before that is dropped).
                await ready(playerItem)
                if abs(self.position - position) > 8 {
                    await player.seek(to: CMTime(seconds: position, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: CMTime(seconds: 2, preferredTimescale: 1))
                }
            }
            player.play()
        } catch is CancellationError {
            return
        } catch {
            if player.currentItem == nil { self.error = error.localizedDescription }  // already playing: not worth an alert
        }
    }

    /// Waits (up to 20 s) for the stream to be ready to play.
    private func ready(_ item: AVPlayerItem) async {
        for _ in 0..<80 where item.status != .readyToPlay {
            if item.status == .failed || player.currentItem !== item { return }
            try? await Task.sleep(for: .milliseconds(250))
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
        guard let session, holdAt == nil, force || Date().timeIntervalSince(lastReport) >= 10 else { return }
        lastReport = Date()
        let state = player.timeControlStatus == .paused ? "paused" : "playing"
        let body: [String: Any] = ["session": session, "position": position, "duration": duration, "state": state]
        Task { try? await API.shared.post("/play/progress", body) }
    }

    /// Finished one: on to the next episode, or close.
    private func next() async {
        await stopStream()
        if let channelKey { await tune(channelKey); return }  // live: whatever the channel shows next
        guard !queue.isEmpty else { finished = true; return }
        current = queue.removeFirst()
        subtitle = nil      // track numbers belong to one episode
        setCues([])
        await start(from: 0)
    }

    // MARK: live channels (server: channels.py)

    private var tuneTask = 0

    /// Join a channel part-way through whatever it's showing (or wait out the ident if the next show is about to start).
    /// shown: called once the channel is on screen (playing, or its ident while it waits for the next programme).
    func tune(_ key: String, shown done: ((Bool) -> Void)? = nil) async {
        var done = done
        defer { done?(false) }
        tuneTask += 1
        let me = tuneTask
        channelKey = key
        staticBurst = true
        Task { try? await Task.sleep(for: .milliseconds(650)); if me == self.tuneTask { self.staticBurst = false } }
        watchBuffering()
        let old = session; session = nil
        if let old { Task { _ = try? await API.shared.post("/play/progress", ["session": old, "position": 0, "state": "stopped"]) } }  // don't wait for it
        player.pause()
        subtitle = nil
        setCues([])
        let ch = channels.first { $0.key == key }
        let t: LiveTune
        let asked = Date()
        do { t = try await API.shared.get("/live/\(key)", ["tz": liveTZ, "platform": Self.platform]) } catch {
            if !(error is CancellationError), player.currentItem == nil { self.error = error.localizedDescription }
            return
        }
        guard me == tuneTask else {  // flipped again meanwhile
            if let s = t.stream { Task { _ = try? await API.shared.post("/play/progress", ["session": s.session, "position": 0, "state": "stopped"]) } }
            return
        }
        let p = t.program
        current = PlayItem(id: p.id, title: p.show.map { "\($0): \(p.title ?? "")" } ?? (p.title ?? ""), resume: 0, duration: p.end - p.start, watched: false)
        kind = p.kind; extID = p.ext ?? 0
        if t.offset < 0 {  // between programmes: the channel's ident, then it starts
            player.replaceCurrentItem(with: nil)
            staticBurst = false
            bug = LiveBug(channel: ch, now: p, next: t.next, startsAt: Date(timeIntervalSinceNow: -t.offset), host: t.host,
                          name: t.channel?.name, tagline: t.channel?.tagline, takeover: t.channel?.takeover != nil)
            done?(true); done = nil
            try? await Task.sleep(for: .seconds(-t.offset))
            guard me == tuneTask else { return }
        }
        let shown = LiveBug(channel: ch, now: p, next: t.next, startsAt: nil, host: t.host, name: t.channel?.name,
                            tagline: t.channel?.tagline, takeover: t.channel?.takeover != nil)
        bug = shown
        await start(from: max(0, t.offset + (t.stream == nil ? Date().timeIntervalSince(asked) : 0)), stream: t.stream)
        done?(me == tuneTask); done = nil
        let stay = 7 + Double(t.host?.line.count ?? 0) * 0.045
        Task { try? await Task.sleep(for: .seconds(stay)); if self.bug == shown { self.bug = nil } }
    }

    /// Live: if the picture stalls for more than a moment, show the stand-by card until it's moving again.
    private func watchBuffering() {
        guard waitObserver == nil else { return }
        waitObserver = player.observe(\.timeControlStatus) { [weak self] p, _ in
            let waiting = p.timeControlStatus == .waitingToPlayAtSpecifiedRate
            Task { @MainActor in
                guard let self else { return }
                self.waitTask?.cancel()
                if waiting {
                    self.waitTask = Task { try? await Task.sleep(for: .seconds(1.5)); if !Task.isCancelled, self.bug?.startsAt == nil { self.standBy = true } }
                } else {
                    self.standBy = false
                }
            }
        }
    }

    /// Channel up/down. The Siri Remote's channel flipping (AVPlayerViewController's delegate) and the clickpad both
    /// land here; a press that arrives both ways only flips once.
    private var lastFlip = Date.distantPast
    private var lastFlipSource = ""
    @discardableResult
    func flip(_ step: Int, from source: String = "") async -> Bool {
        if source != lastFlipSource, Date().timeIntervalSince(lastFlip) < 0.5 { return false }
        lastFlip = Date(); lastFlipSource = source
        guard let ch = peek(step) else { return false }
        return await withCheckedContinuation { c in Task { await tune(ch.key) { c.resume(returning: $0) } } }
    }

    /// The channel `step` away from the one tuned to.
    func peek(_ step: Int) -> LiveChannel? {
        guard let channelKey, let i = channels.firstIndex(where: { $0.key == channelKey }), !channels.isEmpty else { return nil }
        return channels[(i + step + channels.count) % channels.count]
    }

    // MARK: subtitles (server: subtitles.py)

    /// A Plex/Jellyfin track: the stream restarts where you were with it burned in (0 = off).
    func useTrack(_ id: Int) async {
        setCues([])
        let at = position
        subtitle = id
        await stopStream()
        await start(from: at)
    }

    func offSubtitles() async {
        if !cues.isEmpty { setCues([]) }
        if let subtitle, subtitle != 0 { await useTrack(0) }
    }

    /// The menu in the player's top bar: Off, the title's tracks, then Find subtitles… (searched when opened).
    func subtitleMenu() async -> [UIMenuElement] {
        struct Tracks: Decodable { var tracks: [Track] }
        struct Track: Decodable { var id: Int; var title: String }
        let t: Tracks? = try? await API.shared.get("/subs/\(current.id)")
        let noneOn = (subtitle == nil || subtitle == 0) && cues.isEmpty
        var items: [UIMenuElement] = [UIAction(title: "Off", state: noneOn ? .on : .off) { [weak self] _ in Task { await self?.offSubtitles() } }]
        for tr in t?.tracks ?? [] {
            items.append(UIAction(title: tr.title, state: subtitle == tr.id && cues.isEmpty ? .on : .off) { [weak self] _ in
                Task { await self?.useTrack(tr.id) }
            })
        }
        if !cues.isEmpty { items.append(UIAction(title: "From OpenSubtitles", attributes: .disabled, state: .on) { _ in }) }
        let find = UIMenu(title: "Find subtitles…", image: UIImage(systemName: "magnifyingglass"), children: [
            UIDeferredMenuElement.uncached { [weak self] done in
                Task { @MainActor in done(await self?.searchMenu() ?? []) }
            },
        ])
        items.append(find)
        return items
    }

    private func searchMenu() async -> [UIMenuElement] {
        struct Found: Decodable { var provider: String; var results: [Result] }
        struct Result: Decodable { var id: String; var title: String; var language: String?; var downloads: Double?; var hi: Bool? }
        var q = ["kind": kind, "ext_id": String(extID)]
        if let s = current.season, let e = current.episode { q["season"] = String(s); q["episode"] = String(e) }
        do {
            let f: Found = try await API.shared.get("/subs/\(current.id)/search", q)
            if f.results.isEmpty { return [UIAction(title: "Nothing found", attributes: .disabled) { _ in }] }
            return f.results.prefix(25).map { r in
                let sub = [r.language, r.hi == true ? "SDH" : nil, r.downloads.map { "\(Int($0))" }].compactMap { $0 }.joined(separator: " · ")
                return UIAction(title: r.title, subtitle: sub.isEmpty ? nil : sub) { [weak self] _ in
                    Task { await self?.get(r.id, provider: f.provider) }
                }
            }
        } catch {
            return [UIAction(title: error.localizedDescription, attributes: .disabled) { _ in }]
        }
    }

    private func get(_ id: String, provider: String) async {
        struct Got: Decodable { var track: Int?; var vtt: String? }
        do {
            let (data, _) = try await API.shared.post("/subs/\(current.id)/get", ["kind": kind, "id": id, "provider": provider])
            let g: Got = try API.shared.decode(data)
            if let track = g.track {
                await useTrack(track)
            } else if let vtt = g.vtt {
                let (body, _) = try await API.shared.send("GET", String(vtt.dropFirst(4)))  // "/api/subtitles/…" -> "/subtitles/…"
                setCues(Self.parseVTT(String(decoding: body, as: UTF8.self)))
                if let subtitle, subtitle != 0 { await useTrack(0) }  // drawn text replaces a burned-in track
            }
        } catch {
            self.error = nil
            caption = ""
            showNote(error.localizedDescription)
        }
    }

    private func showNote(_ text: String) {
        caption = text
        Task { try? await Task.sleep(for: .seconds(4)); if caption == text { caption = "" } }
    }

    private func setCues(_ new: [Cue]) {
        cues = new
        caption = ""
        if let captionObserver { player.removeTimeObserver(captionObserver) }
        captionObserver = nil
        guard !new.isEmpty else { return }
        captionObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.2, preferredTimescale: 600), queue: .main) { [weak self] t in
            Task { @MainActor in
                guard let self else { return }
                let s = t.seconds
                self.caption = self.cues.first { $0.start <= s && s < $0.end }?.text ?? ""
            }
        }
    }

    /// WebVTT -> cues. Handles "00:01:02.500" and "01:02.500" times; drops styling tags.
    static func parseVTT(_ text: String) -> [Cue] {
        func secs(_ s: Substring) -> Double? {
            let p = s.split(separator: ":").map { Double($0.replacingOccurrences(of: ",", with: ".")) }
            guard p.allSatisfy({ $0 != nil }) else { return nil }
            let v = p.compactMap { $0 }
            return v.count == 3 ? v[0] * 3600 + v[1] * 60 + v[2] : v.count == 2 ? v[0] * 60 + v[1] : nil
        }
        var out: [Cue] = []
        for block in text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n\n") {
            let lines = block.split(separator: "\n", omittingEmptySubsequences: true)
            guard let i = lines.firstIndex(where: { $0.contains("-->") }) else { continue }
            let parts = lines[i].components(separatedBy: "-->")
            guard parts.count == 2, let a = secs(Substring(parts[0].trimmingCharacters(in: .whitespaces))),
                  let b = secs(Substring(parts[1].trimmingCharacters(in: .whitespaces).split(separator: " ").first ?? "")) else { continue }
            let body = lines[(i + 1)...].joined(separator: "\n").replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
            if !body.isEmpty { out.append(Cue(start: a, end: b, text: body)) }
        }
        return out.sorted { $0.start < $1.start }
    }

    private func stopStream() async {
        guard let session else { return }
        self.session = nil
        _ = try? await API.shared.post("/play/progress", ["session": session, "position": holdAt ?? position, "duration": duration, "state": "stopped"])
    }

    func close() {
        player.pause()
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        statusObserver = nil
        waitObserver = nil; waitTask?.cancel(); standBy = false
        setCues([])
        Task { await stopStream(); player.replaceCurrentItem(with: nil) }
    }
}

/// Full screen: Apple's player.
struct PlayerScreen: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var playback: Playback
    let start: Double

    init(item: PlayItem, upNext: [PlayItem], start: Double, kind: String, extID: Int) {
        _playback = StateObject(wrappedValue: Playback(item: item, upNext: upNext, kind: kind, extID: extID))
        self.start = start
    }

    /// Live: tuned to a channel (Live TV guide).
    init(channel: String, channels: [LiveChannel]) {
        _playback = StateObject(wrappedValue: Playback(channel: channel, channels: channels))
        start = 0
    }

    var body: some View {
        PlayerController(playback: playback)
            .ignoresSafeArea()
            .background(Color.black)
            .onAppear {  // not tied to the view: a redraw mustn't cancel it
                Task { if let key = playback.channelKey { await playback.tune(key) } else { await playback.start(from: start) } }
            }
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
    let playback: Playback

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let vc = AVPlayerViewController()
        vc.player = playback.player
        #if os(iOS)
        vc.allowsPictureInPicturePlayback = true
        vc.canStartPictureInPictureAutomaticallyFromInline = true
        #else
        // Swipe down while watching: a Subtitles menu next to Apple's own audio/subtitle controls.
        let pb = playback
        var menus: [UIMenuElement] = [UIMenu(title: "Subtitles", image: UIImage(systemName: "captions.bubble"), children: [
            UIDeferredMenuElement.uncached { done in Task { @MainActor in done(await pb.subtitleMenu()) } },
        ])]
        if pb.channelKey != nil {  // live: every channel, and up/down on the clickpad flips
            menus.insert(UIMenu(title: "Channels", image: UIImage(systemName: "tv"), children: [
                UIDeferredMenuElement.uncached { done in
                    Task { @MainActor in
                        done(pb.channels.map { ch in
                            UIAction(title: "\(ch.number)  \(ch.name)", subtitle: ch.onNow?.label,
                                     state: ch.key == pb.channelKey ? .on : .off) { _ in Task { await pb.tune(ch.key) } }
                        })
                    }
                },
            ]), at: 0)
            for (press, step) in [(UIPress.PressType.upArrow, 1), (.downArrow, -1)] {
                let g = UITapGestureRecognizer(target: context.coordinator, action: step > 0 ? #selector(Coordinator.up) : #selector(Coordinator.down))
                g.allowedPressTypes = [NSNumber(value: press.rawValue)]
                vc.view.addGestureRecognizer(g)
            }
            context.coordinator.playback = pb
            vc.delegate = context.coordinator  // Siri Remote channel up/down while watching (skipToNextChannel)
        }
        vc.transportBarCustomMenuItems = menus
        #endif
        // OpenSubtitles text, drawn over the picture (under the controls).
        let host = UIHostingController(rootView: CaptionView(playback: playback))
        host.view.backgroundColor = .clear
        host.view.isUserInteractionEnabled = false
        if let overlay = vc.contentOverlayView {
            host.view.frame = overlay.bounds
            host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            overlay.addSubview(host.view)
        }
        context.coordinator.host = host
        return vc
    }

    func updateUIViewController(_ vc: AVPlayerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator: NSObject, AVPlayerViewControllerDelegate {
        var host: UIHostingController<CaptionView>?
        weak var playback: Playback?
        @MainActor @objc func up() { Task { await playback?.flip(1, from: "press") } }
        @MainActor @objc func down() { Task { await playback?.flip(-1, from: "press") } }
        #if os(tvOS)
        func playerViewController(_ vc: AVPlayerViewController, skipToNextChannel completion: @escaping (Bool) -> Void) {
            Task { @MainActor in completion(await playback?.flip(1, from: "channel") ?? false) }
        }
        func playerViewController(_ vc: AVPlayerViewController, skipToPreviousChannel completion: @escaping (Bool) -> Void) {
            Task { @MainActor in completion(await playback?.flip(-1, from: "channel") ?? false) }
        }
        func nextChannelInterstitialViewController(for vc: AVPlayerViewController) -> UIViewController { card(1) }
        func previousChannelInterstitialViewController(for vc: AVPlayerViewController) -> UIViewController { card(-1) }
        /// Fills the screen while the next channel loads: static and its number and name.
        private func card(_ step: Int) -> UIViewController {
            MainActor.assumeIsolated {
                let h = UIHostingController(rootView: ChannelCard(channel: playback?.peek(step)))
                h.view.backgroundColor = .black
                return h
            }
        }
        #endif
    }

    /// Between channels: static, with the number and name of the channel coming up.
    struct ChannelCard: View {
        var channel: LiveChannel?
        var body: some View {
            ZStack {
                StaticNoise().opacity(0.6)
                if let channel {
                    VStack(spacing: 12) {
                        Text("\(channel.number)").font(.system(size: 140, weight: .black, design: .monospaced)).foregroundStyle(Color(hex: 0xFFD54A))
                        Text(channel.name.uppercased()).font(.system(size: 50, weight: .black, design: .monospaced)).foregroundStyle(.white)
                    }
                    .shadow(color: .black, radius: 8)
                }
            }
            .ignoresSafeArea()
        }
    }
}

/// The current subtitle line, bottom centre, white on a soft shadow box (like Apple's own subtitles).
struct CaptionView: View {
    @ObservedObject var playback: Playback

    var body: some View {
        ZStack {
            if playback.standBy { StandByCard().transition(.opacity) }
            if let bug = playback.bug { LiveBugView(bug: bug).transition(.opacity) }
            captions
            if playback.staticBurst { StaticNoise() }
        }
        .animation(.easeInOut(duration: 0.4), value: playback.bug)
        .animation(.easeInOut(duration: 0.3), value: playback.standBy)
    }

    private var captions: some View {
        VStack {
            Spacer()
            if !playback.caption.isEmpty {
                Text(playback.caption)
                    .font(.system(size: size, weight: .semibold))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14).padding(.vertical, 6)
                    .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 8))
                    .padding(.bottom, bottom)
                    .padding(.horizontal, 60)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var size: CGFloat {
        #if os(tvOS)
        return 46
        #else
        return 20
        #endif
    }

    private var bottom: CGFloat {
        #if os(tvOS)
        return 90
        #else
        return 40
        #endif
    }
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
