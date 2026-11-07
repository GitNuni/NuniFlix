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
                    Text(model.brand).font(.system(size: titleSize, weight: .black)).foregroundStyle(Color(hex: 0xE50914))
                    Spacer()
                    NavigationLink(value: Route.search(nil)) { Label("Search", systemImage: "magnifyingglass") }
                    NavigationLink(value: Route.requests) { Label("My requests", systemImage: "tray.full") }
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
                    ForEach(providers) { p in
                        NavigationLink(value: Route.service(p)) { ServiceTile(provider: p) }.cardButton()
                    }
                }
            }
            .padding(Metrics.gutter)
        }
        .background(ServiceTheme.nuniflix.backgroundView)
        .task { if !loaded { await load() } }
        .onAppear { model.theme = .nuniflix }
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

/// One service's home screen, in its colours: a big featured title, then rows. Shows / Movies at the top.
struct ServiceHomeView: View {
    @EnvironmentObject var model: AppModel
    var provider: Provider
    @State private var kind = "tv"
    @State private var page: RowsPage?
    @State private var error: String?
    @State private var loading = false

    var theme: ServiceTheme { ServiceTheme.of(provider.name) }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: Metrics.spacing) {
                header
                if let error {
                    ErrorView(message: error) { Task { await load() } }
                } else if let page {
                    if let hero = page.hero { Hero(item: hero, theme: theme) }
                    ForEach(page.rows) { row in
                        ItemRow(title: row.title, theme: theme, items: row.items, more: { n in await more(row, n) })
                            .id("\(kind):\(row.key)")
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 400)
                }
            }
            .padding(.bottom, Metrics.spacing * 2)
        }
        .background(theme.backgroundView)
        .task(id: kind) { await load() }
        .onAppear { model.theme = theme }
        #if os(iOS)
        .navigationTitle(provider.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(theme.background[0], for: .navigationBar)
        #endif
    }

    private var header: some View {
        HStack(spacing: Metrics.spacing / 2) {
            Picture(url: provider.logo).frame(width: logoSize, height: logoSize)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            #if os(tvOS)
            Text(provider.name).font(.title2.weight(.heavy))
            #endif
            Picker("Show", selection: $kind) {
                Text("Shows").tag("tv")
                Text("Movies").tag("movie")
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 420)
            Spacer()
            NavigationLink(value: Route.search(provider)) { Label("Search", systemImage: "magnifyingglass") }
                #if os(iOS)
                .labelStyle(.iconOnly)
                #endif
        }
        .padding(.horizontal, Metrics.gutter)
        .padding(.top, Metrics.spacing / 2)
    }

    private var logoSize: CGFloat {
        #if os(tvOS)
        return 70
        #else
        return 36
        #endif
    }

    private func load() async {
        page = nil; error = nil
        do { page = try await API.shared.get("/browse/provider/\(provider.id)/rows", ["type": kind]) }
        catch { if !(error is CancellationError) { self.error = error.localizedDescription } }
    }

    private func more(_ row: Row, _ n: Int) async -> [Item] {
        var q = ["type": kind, "sort": row.sort, "page": String(n), "quick": "true"]
        if let c = row.cat { q["cat"] = c }
        let d: DiscoverPage? = try? await API.shared.get("/browse/provider/\(provider.id)", q)
        guard let d, d.page <= d.totalPages else { return [] }
        return d.results
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
    @State private var query = ""
    @State private var results: [Item] = []
    @State private var searching = false
    @State private var error: String?

    var theme: ServiceTheme { provider.map { ServiceTheme.of($0.name) } ?? .nuniflix }

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

    var body: some View {
        NavigationStack {
            List {
                Section("Signed in") {
                    LabeledContent("Name", value: model.me?.name ?? "…")
                    LabeledContent("Server", value: model.server?.absoluteString ?? "")
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
