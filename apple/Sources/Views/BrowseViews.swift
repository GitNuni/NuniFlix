import SwiftUI

/// Home: which service do you want to browse?
struct ServicesView: View {
    @EnvironmentObject var model: AppModel
    @State private var providers: [Provider] = []
    @State private var error: String?
    @State private var loaded = false
    @State private var settings = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.spacing) {
                HStack {
                    Text(model.appTheme.uppercase ? model.brand.uppercased() : model.brand)
                        .font(model.appTheme.font(titleSize)).foregroundStyle(model.appTheme.brandColor)
                    Spacer()
                    NavigationLink(value: Route.search(nil)) { Label("Search", systemImage: "magnifyingglass") }
                    Button { settings = true } label: { Label("Settings", systemImage: "gearshape") }
                }
                #if os(iOS)
                .labelStyle(.iconOnly).font(.title3)
                #endif
                Text(model.me.map { "Hi \($0.name.split(separator: " ").first.map(String.init) ?? $0.name). What do you feel like watching?" }
                     ?? "What do you feel like watching?")
                    .font(.title3).foregroundStyle(.secondary)

                if let error {
                    ErrorView(message: error) { Task { await load() } }
                } else if loaded && providers.isEmpty {
                    ErrorView(message: "Browsing by service needs a TMDB key. The owner can add one in NuniFlix → Settings.")
                } else if !loaded {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 300)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: Metrics.serviceTile.width), spacing: Metrics.spacing)], spacing: Metrics.spacing) {
                    NavigationLink(value: Route.yourflix) { YourFlixTile() }.cardButton()
                    NavigationLink(value: Route.seasonal) { SeasonalTile() }.cardButton()
                    NavigationLink(value: Route.office) { OfficeTile(brand: model.brand) }.cardButton()
                    ForEach(providers) { p in
                        NavigationLink(value: Route.service(p)) { ServiceTile(provider: p) }.cardButton()
                    }
                }
            }
            .padding(Metrics.gutter)
        }
        .background(model.appTheme.backgroundView)
        .task { if !loaded { await load() } }
        .onAppear { model.theme = model.appTheme }
        .sheet(isPresented: $settings) { SettingsView() }
        #if os(iOS)
        .toolbar(.hidden, for: .navigationBar)
        #endif
    }

    private var titleSize: CGFloat {
        #if os(tvOS)
        return 60
        #else
        return 34
        #endif
    }

    private func load() async {
        do {
            let p: Providers = try await API.shared.get("/browse/providers")
            providers = p.providers; error = nil
        } catch { self.error = error.localizedDescription }
        loaded = true
    }
}

struct ServiceTile: View {
    var provider: Provider
    var body: some View {
        let t = ServiceTheme.of(provider.name)
        ZStack {
            LinearGradient(colors: [t.background[0].opacity(1), t.accent.opacity(0.55)], startPoint: .topLeading, endPoint: .bottomTrailing)
            HStack(spacing: 14) {
                Picture(url: provider.logo)
                    .frame(width: Metrics.serviceTile.height * 0.55, height: Metrics.serviceTile.height * 0.55)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                Text(provider.name).font(.headline).foregroundStyle(.white).lineLimit(2)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
        }
        .frame(width: Metrics.serviceTile.width, height: Metrics.serviceTile.height)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// The first "channel": your own requests.
struct YourFlixTile: View {
    @EnvironmentObject var model: AppModel
    var body: some View {
        let t = model.appTheme
        ZStack {
            LinearGradient(colors: [t.accent, t.accent.opacity(0.35), t.background[0]], startPoint: .topLeading, endPoint: .bottomTrailing)
            HStack(spacing: 14) {
                Image(systemName: "person.crop.rectangle.stack.fill")
                    .font(.system(size: Metrics.serviceTile.height * 0.3)).foregroundStyle(.white)
                    .frame(width: Metrics.serviceTile.height * 0.55)
                VStack(alignment: .leading, spacing: 2) {
                    Text(t.uppercase ? "YOURFLIX" : "YourFlix").font(t.font(Metrics.rowTitleSize * 0.85, .black)).foregroundStyle(.white)
                    Text("What you asked for").font(.caption).foregroundStyle(.white.opacity(0.8))
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
        }
        .frame(width: Metrics.serviceTile.width, height: Metrics.serviceTile.height)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// The Office: NuniFlix HQ, live.
struct OfficeTile: View {
    var brand: String
    var body: some View {
        ZStack(alignment: .bottomLeading) {
            LinearGradient(colors: [Color(hex: 0x0B0820), Color(hex: 0x2A1E52)], startPoint: .top, endPoint: .bottom)
            Picture(url: "/office/rooms/cinema.png").opacity(0.55)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 0) {
                    Text(brand.replacingOccurrences(of: "Flix", with: "")).foregroundStyle(.white)
                    Text("FLIX").foregroundStyle(Color(hex: 0xFF5468))
                    Text(" HQ").foregroundStyle(.white)
                }
                .font(.system(size: 26, weight: .black, design: .monospaced)).shadow(color: Color(hex: 0xFF2240), radius: 8)
                Text("Live: who's watching, what's arriving").font(.caption).foregroundStyle(.white.opacity(0.8))
            }
            .padding(14)
        }
        .frame(width: Metrics.serviceTile.width, height: Metrics.serviceTile.height)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// This season's horror channel (31 Nights of Horror, Holiday Horror…): its pixel-art scene behind the name.
struct SeasonalTile: View {
    var body: some View {
        let s = HolidaySeason.current
        ZStack(alignment: .bottomLeading) {
            Color(hex: 0x0B0B12)
            Picture(url: "/season/\(s.artFolder)/scene.png").opacity(0.85)
            LinearGradient(colors: [.clear, .black.opacity(0.8)], startPoint: .top, endPoint: .bottom)
            VStack(alignment: .leading, spacing: 2) {
                Text(s.channelName).font(.headline.weight(.heavy)).foregroundStyle(.white).lineLimit(2)
                Text(HolidaySeason.horrorHours ? "Horror Hours" : "Seasonal horror").font(.caption).foregroundStyle(.red.opacity(0.9))
            }
            .padding(14)
        }
        .frame(width: Metrics.serviceTile.width, height: Metrics.serviceTile.height)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// The seasonal channel: rows of themed horror, "Horror on Plex" from your own library, and late at night short horror.
struct SeasonalPage: View {
    @EnvironmentObject var model: AppModel
    @State private var page: Channel?
    @State private var error: String?

    struct Channel: Decodable { var title: String; var subtitle: String?; var art: String?; var hero: Item?; var rows: [Row]; var late: Bool? }

    var theme: ServiceTheme { ServiceTheme.app("horror") }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.spacing) {
                VStack(alignment: .leading, spacing: 6) {
                    Text((page?.title ?? HolidaySeason.current.channelName).uppercased()).font(theme.font(Metrics.rowTitleSize * 1.8)).foregroundStyle(theme.brandColor)
                    if let sub = page?.subtitle { Text(sub).foregroundStyle(.secondary) }
                    if page?.late == true { Label("Horror Hours", systemImage: "moon.stars.fill").font(.callout).foregroundStyle(.red) }
                }
                .padding(.horizontal, Metrics.gutter)
                if let error {
                    ErrorView(message: error) { Task { await load() } }
                } else if let page {
                    if let hero = page.hero { Hero(item: hero, theme: theme) }
                    ForEach(page.rows) { row in ItemRow(title: row.title, theme: theme, items: row.items) }
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 400)
                }
            }
            .padding(.vertical, Metrics.spacing)
        }
        .background(theme.backgroundView)
        .onAppear { model.theme = theme }
        .task { if page == nil { await load() } }
    }

    private func load() async {
        error = nil
        var q = ["hour": String(Calendar.current.component(.hour, from: Date()))]
        #if DEBUG
        if let s = ProcessInfo.processInfo.environment["NF_SEASON"] { q["season"] = s }
        #endif
        do { page = try await API.shared.get("/seasonal", q) }
        catch { if !(error is CancellationError) { self.error = error.localizedDescription } }
    }
}

/// YourFlix, your own channel: continue watching, your requests (ready, on the way, waiting), then a door into
/// your Plex/Jellyfin library and its genres.
struct YourFlixView: View {
    @EnvironmentObject var model: AppModel
    @State private var requests: [MyRequest] = []
    @State private var lib: RowsPage?
    @State private var forYou: [ForYouRow] = []
    @State private var loaded = false

    struct ForYouRow: Decodable, Identifiable { var title: String; var items: [Item]; var id: String { title } }
    struct ForYou: Decodable { var rows: [ForYouRow] }
    @State private var error: String?

    var theme: ServiceTheme { var t = model.appTheme; t.tile = .poster; return t }

    private func items(_ pick: (MyRequest) -> Bool) -> [Item] {
        var seen = Set<String>()
        return requests.filter(pick).compactMap { r in
            var it = r.asItem
            it.status = r.status == "pending" ? "pending" : (r.mediaStatus ?? "processing")
            it.progress = r.progress
            return seen.insert(it.id).inserted ? it : nil  // a show asked for twice (two seasons) shows once
        }
    }

    private var rows: [(String, [Item])] {
        let ready = items { $0.status == "approved" && ["available", "partial"].contains($0.mediaStatus ?? "") }
        let coming = items { $0.status == "approved" && !["available", "partial"].contains($0.mediaStatus ?? "") }
        let waiting = items { $0.status == "pending" }
        let didnt = items { $0.status == "denied" || $0.status == "failed" }
        return [("Ready to watch", ready), ("On the way", coming), ("Waiting for approval", waiting), ("Didn't go through", didnt)]
            .filter { !$0.1.isEmpty }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.spacing) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(theme.uppercase ? "YOURFLIX" : "YourFlix").font(theme.font(Metrics.rowTitleSize * 2)).foregroundStyle(theme.brandColor)
                    Text(model.me.map { "\($0.name.split(separator: " ").first.map(String.init) ?? $0.name)'s channel" } ?? "Your channel")
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, Metrics.gutter)
                if let error {
                    ErrorView(message: error) { Task { await load() } }
                } else if !loaded {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 300)
                } else {
                    if let resume = lib?.rows.first(where: { $0.key == "resume" }) {
                        ItemRow(title: resume.title, theme: theme, items: resume.items)
                    }
                    ForEach(rows, id: \.0) { title, list in
                        ItemRow(title: "\(title)  ·  \(list.count)", theme: theme, items: list)
                    }
                    ForEach(forYou) { row in  // "Because you watched…", from your own watch history
                        ItemRow(title: row.title, theme: theme, items: row.items)
                    }
                    if rows.isEmpty && lib == nil {
                        Text("Nothing requested yet. Find something on a service and choose Request.")
                            .foregroundStyle(.secondary).padding(.horizontal, Metrics.gutter)
                    }
                    if let lib {
                        LibraryDoor(name: lib.name ?? "Your library", hero: lib.hero ?? lib.rows.flatMap(\.items).first { $0.backdrop != nil }, theme: theme)
                        if let genres = lib.genres, !genres.isEmpty {
                            VStack(alignment: .leading, spacing: Metrics.spacing / 2) {
                                theme.heading("Your genres").padding(.horizontal, Metrics.gutter)
                                LazyVGrid(columns: [GridItem(.adaptive(minimum: Metrics.serviceTile.width), spacing: Metrics.spacing / 2)], spacing: Metrics.spacing / 2) {
                                    ForEach(Array(genres.enumerated()), id: \.element.key) { i, g in
                                        NavigationLink(value: Route.library(g.key)) { GenreTile(title: g.title, index: i, theme: theme) }.cardButton()
                                    }
                                }
                                .padding(.horizontal, Metrics.gutter)
                            }
                        }
                    }
                }
            }
            .padding(.vertical, Metrics.spacing)
        }
        .background(theme.backgroundView)
        .onAppear { model.theme = model.appTheme }
        .task { await load() }
        #if os(iOS)
        .navigationTitle("YourFlix")
        #endif
    }

    private func load() async {
        async let reqs: Requests? = try? API.shared.get("/requests", ["scope": "mine"])
        async let library: RowsPage? = try? API.shared.get("/library/rows")  // nil when no Plex/Jellyfin is linked
        async let fy: ForYou? = try? API.shared.get("/home/foryou")
        let (r, l, f) = await (reqs, library, fy)
        forYou = f?.rows ?? []
        if let r { requests = r.requests; error = nil } else if !loaded && l == nil { error = "Couldn't load YourFlix. Try again." }
        lib = l
        loaded = true
    }
}

/// The big "everything on your Plex/Jellyfin" tile.
struct LibraryDoor: View {
    var name: String
    var hero: Item?
    var theme: ServiceTheme

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing / 2) {
            theme.heading("Browse").padding(.horizontal, Metrics.gutter)
            NavigationLink(value: Route.library(nil)) {
                ZStack(alignment: .bottomLeading) {
                    Picture(url: hero?.backdrop ?? hero?.poster)
                    LinearGradient(colors: [.clear, .black.opacity(0.85)], startPoint: .center, endPoint: .bottom)
                    HStack(spacing: 12) {
                        Image(systemName: "server.rack").font(.title2).foregroundStyle(.white)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Everything on \(name)").font(theme.font(Metrics.rowTitleSize * 1.2, .heavy)).foregroundStyle(.white)
                            Text("Ready to watch right now").font(.callout).foregroundStyle(.white.opacity(0.8))
                        }
                        Image(systemName: "chevron.right").font(.headline).foregroundStyle(.white.opacity(0.8))
                    }
                    .padding(Metrics.spacing / 2)
                }
                .frame(maxWidth: .infinity)
                .frame(height: Metrics.serviceTile.height * 1.8)
                .clipShape(RoundedRectangle(cornerRadius: max(theme.corner, 8), style: .continuous))
            }
            .cardButton()
            .padding(.horizontal, Metrics.gutter)
        }
        .padding(.top, Metrics.spacing / 2)
    }
}

/// A coloured genre tile (service genres and library genres share it).
struct GenreTile: View {
    var title: String
    var index: Int
    var theme: ServiceTheme

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            LinearGradient(colors: [theme.accent.opacity(0.95), theme.accent.opacity(0.35)], startPoint: .topLeading, endPoint: .bottomTrailing)
                .hueRotation(.degrees(Double(index) * 23))
            Text(theme.uppercase ? title.uppercased() : title)
                .font(theme.font(Metrics.rowTitleSize * 0.9, .bold)).foregroundStyle(.white).shadow(radius: 3)
                .padding(Metrics.spacing / 2)
        }
        .frame(height: Metrics.serviceTile.height)
        .clipShape(RoundedRectangle(cornerRadius: max(theme.corner, 8), style: .continuous))
    }
}

/// Your Plex/Jellyfin library (or one genre of it), laid out like a service page.
struct LibraryPage: View {
    @EnvironmentObject var model: AppModel
    var genre: String?
    @State private var page: RowsPage?
    @State private var error: String?

    var theme: ServiceTheme { var t = model.appTheme; t.tile = .poster; return t }
    private var name: String { page?.name ?? "your library" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.spacing) {
                HStack(spacing: Metrics.spacing / 2) {
                    Image(systemName: "server.rack").font(.title2)
                    Text(genre ?? "Everything").font(theme.font(Metrics.rowTitleSize * 1.4, .heavy))
                    Text("on \(name)").font(.title3).foregroundStyle(.secondary)
                }
                .padding(.horizontal, Metrics.gutter)
                if let error {
                    ErrorView(message: error) { Task { await load() } }
                } else if let page {
                    if let hero = page.hero { Hero(item: hero, theme: theme) }
                    ForEach(page.rows) { row in
                        ItemRow(title: row.title, theme: theme, items: row.items, startPage: row.page, more: { n in await more(row, n) })
                    }
                    NavigationLink(value: Route.libraryAll(genre ?? "Everything", ["type": "all"].merging(genre.map { ["genre": $0] } ?? [:]) { a, _ in a })) {
                        Label("See everything", systemImage: "square.grid.3x3.fill")
                            .font(.headline).padding(.horizontal, 30).padding(.vertical, 16)
                    }
                    .padding(.horizontal, Metrics.gutter)
                    if let genres = page.genres, !genres.isEmpty {
                        VStack(alignment: .leading, spacing: Metrics.spacing / 2) {
                            theme.heading("Genres").padding(.horizontal, Metrics.gutter)
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: Metrics.serviceTile.width), spacing: Metrics.spacing / 2)], spacing: Metrics.spacing / 2) {
                                ForEach(Array(genres.enumerated()), id: \.element.key) { i, g in
                                    NavigationLink(value: Route.library(g.key)) { GenreTile(title: g.title, index: i, theme: theme) }.cardButton()
                                }
                            }
                            .padding(.horizontal, Metrics.gutter)
                        }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 400)
                }
            }
            .padding(.vertical, Metrics.spacing)
        }
        .background(theme.backgroundView)
        .onAppear { model.theme = model.appTheme }
        .task { if page == nil { await load() } }
        #if os(iOS)
        .navigationTitle(genre ?? "Your library")
        #endif
    }

    private func load() async {
        error = nil
        var q: [String: String] = [:]
        if let genre { q["genre"] = genre }
        do { page = try await API.shared.get("/library/rows", q) }
        catch { if !(error is CancellationError) { self.error = error.localizedDescription } }
    }

    private func more(_ row: Row, _ n: Int) async -> [Item] {
        guard row.key != "resume" else { return [] }
        var q = ["type": row.type ?? "all", "page": String(n)]
        if let g = row.cat ?? genre { q["genre"] = g }
        let d: DiscoverPage? = try? await API.shared.get("/library", q)
        guard let d, d.page <= d.totalPages else { return [] }
        return d.results
    }
}

/// One service's home screen, in its colours, like the service's own app: a big featured title, rows of movies and
/// shows together, a Movies row and a Shows row, then its genres.
struct ServiceHomeView: View {
    @EnvironmentObject var model: AppModel
    var provider: Provider
    @State private var page: RowsPage?
    @State private var error: String?
    @FocusState private var topFocused: Bool

    var theme: ServiceTheme { ServiceTheme.of(provider.name) }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                // A plain VStack, not a lazy one: the lazy one recycled the top bar (logo, Search) further down the page.
                // The rows scroll sideways lazily on their own, so nothing is lost.
                VStack(alignment: .leading, spacing: Metrics.spacing) {
                    header.id("top")
                    if let error {
                        ErrorView(message: error) { Task { await load() } }
                    } else if let page {
                        if let hero = page.hero { Hero(item: hero, theme: theme) }
                        ForEach(page.rows.filter { !Self.tileKeys.contains($0.key) }) { row in
                            ItemRow(title: row.title, theme: theme, items: row.items, startPage: row.page, more: { n in await more(row, n) })
                        }
                        // Movies / Shows: big doors into everything of that kind on the service
                        let doors = page.rows.filter { Self.tileKeys.contains($0.key) }
                        if !doors.isEmpty { BrowseDoors(provider: provider, rows: doors, theme: theme) }
                        if let genres = page.genres, !genres.isEmpty {
                            GenreGrid(provider: provider, genres: genres, theme: theme)
                        }
                    } else {
                        ProgressView().frame(maxWidth: .infinity, minHeight: 400)
                    }
                }
                .padding(.bottom, Metrics.spacing * 2)
            }
            #if os(tvOS)
            // Back while down in the rows: jump to the top. Back again (already up there): leave, as usual.
            .onExitCommand(perform: topFocused ? nil : {
                withAnimation { proxy.scrollTo("top", anchor: .top) }
                topFocused = true
            })
            #endif
        }
        .background(theme.backgroundView)
        .task { if page == nil { await load() } }
        .onAppear { model.theme = theme }
        #if os(iOS)
        .navigationTitle(provider.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(theme.background[0], for: .navigationBar)
        #endif
    }

    static let tileKeys: Set<String> = ["movies", "shows"]

    private var header: some View {
        HStack(spacing: Metrics.spacing / 2) {
            Picture(url: provider.logo).frame(width: logoSize, height: logoSize)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            #if os(tvOS)
            Text(provider.name).font(.title2.weight(.heavy))
            #endif
            Spacer()
            NavigationLink(value: Route.search(provider)) { Label("Search", systemImage: "magnifyingglass") }
                .focused($topFocused)
                #if os(iOS)
                .labelStyle(.iconOnly)
                #endif
        }
        .padding(.horizontal, Metrics.gutter)
        .padding(.top, Metrics.spacing / 2)
        #if os(tvOS)
        .focusSection()
        #endif
    }

    private var logoSize: CGFloat {
        #if os(tvOS)
        return 70
        #else
        return 36
        #endif
    }

    private func load() async {
        error = nil
        do { page = try await API.shared.get("/browse/provider/\(provider.id)/rows", ["type": "all"]) }
        catch { if !(error is CancellationError) { self.error = error.localizedDescription } }
    }

    private func more(_ row: Row, _ n: Int) async -> [Item] {
        var q = ["type": row.type ?? "all", "sort": row.sort, "page": String(n), "quick": "true"]
        if let c = row.cat { q["cat"] = c }
        let d: DiscoverPage? = try? await API.shared.get("/browse/provider/\(provider.id)", q)
        guard let d, d.page <= d.totalPages else { return [] }
        return d.results
    }
}

/// A service's genres as big tiles; each opens that genre's movies and shows on the service.
struct GenreGrid: View {
    var provider: Provider
    var genres: [GenreRef]
    var theme: ServiceTheme

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing / 2) {
            theme.heading("Genres").padding(.horizontal, Metrics.gutter)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: Metrics.serviceTile.width), spacing: Metrics.spacing / 2)],
                      spacing: Metrics.spacing / 2) {
                ForEach(Array(genres.enumerated()), id: \.element.key) { i, g in
                    NavigationLink(value: Route.section(provider, g.title, "all", g.key)) {
                        ZStack(alignment: .bottomLeading) {
                            LinearGradient(colors: [theme.accent.opacity(0.95), theme.accent.opacity(0.35)],
                                           startPoint: .topLeading, endPoint: .bottomTrailing)
                                .hueRotation(.degrees(Double(i) * 23))
                            Text(theme.uppercase ? g.title.uppercased() : g.title)
                                .font(theme.font(Metrics.rowTitleSize * 0.9, .bold))
                                .foregroundStyle(.white).shadow(radius: 3)
                                .padding(Metrics.spacing / 2)
                        }
                        .frame(height: Metrics.serviceTile.height)
                        .clipShape(RoundedRectangle(cornerRadius: max(theme.corner, 8), style: .continuous))
                    }
                    .cardButton()
                }
            }
            .padding(.horizontal, Metrics.gutter)
        }
        .padding(.top, Metrics.spacing / 2)
    }
}

/// Movies / Shows as two wide tiles with a picture from the service, each opening everything of that kind.
struct BrowseDoors: View {
    var provider: Provider
    var rows: [Row]
    var theme: ServiceTheme

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing / 2) {
            theme.heading("Browse").padding(.horizontal, Metrics.gutter)
            HStack(spacing: Metrics.spacing / 2) {
                ForEach(rows) { row in
                    NavigationLink(value: Route.section(provider, row.title, row.type ?? (row.key == "movies" ? "movie" : "tv"), nil)) {
                        ZStack(alignment: .bottomLeading) {
                            Picture(url: row.items.first(where: { $0.backdrop != nil })?.backdrop)
                            LinearGradient(colors: [.clear, .black.opacity(0.85)], startPoint: .center, endPoint: .bottom)
                            HStack {
                                Text(theme.uppercase ? row.title.uppercased() : row.title)
                                    .font(theme.font(Metrics.rowTitleSize * 1.3, .heavy)).foregroundStyle(.white)
                                Image(systemName: "chevron.right").font(.headline).foregroundStyle(.white.opacity(0.8))
                            }
                            .padding(Metrics.spacing / 2)
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: Metrics.serviceTile.height * 1.6)
                        .clipShape(RoundedRectangle(cornerRadius: max(theme.corner, 8), style: .continuous))
                    }
                    .cardButton()
                }
            }
            .padding(.horizontal, Metrics.gutter)
        }
        .padding(.top, Metrics.spacing / 2)
    }
}

/// Movies, Shows or one genre on a service, laid out like the service: a banner, rows (Popular, New releases, Top rated,
/// genre rows…), then "See everything" for the full grid.
struct SectionPage: View {
    @EnvironmentObject var model: AppModel
    var provider: Provider
    var title: String
    var type: String          // movie / tv / all
    var cat: String?          // a genre (with type all)
    @State private var page: RowsPage?
    @State private var error: String?

    var theme: ServiceTheme { ServiceTheme.of(provider.name) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.spacing) {
                HStack(spacing: Metrics.spacing / 2) {
                    Picture(url: provider.logo).frame(width: 56, height: 56).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    Text(theme.uppercase ? title.uppercased() : title).font(theme.font(Metrics.rowTitleSize * 1.4, .heavy))
                    Text("on \(provider.name)").font(.title3).foregroundStyle(.secondary)
                }
                .padding(.horizontal, Metrics.gutter)
                if let error {
                    ErrorView(message: error) { Task { await load() } }
                } else if let page {
                    if let hero = page.hero { Hero(item: hero, theme: theme) }
                    ForEach(page.rows) { row in
                        ItemRow(title: row.title, theme: theme, items: row.items, startPage: row.page, more: { n in await more(row, n) })
                    }
                    NavigationLink(value: Route.browse(provider, title, ["type": type, "sort": "popular"].merging(cat.map { ["cat": $0] } ?? [:]) { a, _ in a })) {
                        Label("See everything", systemImage: "square.grid.3x3.fill")
                            .font(.headline).padding(.horizontal, 30).padding(.vertical, 16)
                    }
                    .padding(.horizontal, Metrics.gutter)
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 400)
                }
            }
            .padding(.vertical, Metrics.spacing)
        }
        .background(theme.backgroundView)
        .onAppear { model.theme = theme }
        .task { if page == nil { await load() } }
        #if os(iOS)
        .navigationTitle(title)
        #endif
    }

    private func load() async {
        error = nil
        var q = ["type": type]
        if let cat { q["cat"] = cat }
        do { page = try await API.shared.get("/browse/provider/\(provider.id)/rows", q) }
        catch { if !(error is CancellationError) { self.error = error.localizedDescription } }
    }

    private func more(_ row: Row, _ n: Int) async -> [Item] {
        var q = ["type": row.type ?? type, "sort": row.sort, "page": String(n), "quick": "true"]
        if let c = row.cat ?? cat { q["cat"] = c }
        let d: DiscoverPage? = try? await API.shared.get("/browse/provider/\(provider.id)", q)
        guard let d, d.page <= d.totalPages else { return [] }
        return d.results
    }
}

/// Everything of one kind on a service (all movies, all shows, one genre), loading more as you get near the end.
struct BrowseGridView: View {
    @EnvironmentObject var model: AppModel
    var provider: Provider?       // nil: your own Plex/Jellyfin library
    var title: String
    var query: [String: String]
    var libraryName = "your library"
    @State private var items: [Item] = []
    @State private var page = 0
    @State private var total = 1
    @State private var loading = false
    @State private var error: String?

    var theme: ServiceTheme { provider.map { ServiceTheme.of($0.name) } ?? { var t = model.appTheme; t.tile = .poster; return t }() }
    private var endpoint: String { provider.map { "/browse/provider/\($0.id)" } ?? "/library" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.spacing) {
                #if os(tvOS)
                Text("\(title) on \(provider?.name ?? libraryName)").font(theme.font(Metrics.rowTitleSize * 1.4, .heavy))
                    .padding(.horizontal, Metrics.gutter)
                #endif
                ItemGrid(items: items, theme: theme) { Task { await next() } }
                if let error {
                    ErrorView(message: error) { Task { await next() } }
                } else if loading {
                    ProgressView().frame(maxWidth: .infinity).padding()
                } else if items.isEmpty && page >= total {
                    Text("Nothing here right now.").foregroundStyle(.secondary).frame(maxWidth: .infinity).padding()
                }
            }
            .padding(.vertical, Metrics.spacing)
        }
        .background(theme.backgroundView)
        .onAppear { model.theme = theme }
        .task { if items.isEmpty { await next() } }
        #if os(iOS)
        .navigationTitle(title)
        #endif
    }

    private func next() async {
        guard !loading, page < total else { return }
        loading = true
        defer { loading = false }
        var q = query
        q["page"] = String(page + 1)
        q["quick"] = "true"
        do {
            let d: DiscoverPage = try await API.shared.get(endpoint, q)
            let seen = Set(items.map(\.id))
            items += d.results.filter { !seen.contains($0.id) }
            page = d.page
            total = d.totalPages
            error = nil
            // a page that was all repeats: go straight on to the next so the grid doesn't stall
            if d.results.allSatisfy({ seen.contains($0.id) }) && page < total { loading = false; await next() }
        } catch {
            if !(error is CancellationError) { self.error = error.localizedDescription }
        }
    }
}

/// The big banner at the top: backdrop, the title's logo when TMDB has one, a line about it, two buttons.
struct Hero: View {
    var item: Item
    var theme: ServiceTheme
    @State private var logo: String?

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Picture(url: item.backdrop)
                .frame(height: Metrics.heroHeight)
                .frame(maxWidth: .infinity)
            LinearGradient(colors: [.clear, theme.background[0].opacity(0.6), theme.background[0]], startPoint: .top, endPoint: .bottom)
            LinearGradient(colors: [theme.background[0].opacity(0.9), .clear], startPoint: .leading, endPoint: .center)
            VStack(alignment: .leading, spacing: Metrics.spacing / 2) {
                if let logo {
                    TitleLogo(url: logo)
                        .frame(maxWidth: Metrics.heroHeight * 0.75, maxHeight: Metrics.heroHeight * 0.25, alignment: .leading)
                } else {
                    Text(item.title ?? "").font(.system(size: Metrics.heroHeight * 0.08, weight: .heavy)).foregroundStyle(.white)
                }
                Text(meta).font(.callout.weight(.semibold)).foregroundStyle(.white.opacity(0.8))
                if let o = item.overview {
                    Text(o).lineLimit(3).foregroundStyle(.white.opacity(0.85)).frame(maxWidth: 900, alignment: .leading)
                }
                HStack(spacing: 20) {
                    NavigationLink(value: Route.item(item)) {
                        Label(item.status == "available" ? "Watch" : "More info", systemImage: item.status == "available" ? "play.fill" : "info.circle")
                    }
                    #if os(iOS)
                    .buttonStyle(.borderedProminent).tint(theme.accent).foregroundStyle(theme.onAccent)
                    #endif
                    StatusBadge(status: item.status, progress: item.progress)
                }
            }
            .padding(.horizontal, Metrics.gutter)
            .padding(.bottom, Metrics.spacing)
        }
        .frame(height: Metrics.heroHeight)
        .clipped()
        .task(id: item.id) {
            if let t = item.tmdb, let x: Extras = try? await API.shared.get("/extra/\(item.type)/\(t)") { logo = x.logo }
        }
    }

    private var meta: String {
        var parts: [String] = []
        if let y = item.year { parts.append(String(y)) }
        if let r = item.rating, r > 0 { parts.append(String(format: "★ %.1f", r)) }
        parts += item.genres ?? []
        return parts.joined(separator: "  ·  ")
    }
}

/// Search: one service's catalogue, or everything (what Radarr/Sonarr can find).
struct SearchView: View {
    var provider: Provider?
    @EnvironmentObject var model: AppModel
    @State private var query = ""
    @State private var results: [Item] = []
    @State private var searching = false
    @State private var error: String?

    var theme: ServiceTheme { provider.map { ServiceTheme.of($0.name) } ?? model.appTheme }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.spacing) {
                if let error { Text(error).foregroundStyle(.red).padding(.horizontal, Metrics.gutter) }
                if searching { ProgressView().frame(maxWidth: .infinity) }
                if !searching && results.isEmpty && query.count >= 2 && error == nil {
                    Text("Nothing found.").foregroundStyle(.secondary).padding(.horizontal, Metrics.gutter)
                }
                ItemGrid(items: results, theme: theme)
            }
            .padding(.vertical, Metrics.spacing)
        }
        .background(theme.backgroundView)
        .searchable(text: $query, prompt: provider.map { "Search \($0.name)" } ?? "Search movies and shows")
        .navigationTitle(provider?.name ?? "Search")
        .task(id: query) { await search() }
        .onAppear { model.theme = theme }
    }

    private func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= 2 else { results = []; return }
        do { try await Task.sleep(for: .milliseconds(450)) } catch { return }  // wait for the typing to pause
        searching = true; error = nil
        defer { searching = false }
        do {
            let path = provider.map { "/browse/provider/\($0.id)/search" } ?? "/search"
            let r: Results = try await API.shared.get(path, ["q": q])
            results = r.results
        } catch {
            if !(error is CancellationError) { self.error = error.localizedDescription }
        }
    }
}

/// Your requests and where they're at.
struct RequestsView: View {
    @EnvironmentObject var model: AppModel
    @State private var requests: [MyRequest] = []
    @State private var error: String?
    @State private var loaded = false

    var body: some View {
        List {
            if let error { Text(error).foregroundStyle(.red) }
            if loaded && requests.isEmpty && error == nil { Text("Nothing requested yet.").foregroundStyle(.secondary) }
            ForEach(requests) { r in
                NavigationLink(value: Route.item(r.asItem)) {
                    HStack(spacing: 20) {
                        Picture(url: r.poster).frame(width: thumb.width, height: thumb.height)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                        VStack(alignment: .leading, spacing: 4) {
                            Text(r.title ?? "").font(.headline)
                            Text(details(r))
                                .font(.caption).foregroundStyle(.secondary)
                            Text(r.label).font(.callout.weight(.semibold)).foregroundStyle(color(r))
                            if let n = r.note, r.status == "denied" { Text(n).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
            }
        }
        .navigationTitle("My requests")
        #if os(iOS)
        .scrollContentBackground(.hidden)
        #endif
        .background(model.appTheme.backgroundView)
        .onAppear { model.theme = model.appTheme }
        .task { await load() }
        .refreshable { await load() }
    }

    private var thumb: CGSize {
        #if os(tvOS)
        return CGSize(width: 100, height: 150)
        #else
        return CGSize(width: 50, height: 75)
        #endif
    }

    private func details(_ r: MyRequest) -> String {
        var parts: [String] = []
        if let y = r.year { parts.append(String(y)) }
        if r.is4k { parts.append("4K") }
        if let s = r.seasons, !s.isEmpty { parts.append((s.count == 1 ? "Season " : "Seasons ") + s.map { String($0) }.joined(separator: ", ")) }
        return parts.joined(separator: " · ")
    }

    private func color(_ r: MyRequest) -> Color {
        if r.status == "denied" || r.status == "failed" { return .red }
        if r.status == "pending" { return .orange }
        return r.mediaStatus == "available" ? .green : .blue
    }

    private func load() async {
        do { requests = try await (API.shared.get("/requests", ["scope": "mine"]) as Requests).requests; error = nil }
        catch { self.error = error.localizedDescription }
        loaded = true
    }
}

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var seasonTick = false

    var body: some View {
        NavigationStack {
            List {
                Section("Signed in") {
                    LabeledContent("Name", value: model.me?.name ?? "…")
                    LabeledContent("Server", value: model.server?.absoluteString ?? "")
                }
                Section {
                    Picker("Theme", selection: Binding(get: { model.themeID }, set: { id in Task { await model.setTheme(id) } })) {
                        ForEach(ServiceTheme.appThemes, id: \.id) { Text($0.name).tag($0.id) }
                    }
                } footer: {
                    Text("For NuniFlix's own screens. Browsing a service keeps that service's look. Same theme as on the website.")
                }
                Section {
                    Toggle("Seasonal effects", isOn: Binding(get: { UserDefaults.standard.object(forKey: "season") as? Bool ?? true },
                                                             set: { v in UserDefaults.standard.set(v, forKey: "season"); seasonTick.toggle()
                                                                 Task { _ = try? await API.shared.post("/me/prefs", ["season": v]) } }))
                        .id(seasonTick)
                } footer: {
                    Text("Falling leaves, snow… and the odd visitor around the holidays. Same setting as on the website.")
                }
                Section {
                    Button("Sign out", role: .destructive) { Task { await model.signOut(); dismiss() } }
                    Button("Use a different server") { Task { await model.clearServer(); dismiss() } }
                }
            }
            .navigationTitle("Settings")
            #if os(iOS)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            #endif
        }
    }
}

/// A title's logo art (transparent PNG), fitted, never cropped.
struct TitleLogo: View {
    var url: String
    var body: some View {
        AsyncImage(url: URL(string: url)) { img in
            img.resizable().scaledToFit()
        } placeholder: { Color.clear }
    }
}
