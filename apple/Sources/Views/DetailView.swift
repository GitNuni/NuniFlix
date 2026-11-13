import SwiftUI

/// A title: backdrop, what it is, whether it's on the server, and the Request / Play buttons.
struct DetailView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.openURL) private var openURL
    @State var item: Item
    @State private var extras: Extras?
    @State private var error: String?
    @State private var loaded = false
    @State private var busy = false
    @State private var message: String?
    @State private var pickSeasons: Bool? = nil   // non-nil: the season sheet is up (true = 4K)
    @State private var playOptions: PlayOptions?
    @State private var showEpisodes = false
    @State private var resumeChoice: PlayItem?
    @State private var nowPlaying: NowPlaying?
    @State private var playError: String?
    @State private var links: [String: String?] = [:]   // where it is: "plex" / "jellyfin" -> web link

    struct NowPlaying: Identifiable {
        let id = UUID()
        var item: PlayItem
        var upNext: [PlayItem]
        var start: Double
    }

    var theme: ServiceTheme { model.theme }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.spacing) {
                top
                if let error { Text(error).foregroundStyle(.orange).padding(.horizontal, Metrics.gutter) }
                if let seasons = item.seasons, !seasons.isEmpty { seasonStrip(seasons) }
                if let cast = extras?.cast, !cast.isEmpty { castRow(cast) }
                if let col = extras?.collection, col.items.count > 1 {
                    ItemRow(title: col.name ?? "The collection", theme: theme, items: col.items)
                }
                if let recs = extras?.recommendations, !recs.isEmpty {
                    ItemRow(title: "More like this", theme: theme, items: recs)
                }
            }
            .padding(.bottom, Metrics.spacing * 2)
        }
        .background {
            ZStack {
                theme.backgroundView
                Picture(url: item.backdrop).ignoresSafeArea().opacity(0.35).blur(radius: 30)
            }
        }
        .task(id: item.id) { await load() }
        .alert(message ?? "", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK", role: .cancel) {}
        }
        .sheet(isPresented: Binding(get: { pickSeasons != nil }, set: { if !$0 { pickSeasons = nil } })) {
            SeasonPicker(item: item, is4k: pickSeasons ?? false) { seasons in
                let k = pickSeasons ?? false
                pickSeasons = nil
                Task { await request(is4k: k, seasons: seasons) }
            }
        }
        .sheet(isPresented: $showEpisodes) {
            EpisodePicker(title: item.title ?? "Episodes", episodes: playOptions?.items ?? []) { e in
                showEpisodes = false
                Task { try? await Task.sleep(for: .milliseconds(450)); choose(e) }  // let the sheet go first
            }
        }
        .confirmationDialog(resumeChoice?.title ?? "", isPresented: Binding(get: { resumeChoice != nil }, set: { if !$0 { resumeChoice = nil } }),
                            titleVisibility: .visible, presenting: resumeChoice) { e in
            Button("Resume from \(clock(e.resume))") { begin(e, at: e.resume) }
            Button("Start from the beginning") { begin(e, at: 0) }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Can't play it here", isPresented: Binding(get: { playError != nil }, set: { if !$0 { playError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(playError ?? "")
        }
        .fullScreenCover(item: $nowPlaying) { np in
            PlayerScreen(item: np.item, upNext: np.upNext, start: np.start)
        }
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    // MARK: the top: art, title, facts, buttons
    private var top: some View {
        ZStack(alignment: .bottomLeading) {
            Picture(url: item.backdrop ?? item.poster)
                .frame(height: Metrics.heroHeight).frame(maxWidth: .infinity)
            LinearGradient(colors: [.clear, theme.background[0].opacity(0.7), theme.background[0]], startPoint: .top, endPoint: .bottom)
            LinearGradient(colors: [theme.background[0].opacity(0.85), .clear], startPoint: .leading, endPoint: .center)
            VStack(alignment: .leading, spacing: Metrics.spacing / 2) {
                if let logo = extras?.logo {
                    TitleLogo(url: logo).frame(maxWidth: Metrics.heroHeight * 0.75, maxHeight: Metrics.heroHeight * 0.22, alignment: .leading)
                } else {
                    Text(item.title ?? "").font(.system(size: Metrics.heroHeight * 0.075, weight: .heavy)).foregroundStyle(.white)
                }
                Text(facts).font(.callout.weight(.semibold)).foregroundStyle(.white.opacity(0.8))
                if let o = item.overview {
                    Text(o).foregroundStyle(.white.opacity(0.9)).lineLimit(5).frame(maxWidth: 1000, alignment: .leading)
                }
                if let s = item.streaming, !s.isEmpty {
                    Text("Streaming on " + s.map(\.name).joined(separator: ", ")).font(.caption).foregroundStyle(.white.opacity(0.7))
                }
                buttons
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.bottom, Metrics.spacing / 2)
        }
        .frame(height: Metrics.heroHeight)
        .clipped()
    }

    private var facts: String {
        var parts: [String] = []
        if let y = item.year { parts.append(String(y)) }
        if let c = item.certification, !c.isEmpty { parts.append(c) }
        if let r = item.runtime, r > 0 { parts.append(item.isMovie ? "\(r / 60)h \(r % 60)m" : "\(r)m episodes") }
        if let n = item.network, !n.isEmpty { parts.append(n) }
        if let r = item.rating, r > 0 { parts.append(String(format: "★ %.1f", r)) }
        parts += item.genres ?? []
        return parts.joined(separator: "  ·  ")
    }

    @ViewBuilder private var buttons: some View {
        HStack(spacing: 20) {
            if !loaded {
                ProgressView()
            } else {
                if item.status == "available" || item.status == "partial" {
                    if let plex = links["plex"] ?? nil {
                        Button { openPlex(plex) } label: { Label("Play in Plex", systemImage: "play.fill") }
                            .tint(theme.accent)
                    }
                    if let jelly = links["jellyfin"] ?? nil {
                        Button { openJellyfin(jelly) } label: { Label("Play in Jellyfin", systemImage: "play.fill") }
                            .tint(theme.accent)
                    }
                    Button { Task { await play() } } label: { Label("Play here (super experimental!)", systemImage: "play.rectangle") }
                        .disabled(busy)
                }
                if canRequest(is4k: false) {
                    Button { startRequest(is4k: false) } label: {
                        Label(item.status == "partial" ? "Request more" : "Request", systemImage: "plus")
                    }
                    .tint(theme.accent)
                    .disabled(busy)
                }
                if canRequest(is4k: true) {
                    Button { startRequest(is4k: true) } label: { Label("Request in 4K", systemImage: "4k.tv") }
                        .disabled(busy)
                }
                StatusBadge(status: item.status, progress: item.progress)
                if let who = item.requestedBy, item.status != "available" {
                    Text("asked for by \(who)").font(.caption).foregroundStyle(.white.opacity(0.7))
                }
                if busy { ProgressView() }
            }
        }
        #if os(iOS)
        .buttonStyle(.borderedProminent)
        .foregroundStyle(theme.onAccent)
        #endif
    }

    private func canRequest(is4k: Bool) -> Bool {
        guard let me = model.me, item.extID != nil, me.canRequest(item.type) else { return false }
        if is4k { return me.can4K(item.type) && item.status4k != "available" && item.status4k != "processing" }
        switch item.status {
        case "none", nil: return true
        case "partial": return !item.isMovie
        default: return false
        }
    }

    // MARK: rows under the top
    private func seasonStrip(_ seasons: [Season]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Seasons").font(Metrics.rowTitle.weight(theme.rowFont)).foregroundStyle(.white)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(seasons, id: \.n) { s in
                        VStack(spacing: 2) {
                            Text("Season \(s.n)").font(.callout.weight(.semibold))
                            Text(s.complete ? "On server" : (s.have ?? 0) > 0 ? "\(s.have ?? 0) of \(s.episodes ?? 0)" : s.monitored == true ? "On its way" : "\(s.episodes ?? 0) episodes")
                                .font(.caption).foregroundStyle(s.complete ? .green : .secondary)
                        }
                        .padding(.horizontal, 16).padding(.vertical, 10)
                        .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                    }
                }
            }
        }
        .padding(.horizontal, Metrics.gutter)
    }

    private func castRow(_ cast: [Extras.Cast]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Cast").font(Metrics.rowTitle.weight(theme.rowFont)).foregroundStyle(.white).padding(.horizontal, Metrics.gutter)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: Metrics.spacing / 2) {
                    ForEach(cast) { c in
                        VStack(spacing: 6) {
                            Picture(url: c.photo, label: String(c.name.prefix(1)))
                                .frame(width: castSize, height: castSize).clipShape(Circle())
                            Text(c.name).font(.caption.weight(.semibold)).lineLimit(1)
                            if let r = c.role { Text(r).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
                        }
                        .frame(width: castSize + 30)
                        #if os(tvOS)
                        .focusable()
                        #endif
                    }
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.vertical, 8)
            }
            .scrollClipDisabled()
        }
    }

    private var castSize: CGFloat {
        #if os(tvOS)
        return 150
        #else
        return 70
        #endif
    }

    // MARK: loading, requesting, playing
    private func load() async {
        do {
            let path: String
            if item.isMovie, let id = item.extID ?? item.tmdb { path = "/item/movie/\(id)" }
            else if let id = item.extID { path = "/item/tv/\(id)" }
            else if let t = item.tmdb { path = "/item/tvtmdb/\(t)" }
            else { throw APIError(status: 0, message: "Can't look this one up.") }
            let full: Item = try await API.shared.get(path)
            // keep the catalog's pictures if the server's copy has none
            var merged = full
            merged.backdrop = full.backdrop ?? item.backdrop
            merged.poster = full.poster ?? item.poster
            merged.overview = full.overview ?? item.overview
            item = merged
            error = nil
        } catch {
            if !(error is CancellationError) { self.error = error.localizedDescription }
        }
        loaded = true
        if (item.status == "available" || item.status == "partial"), let id = item.extID {
            links = (try? await API.shared.get("/watch/\(item.type)/\(id)")) ?? [:]
        }
        if extras == nil, let t = item.tmdb { extras = try? await API.shared.get("/extra/\(item.type)/\(t)") }
    }

    private func startRequest(is4k: Bool) {
        if item.isMovie { Task { await request(is4k: is4k, seasons: nil) } }
        else if (item.seasons ?? []).count <= 1 { Task { await request(is4k: is4k, seasons: nil) } }
        else { pickSeasons = is4k }
    }

    private func request(is4k: Bool, seasons: [Int]?) async {
        guard let id = item.extID else { return }
        busy = true
        defer { busy = false }
        var body: [String: Any] = ["type": item.type, "id": id, "is4k": is4k]
        if let seasons { body["seasons"] = seasons }
        do {
            let (data, _) = try await API.shared.post("/requests", body)
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let status = (obj?["request"] as? [String: Any])?["status"] as? String
            message = status == "approved" ? "Approved. It's on its way."
                : "Requested. You'll get a notification when it's approved and again when it's ready."
            await load()
        } catch {
            message = error.localizedDescription
        }
    }

    /// Play in the app, from the person's own Plex/Jellyfin. A movie starts (or offers to resume); a show opens its episodes.
    private func play() async {
        guard let id = item.extID else { return }
        busy = true
        defer { busy = false }
        do {
            let o: PlayOptions = try await API.shared.get("/play/\(item.type)/\(id)")
            playOptions = o
            if item.isMovie, let m = o.items.first { choose(m) } else { showEpisodes = true }
        } catch {
            playError = error.localizedDescription
        }
    }

    private func choose(_ e: PlayItem) {
        if e.canResume { resumeChoice = e } else { begin(e, at: 0) }
    }

    private func begin(_ e: PlayItem, at start: Double) {
        let all = playOptions?.items ?? []
        let upNext = item.isMovie ? [] : Array(all.drop { $0.id != e.id }.dropFirst())
        nowPlaying = NowPlaying(item: e, upNext: upNext, start: start)
    }

    /// Open it in the Plex app (or plex.tv on the iPhone, if the app isn't installed).
    /// Plex Home with several users: Plex asks who's watching first and may lose the title (Plex's doing, not ours).
    private func openPlex(_ web: String) {
        guard let app = Self.plexAppURL(web) else { return }
        openURL(app) { ok in
            if ok { return }
            #if os(iOS)
            if let w = URL(string: web) { openURL(w) }
            #else
            message = "Install the Plex app to watch \(item.title ?? "it") there."
            #endif
        }
    }

    /// Jellyfin's web app on the iPhone. The Apple TV has no browser: point them at Swiftfin / the Jellyfin app.
    private func openJellyfin(_ web: String) {
        #if os(iOS)
        if let w = URL(string: web) { openURL(w) }
        #else
        message = "Open Swiftfin or the Jellyfin app to watch \(item.title ?? "it")."
        #endif
    }

    /// https://app.plex.tv/desktop/#!/server/<machine>/details?key=%2Flibrary%2Fmetadata%2F123 -> plex://preplay/?...
    static func plexAppURL(_ web: String) -> URL? {
        guard let s = web.range(of: "/server/"), let d = web.range(of: "/details?key=", range: s.upperBound..<web.endIndex) else { return nil }
        let machine = web[s.upperBound..<d.lowerBound]
        let key = web[d.upperBound...]
        return URL(string: "plex://preplay/?metadataKey=\(key)&server=\(machine)")
    }
}

/// Which seasons? Ones already complete on the server are left out.
struct SeasonPicker: View {
    var item: Item
    var is4k: Bool
    var done: ([Int]?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var picked: Set<Int> = []

    var choices: [Season] { (item.seasons ?? []).filter { is4k || !$0.complete } }

    var body: some View {
        NavigationStack {
            List {
                Section("Pick the seasons you want") {
                    ForEach(choices, id: \.n) { s in
                        Button {
                            if picked.contains(s.n) { picked.remove(s.n) } else { picked.insert(s.n) }
                        } label: {
                            HStack {
                                Image(systemName: picked.contains(s.n) ? "checkmark.circle.fill" : "circle")
                                Text("Season \(s.n)")
                                Spacer()
                                Text((s.have ?? 0) > 0 ? "\(s.have ?? 0) of \(s.episodes ?? 0) on server" : "\(s.episodes ?? 0) episodes")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                Section {
                    Button(picked.isEmpty ? "Pick at least one season" : "Request \(picked.count == 1 ? "Season \(picked.first!)" : "\(picked.count) seasons")") { done(picked.sorted()) }
                        .disabled(picked.isEmpty)
                }
                Section {  // last on purpose: nothing is picked for you, and the whole show is never the first thing focused
                    Button("Every season (the whole show)") { done(nil) }
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle(is4k ? "Request in 4K" : "Request \(item.title ?? "")")
            #if os(iOS)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            #endif
        }
    }
}
