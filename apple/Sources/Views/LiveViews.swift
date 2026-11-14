import SwiftUI

// Live channels: the person's own Plex/Jellyfin laid out like old TV (server: channels.py). The guide shows what's on
// for the next three hours; picking any channel tunes in part-way through whatever it's showing. In the player, up and
// down on the clickpad flip channels and the Channels menu lists them all.

struct LiveLineup: Decodable {
    var now: Double
    var source: String
    var channels: [LiveChannel]
}

struct LiveChannel: Decodable, Identifiable, Hashable {
    var key: String
    var number: Int
    var name: String
    var tagline: String
    var kind: String
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
}

/// What the player shows over the picture for a few seconds after tuning in (or during the ident between shows).
struct LiveBug: Equatable {
    var channel: LiveChannel?
    var now: LiveProgram
    var next: LiveProgram?
    var startsAt: Date?
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
            Image(systemName: "tv.inset.filled")
                .font(.system(size: Metrics.serviceTile.height * 0.42)).foregroundStyle(Guide.cyan.opacity(0.35))
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing).padding(16)
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
        .fullScreenCover(item: $tuned) { t in
            PlayerScreen(channel: t.key, channels: lineup?.channels ?? [])
        }
        .onChange(of: focus) { _, f in
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
            let l: LiveLineup = try await API.shared.get("/live", ["hours": "4"])
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
                }
                Text("\(ch.number)  \(ch.name.uppercased())").font(Guide.mono(26, .heavy)).foregroundStyle(Guide.yellow)
                Text(p.heading).font(.system(size: 52, weight: .heavy)).foregroundStyle(.white).lineLimit(1)
                Text([p.show != nil ? p.title : nil, p.sub, "\(hm(p.startDate)) – \(hm(p.endDate))",
                      onNow ? "\(max(1, Int(p.end - now.timeIntervalSince1970) / 60)) min left" : nil].compactMap { $0 }.joined(separator: "  ·  "))
                    .font(.headline).foregroundStyle(Guide.cyan)
                Text(p.overview ?? ch.tagline).font(.callout).foregroundStyle(.white.opacity(0.75)).lineLimit(3)
                    .frame(maxWidth: 980, alignment: .leading)
            }
            Spacer(minLength: 0)
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
                    Text(ch.name).font(.headline).foregroundStyle(.white).lineLimit(1)
                    Text(ch.kind == "tv" ? "Shows" : "Movies").font(.caption2).foregroundStyle(.white.opacity(0.5))
                }
            }
            .frame(width: labelWidth, alignment: .leading)
            ZStack(alignment: .leading) {
                ForEach(ch.programs.filter { $0.slotEnd > t0 && $0.start < t1 }, id: \.self) { p in
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

    // a few seconds after tuning in: the channel bug top right, now/next bottom left
    private var card: some View {
        ZStack {
            if let ch = bug.channel {
                Text("\(ch.number) \(ch.name.uppercased())").font(Guide.mono(28, .black)).foregroundStyle(.white.opacity(0.85))
                    .padding(.horizontal, 16).padding(.vertical, 8).background(.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing).padding(60)
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
                    Text("\(ch.number)").font(Guide.mono(140, .black)).foregroundStyle(Guide.yellow).shadow(color: Guide.yellow.opacity(0.5), radius: 20)
                    Text(ch.name.uppercased()).font(Guide.mono(54, .black)).foregroundStyle(.white)
                    Text(ch.tagline).font(.title3).foregroundStyle(.white.opacity(0.6))
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
