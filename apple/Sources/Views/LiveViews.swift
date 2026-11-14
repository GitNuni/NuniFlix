import SwiftUI

// Live channels: the person's own Plex/Jellyfin laid out like old TV (server: channels.py). The guide shows what's on
// for the next three hours; picking any channel tunes in part-way through whatever it's showing. In the player, up and
// down on the clickpad flip channels and the Channels menu lists them all.

struct LiveLineup: Decodable {
    var now: Double
    var source: String
    var channels: [LiveChannel]
    var takeover: String?
    var host: HostSays?
}

/// Vesper, the host (server: host.py): her mood follows the clock (day / dusk / evil) and the line is what she says.
struct HostSays: Decodable, Hashable {
    var name: String
    var mood: String
    var line: String
    var lines: [String]?   // the guide: she cycles through these

    /// Same hours as the server: friendly 6am-5pm, sly until 10pm (and 4-6am), evil in Horror Hours.
    static var moodNow: String {
        let h = Calendar.current.component(.hour, from: Date())
        return (6..<17).contains(h) ? "day" : ((17..<22).contains(h) || (4..<6).contains(h)) ? "dusk" : "evil"
    }
}

/// The viewer's offset from UTC in minutes, so the server knows their date (takeovers) and hour (the host's mood).
let liveTZ = String(TimeZone.current.secondsFromGMT() / 60)

struct LiveChannel: Decodable, Identifiable, Hashable {
    var key: String
    var number: Int
    var name: String
    var tagline: String
    var kind: String
    var takeover: String?
    var programs: [LiveProgram]
    var id: String { key }
    var onNow: LiveProgram? { programs.first { $0.slotEnd > Date().timeIntervalSince1970 } }
}

struct LiveProgram: Decodable, Hashable {
    var id: String
    var kind: String
    var ext: Int?
    var tmdb: Int?
    var title: String?
    var sub: String?
    var show: String?
    var poster: String?
    var backdrop: String?
    var overview: String?
    var start: Double
    var end: Double
    var slotEnd: Double

    /// "The Office: Diversity Day" / "Alien"
    var label: String { show.map { "\($0): \(title ?? "")" } ?? (title ?? "") }
    var heading: String { show ?? title ?? "" }
    var startDate: Date { Date(timeIntervalSince1970: start) }
    var endDate: Date { Date(timeIntervalSince1970: end) }
}

struct LiveTune: Decodable {
    var now: Double
    var program: LiveProgram
    var offset: Double
    var next: LiveProgram?
    var channel: TunedChannel?
    var host: HostSays?
    var stream: StreamStart?  // already started at the right point (one round trip to tune in)
    struct TunedChannel: Decodable, Hashable { var key: String; var name: String; var tagline: String; var takeover: String? }
}

/// What the player shows over the picture for a few seconds after tuning in (or during the ident between shows).
struct LiveBug: Equatable {
    var channel: LiveChannel?
    var now: LiveProgram
    var next: LiveProgram?
    var startsAt: Date?
    var host: HostSays?
    var name: String?      // the channel's name today (a takeover renames Fright Night)
    var tagline: String?
    var takeover: Bool = false
}

private func hm(_ d: Date) -> String { d.formatted(date: .omitted, time: .shortened) }

private enum Guide {
    static let navy = Color(hex: 0x0A1034)
    static let cell = Color(hex: 0x16205A)
    static let cellNow = Color(hex: 0x1F2D78)
    static let line = Color(hex: 0x2B3A8C)
    static let yellow = Color(hex: 0xFFD54A)
    static let cyan = Color(hex: 0x5CE1FF)
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .bold) -> Font { .system(size: size, weight: weight, design: .monospaced) }
}

// MARK: home tile

struct LiveTile: View {
    var body: some View {
        ZStack(alignment: .bottomLeading) {
            LinearGradient(colors: [Color(hex: 0x0A1034), Color(hex: 0x24308C)], startPoint: .topLeading, endPoint: .bottomTrailing)
            // scanlines
            VStack(spacing: 3) { ForEach(0..<60, id: \.self) { _ in Color.black.opacity(0.18).frame(height: 1) } }
            HostSprite(mood: HostSays.moodNow, talking: false, size: Metrics.serviceTile.height * 0.95)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing).offset(x: 10, y: 8)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Circle().fill(.red).frame(width: 12, height: 12).shadow(color: .red, radius: 6)
                    Text("LIVE TV").font(Guide.mono(26, .black)).foregroundStyle(.white)
                }
                Text("Channels made from your library").font(.caption).foregroundStyle(.white.opacity(0.8))
            }
            .padding(14)
        }
        .frame(width: Metrics.serviceTile.width, height: Metrics.serviceTile.height)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

// MARK: the guide

struct LiveGuideView: View {
    @State private var lineup: LiveLineup?
    @State private var error: String?
    @State private var tuned: Tuned?
    @FocusState private var focus: String?
    @State private var shown: (LiveChannel, LiveProgram)?
    @State private var lastFocus = Date()
    @State private var previewing = false
    @State private var hostLine = 0         // which of Vesper's lines she's on (she moves on every 15 s)   // nobody's touched the remote for a while: the preview cycles channels by itself

    struct Tuned: Identifiable { let id = UUID(); var key: String }

    private let hours: Double = 3
    private let labelWidth: CGFloat = 300
    private let rowHeight: CGFloat = 104

    var body: some View {
        ZStack {
            LinearGradient(colors: [Guide.navy, .black], startPoint: .top, endPoint: .bottom).ignoresSafeArea()
            if let lineup {
                VStack(alignment: .leading, spacing: 24) {
                    preview(lineup)
                    grid(lineup)
                }
                .padding(.horizontal, Metrics.gutter).padding(.top, 30)
            } else if let error {
                ErrorView(message: error) { Task { await load() } }
            } else {
                ProgressView("Warming up the channels…").foregroundStyle(.white)
            }
        }
        .task { await load() }
        .task {  // keep the guide current while it's open
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(120))
                if tuned == nil { await load() }
            }
        }
        .task {  // Vesper has more than one thing to say
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                if tuned == nil { hostLine += 1 }
            }
        }
        .task {  // like the old preview channels: left alone, the guide flips through what's on
            var i = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(6))
                guard tuned == nil, let chs = lineup?.channels, !chs.isEmpty, Date().timeIntervalSince(lastFocus) > 20 else { previewing = false; continue }
                previewing = true
                i = (i + 1) % chs.count
                if let p = chs[i].onNow { withAnimation(.easeInOut(duration: 0.4)) { shown = (chs[i], p) } }
            }
        }
        .fullScreenCover(item: $tuned) { t in
            PlayerScreen(channel: t.key, channels: lineup?.channels ?? [])
        }
        .onChange(of: focus) { _, f in
            lastFocus = Date(); previewing = false
            guard let f, let lineup else { return }
            let parts = f.split(separator: "|")
            if let ch = lineup.channels.first(where: { $0.key == parts.first.map(String.init) }),
               let p = ch.programs.first(where: { String(Int($0.start)) == parts.last.map(String.init) }) {
                shown = (ch, p)
            }
        }
    }

    private func load() async {
        do {
            let l: LiveLineup = try await API.shared.get("/live", ["hours": "4", "tz": liveTZ])
            lineup = l; error = nil
            if shown == nil, let ch = l.channels.first, let p = ch.onNow ?? ch.programs.first { shown = (ch, p) }
            #if DEBUG
            if let k = ProcessInfo.processInfo.environment["NF_LIVE_TUNE"], tuned == nil { tuned = Tuned(key: k) }  // simulator testing only
            #endif
        } catch {
            if !(error is CancellationError), lineup == nil { self.error = error.localizedDescription }
        }
    }

    // the focused programme, big
    private func preview(_ l: LiveLineup) -> some View {
        let (ch, p) = shown ?? (l.channels[0], l.channels[0].onNow ?? l.channels[0].programs[0])
        let now = Date()
        let onNow = p.startDate <= now && now < p.endDate
        return HStack(alignment: .top, spacing: 40) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 14) {
                    Circle().fill(.red).frame(width: 14, height: 14).shadow(color: .red, radius: 6)
                    Text("LIVE TV").font(Guide.mono(24, .black)).foregroundStyle(.white)
                    Text(hm(now)).font(Guide.mono(24)).foregroundStyle(.white.opacity(0.6))
                    if previewing { Text("CHANNEL PREVIEW").font(Guide.mono(18, .black)).foregroundStyle(.black).padding(.horizontal, 8).padding(.vertical, 3).background(Guide.cyan) }
                }
                HStack(spacing: 12) {
                    Text("\(ch.number)  \(ch.name.uppercased())").font(Guide.mono(26, .heavy)).foregroundStyle(Guide.yellow)
                    if ch.takeover != nil { TakeoverPill() }
                }
                Text(p.heading).font(.system(size: 52, weight: .heavy)).foregroundStyle(.white).lineLimit(1)
                Text([p.show != nil ? p.title : nil, p.sub, "\(hm(p.startDate)) – \(hm(p.endDate))",
                      onNow ? "\(max(1, Int(p.end - now.timeIntervalSince1970) / 60)) min left" : nil].compactMap { $0 }.joined(separator: "  ·  "))
                    .font(.headline).foregroundStyle(Guide.cyan)
                Text(p.overview ?? ch.tagline).font(.callout).foregroundStyle(.white.opacity(0.75)).lineLimit(3)
                    .frame(maxWidth: 980, alignment: .leading)
            }
            Spacer(minLength: 0)
            if let h = l.host {
                let lines = h.lines?.isEmpty == false ? h.lines! : [h.line]
                let said = lines[hostLine % lines.count]
                HStack(alignment: .top, spacing: -10) {  // the bubble takes its own room, so it never covers the details
                    Text(said).font(.system(size: 20, weight: .semibold)).foregroundStyle(.black).lineLimit(4)
                        .padding(10).frame(width: 250, alignment: .leading)
                        .background(.white, in: RoundedRectangle(cornerRadius: 10))
                        .id(said).transition(.opacity)
                    HostSprite(mood: h.mood, talking: true, size: 170, talkFor: Double(said.count) * 0.045 + 0.6)
                        .id(said)
                }
                .animation(.easeInOut(duration: 0.3), value: said)
                .padding(.top, 130)
            }
            Picture(url: p.backdrop ?? p.poster)
                .frame(width: 560, height: 315)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(alignment: .bottomLeading) {
                    if onNow { Text("ON NOW").font(Guide.mono(18, .black)).padding(.horizontal, 10).padding(.vertical, 4).background(.red).padding(12) }
                }
        }
        .frame(height: 330)
        .animation(.easeOut(duration: 0.15), value: p)
    }

    private func grid(_ l: LiveLineup) -> some View {
        let now = Date().timeIntervalSince1970
        let t0 = floor(now / 1800) * 1800, t1 = t0 + hours * 3600
        return GeometryReader { geo in
            let ppsec = (geo.size.width - labelWidth) / (t1 - t0)
            VStack(alignment: .leading, spacing: 0) {
                // the time ruler
                HStack(spacing: 0) {
                    Text("Today").font(Guide.mono(20)).foregroundStyle(.white.opacity(0.5)).frame(width: labelWidth, alignment: .leading)
                    ForEach(0..<Int(hours * 2), id: \.self) { i in
                        Text(hm(Date(timeIntervalSince1970: t0 + Double(i) * 1800))).font(Guide.mono(20)).foregroundStyle(.white.opacity(0.7))
                            .frame(width: 1800 * ppsec, alignment: .leading)
                    }
                }
                .frame(height: 40)
                ScrollView(.vertical, showsIndicators: false) {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(l.channels) { ch in row(ch, t0: t0, t1: t1, ppsec: ppsec, now: now) }
                    }
                    .padding(.vertical, 14)
                }
                .overlay(alignment: .topLeading) {  // the "now" line
                    Rectangle().fill(.red.opacity(0.7)).frame(width: 2)
                        .offset(x: labelWidth + (now - t0) * ppsec).allowsHitTesting(false)
                }
            }
        }
    }

    private func row(_ ch: LiveChannel, t0: Double, t1: Double, ppsec: Double, now: Double) -> some View {
        HStack(spacing: 0) {
            HStack(spacing: 14) {
                Text("\(ch.number)").font(Guide.mono(34, .black)).foregroundStyle(Guide.yellow).frame(width: 64, alignment: .trailing)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ch.name).font(.headline).foregroundStyle(ch.takeover != nil ? Color(hex: 0xFF5468) : .white).lineLimit(1)
                    Text(ch.takeover != nil ? "TAKEOVER" : ch.kind == "tv" ? "Shows" : "Movies").font(.caption2.weight(ch.takeover != nil ? .black : .regular))
                        .foregroundStyle(ch.takeover != nil ? Color(hex: 0xFF5468) : .white.opacity(0.5))
                }
            }
            .frame(width: labelWidth, alignment: .leading)
            ZStack(alignment: .leading) {
                ForEach(ch.programs.filter { $0.slotEnd > max(t0, now) && $0.start < t1 }, id: \.self) { p in  // what's finished is gone
                    let a = max(p.start, t0), b = min(p.slotEnd, t1)
                    Button { tuned = Tuned(key: ch.key) } label: {
                        GuideCell(program: p, onNow: p.start <= now && now < p.slotEnd, clipped: p.start < t0)
                    }
                    .buttonStyle(GuideCellStyle())
                    .focused($focus, equals: "\(ch.key)|\(Int(p.start))")
                    .frame(width: max(8, (b - a) * ppsec - 6), height: rowHeight)
                    .offset(x: (a - t0) * ppsec)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(height: rowHeight)
    }
}

private struct GuideCell: View {
    var program: LiveProgram
    var onNow: Bool
    var clipped: Bool
    @Environment(\.isFocused) private var focused
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text((clipped ? "‹ " : "") + program.heading).font(.system(size: 26, weight: .semibold)).lineLimit(1)
            Text([program.show != nil ? program.sub : program.sub.map { "(\($0))" }, hm(program.startDate)].compactMap { $0 }.joined(separator: "  "))
                .font(Guide.mono(18, .regular)).opacity(0.7).lineLimit(1)
        }
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .foregroundStyle(focused ? Color.black : .white)
        .background(focused ? Guide.cyan : onNow ? Guide.cellNow : Guide.cell)
    }
}

private struct GuideCellStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { Inner(configuration: configuration) }
    private struct Inner: View {
        let configuration: ButtonStyle.Configuration
        @Environment(\.isFocused) private var focused
        var body: some View {
            configuration.label
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(focused ? .white : Guide.line, lineWidth: focused ? 3 : 1))
                .scaleEffect(focused ? 1.04 : 1).zIndex(focused ? 1 : 0)
                .animation(.easeOut(duration: 0.12), value: focused)
        }
    }
}

// MARK: over the picture

struct LiveBugView: View {
    var bug: LiveBug
    var body: some View {
        if let at = bug.startsAt { ident(at) } else { card }
    }

    private var name: String { (bug.name ?? bug.channel?.name ?? "").uppercased() }

    // a few seconds after tuning in: the channel bug top right, now/next bottom left (with Vesper, if she's on)
    private var card: some View {
        ZStack {
            if let ch = bug.channel {
                Text("\(ch.number) \(name)").font(Guide.mono(28, .black)).foregroundStyle(.white.opacity(0.85))
                    .padding(.horizontal, 16).padding(.vertical, 8).background(.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing).padding(60)
            }
            HStack(alignment: .bottom, spacing: 18) {
            if let h = bug.host {
                VStack(alignment: .leading, spacing: 8) {
                    SpeechBubble(text: h.line, width: 560)
                    HostSprite(mood: h.mood, talking: true, size: 200, talkFor: Double(h.line.count) * 0.045 + 0.6)
                }
            }
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 14) {
                    Text("NOW").font(Guide.mono(22, .black)).foregroundStyle(.black).padding(.horizontal, 10).padding(.vertical, 3).background(Guide.yellow)
                    Text(bug.now.label).font(.system(size: 34, weight: .bold)).foregroundStyle(.white).lineLimit(1)
                    Text("until \(hm(bug.now.endDate))").font(Guide.mono(22)).foregroundStyle(Guide.cyan)
                }
                if let n = bug.next {
                    HStack(spacing: 14) {
                        Text("NEXT").font(Guide.mono(22, .black)).foregroundStyle(.white).padding(.horizontal, 10).padding(.vertical, 3).background(Guide.line)
                        Text(n.label).font(.system(size: 26, weight: .semibold)).foregroundStyle(.white.opacity(0.85)).lineLimit(1)
                        Text(hm(n.startDate)).font(Guide.mono(22)).foregroundStyle(.white.opacity(0.6))
                    }
                }
            }
            .padding(24)
            .background(LinearGradient(colors: [Guide.navy.opacity(0.92), Guide.navy.opacity(0.6)], startPoint: .leading, endPoint: .trailing),
                        in: RoundedRectangle(cornerRadius: 14))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            .padding(.horizontal, 60).padding(.bottom, 230)  // clear of Apple's progress bar
        }
    }

    // between shows: the channel's ident and a countdown
    private func ident(_ at: Date) -> some View {
        ZStack {
            LinearGradient(colors: [Guide.navy, .black], startPoint: .top, endPoint: .bottom)
            VStack(spacing: 18) {
                if let ch = bug.channel {
                    Text("\(ch.number)").font(Guide.mono(120, .black)).foregroundStyle(Guide.yellow).shadow(color: Guide.yellow.opacity(0.5), radius: 20)
                    Text(name).font(Guide.mono(54, .black)).foregroundStyle(.white)
                    Text(bug.tagline ?? ch.tagline).font(.title3).foregroundStyle(.white.opacity(0.6))
                    if bug.takeover { TakeoverPill() }
                }
                if let h = bug.host {
                    HStack(alignment: .bottom, spacing: 10) {
                        HostSprite(mood: h.mood, talking: true, size: 260, talkFor: Double(h.line.count) * 0.045 + 0.6)
                        SpeechBubble(text: h.line, width: 640).padding(.bottom, 120)
                    }
                    .padding(.top, 10)
                }
                HStack(spacing: 24) {
                    Picture(url: bug.now.poster).frame(width: 120, height: 180).clipShape(RoundedRectangle(cornerRadius: 8))
                    VStack(alignment: .leading, spacing: 8) {
                        Text("UP NEXT").font(Guide.mono(22, .black)).foregroundStyle(Guide.cyan)
                        Text(bug.now.label).font(.system(size: 38, weight: .bold)).foregroundStyle(.white).lineLimit(2)
                        TimelineView(.periodic(from: .now, by: 1)) { ctx in
                            let s = max(0, Int(at.timeIntervalSince(ctx.date)))
                            Text("Starts in \(s / 60):\(String(format: "%02d", s % 60))").font(Guide.mono(26)).foregroundStyle(.white.opacity(0.75))
                        }
                    }
                }
                .padding(.top, 30)
            }
        }
        .ignoresSafeArea()
    }
}


// MARK: Vesper

private struct TakeoverPill: View {
    var body: some View {
        Text("TAKEOVER").font(Guide.mono(18, .black)).foregroundStyle(.white)
            .padding(.horizontal, 10).padding(.vertical, 4).background(Color(hex: 0xE50914), in: RoundedRectangle(cornerRadius: 4))
    }
}

/// Her picture (web/host/<mood>.png) or, while she's talking, her mouth moving (<mood>-talk.png: 5 frames side by side).
struct HostSprite: View {
    var mood: String
    var talking: Bool
    var size: CGFloat
    var talkFor: Double = 4
    @State private var still: UIImage?
    @State private var frames: [UIImage] = []
    @State private var started = Date()

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.11)) { ctx in
            let talkingNow = talking && !frames.isEmpty && ctx.date.timeIntervalSince(started) < talkFor
            let seq = [0, 1, 2, 3, 4, 3, 2, 1]
            let n = Int(ctx.date.timeIntervalSinceReferenceDate / 0.11)
            if let img = talkingNow ? frames[seq[n % seq.count] % frames.count] : still {
                Image(uiImage: img).resizable().interpolation(.none).frame(width: size, height: size)
            } else {
                Color.clear.frame(width: size, height: size)
            }
        }
        .task(id: mood) {
            started = Date()
            still = await HostArt.image("/host/\(mood).png")
            if talking, let strip = await HostArt.image("/host/\(mood)-talk.png")?.cgImage {
                let w = strip.height
                frames = (0..<(strip.width / max(1, w))).compactMap { i in strip.cropping(to: CGRect(x: i * w, y: 0, width: w, height: w)).map { UIImage(cgImage: $0) } }
            }
        }
    }
}

@MainActor
enum HostArt {
    private static var cache: [String: UIImage] = [:]
    static func image(_ path: String) async -> UIImage? {
        if let hit = cache[path] { return hit }
        guard let url = URL(img: path), let (data, _) = try? await URLSession.shared.data(from: url), let img = UIImage(data: data) else { return nil }
        cache[path] = img
        return img
    }
}

/// White speech bubble; the words type themselves out.
struct SpeechBubble: View {
    var text: String
    var width: CGFloat
    @State private var started = Date()
    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.04)) { ctx in
            let n = min(text.count, Int(ctx.date.timeIntervalSince(started) / 0.045))
            ZStack(alignment: .topLeading) {
                Text(text).opacity(0)  // holds the final size so the bubble doesn't grow as it types
                Text(String(text.prefix(n)))
            }
            .font(.system(size: 30, weight: .semibold)).foregroundStyle(.black)
            .padding(.horizontal, 22).padding(.vertical, 16)
            .frame(maxWidth: width, alignment: .leading)
            .background(.white, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .fixedSize(horizontal: false, vertical: true)
        }
        .onAppear { started = Date() }
        .id(text)
    }
}

// MARK: retro touches

/// A burst of TV static when changing channels.
struct StaticNoise: View {
    private static let frames: [UIImage] = (0..<4).map { _ in noise(160, 90) }
    var body: some View {
        TimelineView(.animation) { ctx in
            let i = Int(ctx.date.timeIntervalSinceReferenceDate * 30) % Self.frames.count
            Image(uiImage: Self.frames[i]).resizable().interpolation(.none)
                .overlay(VStack(spacing: 3) { ForEach(0..<120, id: \.self) { _ in Color.black.opacity(0.25).frame(height: 2) } })
        }
        .ignoresSafeArea()
    }
    private static func noise(_ w: Int, _ h: Int) -> UIImage {
        var px = [UInt8](repeating: 255, count: w * h * 4)
        for i in 0..<(w * h) { let v = UInt8.random(in: 0...255); px[i * 4] = v; px[i * 4 + 1] = v; px[i * 4 + 2] = v }
        let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        return UIImage(cgImage: ctx.makeImage()!)
    }
}

/// Shown while the video is catching up (buffering), instead of a spinner.
struct StandByCard: View {
    var body: some View {
        ZStack {
            HStack(spacing: 0) {
                ForEach([0xC0C0C0, 0xC0C000, 0x00C0C0, 0x00C000, 0xC000C0, 0xC00000, 0x0000C0], id: \.self) { Color(hex: UInt32($0)) }
            }
            VStack(spacing: 10) {
                Text("PLEASE STAND BY").font(Guide.mono(64, .black))
                Text("We'll be right back.").font(Guide.mono(28))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 50).padding(.vertical, 30)
            .background(Color.black.opacity(0.85), in: RoundedRectangle(cornerRadius: 8))
        }
        .ignoresSafeArea()
    }
}
