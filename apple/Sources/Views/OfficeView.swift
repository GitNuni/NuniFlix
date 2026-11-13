import SwiftUI

/// The Office on the big screen: NuniFlix HQ as a pixel-art building, one floor per room, live from /api/office
/// (the same snapshot the website's Office draws). Screening room: who's watching what. Search desk: what's being
/// hunted for. Loading dock: downloads. Mailroom: waiting for approval and just delivered. A log down the side.
struct OfficeView: View {
    @EnvironmentObject var model: AppModel
    @StateObject private var art = OfficeArt()
    @State private var snap: Snapshot?
    @State private var error: String?

    struct Person: Decodable { var who: String?; var me: Bool?; var hue: Double? }
    struct Stream: Decodable, Identifiable {
        var key: String; var who: String?; var me: Bool?; var hue: Double?
        var kind: String?; var state: String?; var pct: Double?; var title: String?; var sub: String?; var art: String?; var device: String?
        var id: String { key }
    }
    struct Download: Decodable, Identifiable {
        var key: String; var state: String?; var pct: Double?; var left: Double?; var sub: String?; var title: String?; var poster: String?
        var id: String { key }
    }
    struct Card: Decodable, Identifiable {
        var title: String?; var poster: String?; var who: String?; var hue: Double?; var why: String?; var now: Bool?
        var id: String { (title ?? "") + (who ?? "") }
    }
    struct Event: Decodable, Identifiable {
        var at: Double; var kind: String; var title: String?; var who: String?; var sub: String?
        var id: String { "\(at)\(kind)\(title ?? "")" }
    }
    struct Snapshot: Decodable {
        var streams: [Stream]; var downloads: [Download]; var searching: [Card]; var pending: [Card]; var delivered: [Card]
        var events: [Event]; var brand: String?; var now: Double
    }

    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(hex: 0x0B0820), Color(hex: 0x1A1236)], startPoint: .top, endPoint: .bottom).ignoresSafeArea()
            SeasonalLayer()
            HStack(alignment: .top, spacing: 50) {
                ScrollView {
                    VStack(spacing: 0) {
                        sign
                        floor("Screening room", art.rooms["cinema"], snap.map { "\($0.streams.count) watching" }) { cinema }
                        floor("Search desk", art.rooms["desk"], snap.map { "\($0.searching.count) on the hunt" }) { desk }
                        floor("Loading dock", art.rooms["dock"], snap.map { "\($0.downloads.count) arriving" }) { dock }
                        floor("Mailroom", art.rooms["mail"], snap.map { "\($0.pending.count) waiting · \($0.delivered.count) delivered" }) { mail }
                        Rectangle().fill(Color(hex: 0x2A2340)).frame(height: 18)  // the pavement
                    }
                    .frame(width: 1180)
                    .padding(.vertical, 40)
                }
                log.frame(width: 520)
            }
            .padding(.horizontal, 60)
            if let error { ErrorView(message: error) { Task { await load() } } }
        }
        .task {
            await art.load()
            while !Task.isCancelled {  // live: a fresh snapshot every 8 seconds
                await load()
                try? await Task.sleep(for: .seconds(8))
            }
        }
    }

    // MARK: building

    private var sign: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { tl in
            let flicker = Int(tl.date.timeIntervalSince1970 * 2) % 17 == 0
            HStack(spacing: 0) {
                Text((snap?.brand ?? model.brand).replacingOccurrences(of: "Flix", with: "")).foregroundStyle(.white)
                Text("FLIX").foregroundStyle(Color(hex: 0xFF5468)).opacity(flicker ? 0.3 : 1)
                Text(" HQ").foregroundStyle(.white)
            }
            .font(.system(size: 64, weight: .black, design: .monospaced))
            .shadow(color: Color(hex: 0xFF2240), radius: flicker ? 2 : 18)
            .padding(.horizontal, 40).padding(.vertical, 14)
            .background(Color(hex: 0x120E22), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(hex: 0x3A2E5C), lineWidth: 4))
            .padding(.bottom, 24)
        }
    }

    private func floor<C: View>(_ name: String, _ room: Image?, _ count: String?, @ViewBuilder content: () -> C) -> some View {
        ZStack(alignment: .topLeading) {
            // the room picture fills a fixed-size box without making it wider (a fill image alone reports its full width)
            Color(hex: 0x1E1838).overlay {
                if let room { room.resizable().interpolation(.none).aspectRatio(contentMode: .fill) }
            }
            .frame(width: 1180, height: 330).clipped()
            .overlay(LinearGradient(colors: [.black.opacity(0.15), .black.opacity(0.55)], startPoint: .top, endPoint: .bottom))
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(name.uppercased()).font(.system(size: 26, weight: .heavy, design: .monospaced)).foregroundStyle(.white)
                    Spacer()
                    if let count { Text(count).font(.system(size: 22, weight: .bold, design: .monospaced)).foregroundStyle(.white.opacity(0.7)) }
                }
                content()
            }
            .padding(24)
        }
        .frame(width: 1180, height: 330)
        .overlay(Rectangle().stroke(Color(hex: 0x0A0814), lineWidth: 8))  // the walls between floors
        .focusable()  // so the remote can scroll the building
    }

    // MARK: rooms

    @ViewBuilder private var cinema: some View {
        if let s = snap?.streams, !s.isEmpty {
            HStack(alignment: .bottom, spacing: 26) {
                ForEach(s.prefix(4)) { st in
                    VStack(spacing: 8) {
                        HStack(alignment: .bottom, spacing: 10) {
                            art.person(walking: st.state == "playing").frame(width: 112, height: 112)
                            Picture(url: st.art).frame(width: 150, height: 84).clipShape(RoundedRectangle(cornerRadius: 6))
                                .overlay(alignment: .bottom) { progress(st.pct, height: 6) }
                        }
                        nameTag(st.who, st.hue, me: st.me)
                        Text(st.title ?? "Something good").font(.callout.bold()).foregroundStyle(.white).lineLimit(1)
                        Text([st.sub, st.device, st.state == "paused" ? "paused" : nil].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.caption2).foregroundStyle(.white.opacity(0.7)).lineLimit(1)
                    }
                    .frame(width: 270)
                }
            }
        } else {
            empty("The seats are empty. Nobody's watching right now.")
        }
    }

    @ViewBuilder private var desk: some View {
        if let s = snap?.searching, !s.isEmpty { posters(s.prefix(6).map { ($0.poster, $0.title, $0.now == true ? "Searching right now" : $0.why, $0.who, $0.hue) }) }
        else { empty("Nothing on the corkboard. Every request has been found.") }
    }

    @ViewBuilder private var dock: some View {
        if let d = snap?.downloads, !d.isEmpty {
            HStack(alignment: .top, spacing: 22) {
                ForEach(d.prefix(8)) { x in
                    VStack(alignment: .leading, spacing: 6) {
                        Picture(url: x.poster).frame(width: 112, height: 168).clipShape(RoundedRectangle(cornerRadius: 6))
                            .overlay(alignment: .bottom) { progress(x.pct, height: 8) }
                        Text(x.title ?? "").font(.caption.bold()).foregroundStyle(.white).lineLimit(1)
                        Text(x.state == "stuck" ? "Stuck" : x.state == "importing" ? "Unpacking" : eta(x.left, x.pct))
                            .font(.caption2).foregroundStyle(x.state == "stuck" ? .orange : .white.opacity(0.7))
                    }
                    .frame(width: 112)
                }
            }
        } else {
            empty("The dock is quiet. Nothing downloading.")
        }
    }

    @ViewBuilder private var mail: some View {
        let p = (snap?.pending ?? []).prefix(3).map { ($0.poster, $0.title, Optional("Waiting for approval"), $0.who, $0.hue) }
        let d = (snap?.delivered ?? []).prefix(6 - p.count).map { ($0.poster, $0.title, Optional("Delivered"), $0.who, $0.hue) }
        if p.isEmpty && d.isEmpty { empty("No mail today.") } else { posters(Array(p) + Array(d)) }
    }

    // MARK: pieces

    private func posters(_ items: [(String?, String?, String?, String?, Double?)]) -> some View {
        HStack(alignment: .top, spacing: 22) {
            ForEach(Array(items.prefix(8).enumerated()), id: \.offset) { _, x in
                VStack(alignment: .leading, spacing: 6) {
                    Picture(url: x.0).frame(width: 112, height: 168).clipShape(RoundedRectangle(cornerRadius: 6))
                    Text(x.1 ?? "").font(.caption.bold()).foregroundStyle(.white).lineLimit(1)
                    if let why = x.2 { Text(why).font(.caption2).foregroundStyle(.white.opacity(0.7)).lineLimit(1) }
                    if let who = x.3 { nameTag(who, x.4, me: who == "You") }
                }
                .frame(width: 112)
            }
        }
    }

    private func nameTag(_ who: String?, _ hue: Double?, me: Bool?) -> some View {
        Text(who ?? "Someone")
            .font(.system(size: 18, weight: .bold, design: .monospaced))
            .foregroundStyle(me == true ? Color(hex: 0xFFD34D) : .white)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(Color(hue: (hue ?? 220) / 360, saturation: 0.55, brightness: 0.45), in: RoundedRectangle(cornerRadius: 4))
    }

    private func progress(_ pct: Double?, height: CGFloat) -> some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Rectangle().fill(.black.opacity(0.6))
                Rectangle().fill(Color(hex: 0xFF5468)).frame(width: g.size.width * CGFloat(min(100, max(0, pct ?? 0)) / 100))
            }
        }
        .frame(height: height)
    }

    private func empty(_ text: String) -> some View {
        Text(text).font(.system(size: 22, weight: .medium, design: .monospaced)).foregroundStyle(.white.opacity(0.6)).padding(.top, 40)
    }

    private func eta(_ left: Double?, _ pct: Double?) -> String {
        guard let left, left > 0 else { return "\(Int(pct ?? 0))%" }
        let m = Int(left / 60)
        return "\(Int(pct ?? 0))% · " + (m >= 60 ? "\(m / 60)h \(m % 60)m left" : "\(max(1, m))m left")
    }

    private var log: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("WHAT'S HAPPENING").font(.system(size: 26, weight: .heavy, design: .monospaced)).foregroundStyle(.white)
            ForEach((snap?.events ?? []).prefix(12)) { e in
                VStack(alignment: .leading, spacing: 2) {
                    Text(describe(e)).font(.callout).foregroundStyle(.white).lineLimit(2)
                    Text(ago(e.at)).font(.caption2).foregroundStyle(.white.opacity(0.5))
                }
            }
            if snap?.events.isEmpty ?? true { Text("All quiet.").foregroundStyle(.white.opacity(0.6)) }
            Spacer()
        }
        .padding(28)
        .background(Color(hex: 0x120E22).opacity(0.85), in: RoundedRectangle(cornerRadius: 16))
        .padding(.top, 40)
    }

    private func describe(_ e: Event) -> String {
        let who = e.who ?? "Someone", t = e.title ?? "something"
        switch e.kind {
        case "watch": return "\(who) started \(t)"
        case "stop": return "\(who) stopped \(t)"
        case "req": return "\(who) asked for \(t)"
        case "delivered": return "\(t) arrived for \(who)"
        case "dl": return "Downloading \(t)"
        case "dl_done": return "\(t) finished downloading"
        default: return t
        }
    }

    private func ago(_ at: Double) -> String {
        let s = max(0, (snap?.now ?? Date().timeIntervalSince1970) - at)
        return s < 60 ? "just now" : s < 3600 ? "\(Int(s / 60))m ago" : s < 86400 ? "\(Int(s / 3600))h ago" : "\(Int(s / 86400))d ago"
    }

    private func load() async {
        var q: [String: String] = [:]
        #if DEBUG
        if ProcessInfo.processInfo.environment["NF_OFFICE_DEMO"] != nil { q["demo"] = "true" }  // simulator previews: a busy office
        #endif
        do { snap = try await API.shared.get("/office", q); error = nil }
        catch { if !(error is CancellationError) && snap == nil { self.error = error.localizedDescription } }
    }
}

/// The Office's pixel art from the server: the person sprite (the same frames the website's Office uses) and the
/// PixelLab room backdrops.
@MainActor
final class OfficeArt: ObservableObject {
    @Published var rooms: [String: Image] = [:]
    @Published private var idle: [Image] = []
    @Published private var walk: [Image] = []

    func load() async {
        guard let base = API.shared.base?.absoluteString else { return }
        func fetch(_ path: String) async -> Image? {
            guard let url = URL(string: base + path), let (data, resp) = try? await URLSession.shared.data(from: url),
                  (resp as? HTTPURLResponse)?.statusCode == 200, let cg = UIImage(data: data)?.cgImage else { return nil }
            return Image(decorative: cg, scale: 1).interpolation(.none)
        }
        for r in ["cinema", "desk", "dock", "mail"] { if let i = await fetch("/office/rooms/\(r).png") { rooms[r] = i } }
        var a: [Image] = [], w: [Image] = []
        for i in 0..<4 { if let im = await fetch("/office/breath-se-\(i).png") { a.append(im) } }
        for i in 0..<8 { if let im = await fetch("/office/walk-se-\(i).png") { w.append(im) } }
        idle = a; walk = w
    }

    /// A little animated person: breathing, or walking on the spot while something's playing.
    func person(walking: Bool) -> some View {
        let frames = walking && !walk.isEmpty ? walk : idle
        return TimelineView(.periodic(from: .now, by: walking ? 0.12 : 0.35)) { tl in
            if frames.isEmpty { Color.clear } else {
                frames[Int(tl.date.timeIntervalSince1970 * (walking ? 8.3 : 2.9)) % frames.count].resizable().interpolation(.none)
            }
        }
    }
}
