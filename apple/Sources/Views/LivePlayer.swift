#if os(tvOS)
import AVKit
import SwiftUI

// Live TV on the Apple TV: its own screen rather than Apple's player, which is built for films and keeps the remote's
// up/down/swipes for its own menus and timeline. Here every input is ours:
//   up / down (click, swipe, Remote app, game controller, channel buttons)  flip channels; quick presses add up
//   left / right   the channel strip along the bottom; click to watch the highlighted one
//   click          the now/next card
//   play/pause     pause
//   Back           closes the strip or card, then leaves
// The tuning, static, hosts and stand-by card are all Playback's (PlayerView.swift).

struct LiveScreen: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var playback: Playback

    init(channel: String, channels: [LiveChannel]) {
        _playback = StateObject(wrappedValue: Playback(channel: channel, channels: channels))
    }

    var body: some View {
        LivePlayerController(playback: playback, exit: { dismiss() })
            .ignoresSafeArea()
            .background(Color.black)
            .onAppear { Task { if let key = playback.channelKey { await playback.tune(key) } } }
            #if DEBUG
            .task {  // simulator testing only: NF_LIVE_KEYS=up,up,right,select (one every NF_LIVE_GAP seconds, after 8)
                let env = ProcessInfo.processInfo.environment
                guard let keys = env["NF_LIVE_KEYS"] else { return }
                let gap = Double(env["NF_LIVE_GAP"] ?? "") ?? 2
                try? await Task.sleep(for: .seconds(8))
                let names: [String: Playback.LiveKey] = ["up": .up, "down": .down, "left": .left, "right": .right, "select": .select, "menu": .menu, "pause": .playPause]
                for k in keys.split(separator: ",") {
                    if let key = names[String(k)] { print("NF key", k); if !playback.key(key) { dismiss() } }
                    try? await Task.sleep(for: .seconds(gap))
                }
            }
            #endif
            .onDisappear { playback.close() }
            .alert("Can't play this", isPresented: Binding(get: { playback.error != nil }, set: { if !$0 { playback.error = nil } })) {
                Button("OK") { dismiss() }
            } message: {
                Text(playback.error ?? "")
            }
    }
}

private struct LivePlayerController: UIViewControllerRepresentable {
    let playback: Playback
    let exit: () -> Void
    func makeUIViewController(context: Context) -> LivePlayerVC { LivePlayerVC(playback: playback, exit: exit) }
    func updateUIViewController(_ vc: LivePlayerVC, context: Context) { vc.exit = exit }
}

final class LivePlayerVC: UIViewController {
    let playback: Playback
    var exit: () -> Void
    private let video = AVPlayerLayer()
    private var keys: [UIGestureRecognizer: Playback.LiveKey] = [:]
    private var last: (key: Playback.LiveKey, at: Date, swipe: Bool)?

    init(playback: Playback, exit: @escaping () -> Void) {
        self.playback = playback
        self.exit = exit
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    /// The one thing on screen that can take focus, so the remote's presses and touches come here.
    private final class Surface: UIView { override var canBecomeFocused: Bool { true } }

    override func loadView() { view = Surface() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        video.player = playback.player
        video.videoGravity = .resizeAspect
        view.layer.addSublayer(video)

        let host = UIHostingController(rootView: LiveOverlay(playback: playback))
        host.view.backgroundColor = .clear
        host.view.isUserInteractionEnabled = false
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)

        // Clicks, the game controller's d-pad and buttons, and channel buttons on remotes that have them.
        let presses: [(UIPress.PressType, Playback.LiveKey)] = [
            (.upArrow, .up), (.downArrow, .down), (.leftArrow, .left), (.rightArrow, .right),
            (.pageUp, .up), (.pageDown, .down), (.select, .select), (.menu, .menu), (.playPause, .playPause),
        ]
        for (type, key) in presses {
            let g = UITapGestureRecognizer(target: self, action: #selector(pressed(_:)))
            g.allowedPressTypes = [NSNumber(value: type.rawValue)]
            view.addGestureRecognizer(g)
            keys[g] = key
        }
        // Swipes on the clickpad and in the iPhone's Remote app.
        let swipes: [(UISwipeGestureRecognizer.Direction, Playback.LiveKey)] = [(.up, .up), (.down, .down), (.left, .left), (.right, .right)]
        for (dir, key) in swipes {
            let g = UISwipeGestureRecognizer(target: self, action: #selector(swiped(_:)))
            g.direction = dir
            view.addGestureRecognizer(g)
            keys[g] = key
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        video.frame = view.bounds
        CATransaction.commit()
    }

    override var preferredFocusEnvironments: [UIFocusEnvironment] { [view] }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        setNeedsFocusUpdate()
        updateFocusIfNeeded()
    }

    @objc private func pressed(_ g: UIGestureRecognizer) { send(g, swipe: false) }
    @objc private func swiped(_ g: UIGestureRecognizer) { send(g, swipe: true) }

    private func send(_ g: UIGestureRecognizer, swipe: Bool) {
        guard let key = keys[g] else { return }
        // Some remotes report one gesture as both a swipe and an edge press: count it once.
        if let last, last.key == key, last.swipe != swipe, Date().timeIntervalSince(last.at) < 0.25 { return }
        last = (key, Date(), swipe)
        if !playback.key(key) { exit() }
    }
}

/// Everything drawn over the picture.
private struct LiveOverlay: View {
    @ObservedObject var playback: Playback

    var body: some View {
        ZStack {
            if playback.standBy { StandByCard().transition(.opacity) }
            if let bug = playback.bug, playback.flipTo == nil {
                LiveBugView(bug: bug, bottom: playback.stripAt == nil ? 90 : 330).transition(.opacity)
            }
            if playback.staticBurst { StaticNoise() }
            if let ch = playback.flipTo { FlipCard(channel: ch) }
            if playback.paused, playback.flipTo == nil { PausedPill() }
            if let at = playback.stripAt, !playback.channels.isEmpty {
                ChannelStrip(channels: playback.channels, at: at, tuned: playback.channelKey)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.4), value: playback.bug)
        .animation(.easeInOut(duration: 0.3), value: playback.standBy)
        .animation(.easeOut(duration: 0.25), value: playback.stripAt == nil)
    }
}

/// While flipping: static, the channel's number and name, and what's on.
private struct FlipCard: View {
    var channel: LiveChannel
    var body: some View {
        ZStack {
            Color.black
            StaticNoise().opacity(0.55)
            VStack(spacing: 14) {
                Text("\(channel.number)").font(Guide.mono(150, .black)).foregroundStyle(Guide.yellow)
                    .shadow(color: Guide.yellow.opacity(0.5), radius: 20)
                Text(channel.name.uppercased()).font(Guide.mono(54, .black)).foregroundStyle(.white)
                if let p = channel.onNow {
                    Text(p.label).font(.system(size: 34, weight: .semibold)).foregroundStyle(.white.opacity(0.85)).lineLimit(1)
                }
            }
            .shadow(color: .black, radius: 8)
            .padding(.horizontal, 120)
        }
        .ignoresSafeArea()
    }
}

private struct PausedPill: View {
    var body: some View {
        Label("PAUSED", systemImage: "pause.fill")
            .font(Guide.mono(30, .black)).foregroundStyle(.white)
            .padding(.horizontal, 22).padding(.vertical, 12)
            .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(60)
    }
}

/// Left/right: five channels along the bottom, the highlighted one in the middle.
private struct ChannelStrip: View {
    var channels: [LiveChannel]
    var at: Int
    var tuned: String?

    var body: some View {
        let n = channels.count
        let around = n >= 5 ? Array(-2...2) : Array(0..<n).map { $0 - at }
        VStack(spacing: 18) {
            HStack(spacing: 22) {
                ForEach(around, id: \.self) { d in
                    let ch = channels[((at + d) % n + n) % n]
                    card(ch, highlighted: d == 0)
                }
            }
            Text("◀ ▶  more channels     click  watch     ▲ ▼  flip")
                .font(Guide.mono(20)).foregroundStyle(.white.opacity(0.6))
        }
        .padding(.vertical, 30)
        .frame(maxWidth: .infinity)
        .background(LinearGradient(colors: [.clear, Guide.navy.opacity(0.92)], startPoint: .top, endPoint: .center))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
    }

    private func card(_ ch: LiveChannel, highlighted: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Text("\(ch.number)").font(Guide.mono(30, .black)).foregroundStyle(Guide.yellow)
                Text(ch.name.uppercased()).font(Guide.mono(22, .black)).foregroundStyle(.white).lineLimit(1)
                if ch.key == tuned { Circle().fill(.red).frame(width: 10, height: 10) }
            }
            if let p = ch.onNow {
                Text(p.label).font(.system(size: 24, weight: .semibold)).foregroundStyle(.white.opacity(0.9)).lineLimit(2)
                Text("until \(hm(p.endDate))").font(Guide.mono(18)).foregroundStyle(Guide.cyan)
            }
            Spacer(minLength: 0)
        }
        .padding(18)
        .frame(width: 320, height: 170, alignment: .topLeading)
        .background(highlighted ? Guide.cellNow : Guide.cell, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(highlighted ? Guide.yellow : Guide.line, lineWidth: highlighted ? 4 : 1))
        .scaleEffect(highlighted ? 1.08 : 1)
        .animation(.easeOut(duration: 0.15), value: highlighted)
    }
}
#endif
