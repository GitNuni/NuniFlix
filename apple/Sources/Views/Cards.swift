import SwiftUI

/// Remote picture that fills its frame (TMDB posters and backdrops), with a quiet placeholder.
struct Picture: View {
    var url: String?
    var label: String? = nil

    var body: some View {
        // The image is an overlay on a clear box: the box takes whatever size it's offered, and the picture fills it
        // without pushing it wider. (A fill image on its own reports its full natural width, and a wide backdrop
        // would stretch the whole screen past the edges of a phone.)
        Color.clear.overlay {
            AsyncImage(url: URL(img: url), transaction: Transaction(animation: .easeOut(duration: 0.2))) { phase in
                switch phase {
                case .success(let img):
                    img.resizable().aspectRatio(contentMode: .fill)
                default:
                    ZStack {
                        Color.white.opacity(0.08)
                        if let label { Text(label).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(6) }
                    }
                }
            }
        }
        .clipped()
    }
}

/// Lays its children out left to right and wraps onto a new line when they don't fit (buttons on a narrow phone).
struct FlowLayout: Layout {
    var spacing: CGFloat = 12

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxW = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0, widest: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            let w = min(s.width, maxW)
            if x > 0 && x + w > maxW { y += rowH + spacing; x = 0; rowH = 0 }
            x += w + spacing
            rowH = max(rowH, s.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: min(widest, maxW), height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            let w = min(s.width, bounds.width)
            if x > bounds.minX && x + w > bounds.maxX { y += rowH + spacing; x = bounds.minX; rowH = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: w, height: s.height))
            x += w + spacing
            rowH = max(rowH, s.height)
        }
    }
}

/// The little state pill: on the server already, waiting for approval, downloading.
struct StatusBadge: View {
    var status: String?
    var progress: Double? = nil

    var text: String? {
        switch status {
        case "available": return "On server"
        case "partial": return "Some episodes"
        case "pending": return "Requested"
        case "processing": return progress.map { "Downloading \(Int($0))%" } ?? "On its way"
        default: return nil
        }
    }
    var color: Color {
        switch status {
        case "available": return Color(hex: 0x30D158)
        case "partial": return Color(hex: 0x64D2FF)
        case "pending": return Color(hex: 0xFF9F0A)
        default: return Color(hex: 0x0A84FF)
        }
    }

    var body: some View {
        if let text {
            Text(text)
                .font(.caption2.weight(.bold))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(color, in: Capsule())
                .foregroundStyle(.black)
        }
    }
}

/// A tile in a row: wide (backdrop with the title over it) or a tall poster, as the service does it.
struct ItemCard: View {
    var item: Item
    var theme: ServiceTheme

    var body: some View {
        let size = theme.tile == .wide ? Metrics.wide : Metrics.poster
        ZStack(alignment: .bottomLeading) {
            if theme.tile == .wide {
                Picture(url: item.backdrop ?? item.poster, label: item.title)
                LinearGradient(colors: [.clear, .black.opacity(0.85)], startPoint: .center, endPoint: .bottom)
                Text(item.title ?? "")
                    .font(.headline).lineLimit(2).foregroundStyle(.white)
                    .shadow(radius: 4)
                    .padding(10)
            } else {
                Picture(url: item.poster, label: item.title)
            }
        }
        .frame(width: size.width, height: size.height)
        .overlay(alignment: .topTrailing) { StatusBadge(status: item.status, progress: item.progress).padding(6) }
        .clipShape(RoundedRectangle(cornerRadius: theme.corner, style: .continuous))
        .accessibilityLabel(item.title ?? "")
    }
}

/// A titled horizontal row of tiles. With `more`, it loads the next page when you reach the end.
struct ItemRow: View {
    var title: String
    var theme: ServiceTheme
    var source: [Item]
    var more: ((Int) async -> [Item])? = nil
    @State private var items: [Item]

    init(title: String, theme: ServiceTheme, items: [Item], startPage: Int? = nil, more: ((Int) async -> [Item])? = nil) {
        self.title = title
        self.theme = theme
        self.source = items
        self.more = more
        self.startPage = startPage ?? 1
        _items = State(initialValue: items)
        _page = State(initialValue: startPage ?? 1)
    }
    private let startPage: Int
    @State private var page: Int
    @State private var done = false
    @State private var loading = false

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.spacing / 3) {
            theme.heading(title)
                .padding(.horizontal, Metrics.gutter)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: Metrics.spacing / 2) {
                    ForEach(items) { it in
                        NavigationLink(value: Route.item(it)) { ItemCard(item: it, theme: theme) }
                            .cardButton()
                            .onAppear { if it.id == items.last?.id { Task { await loadMore() } } }
                    }
                }
                .padding(.horizontal, Metrics.gutter)
                .padding(.vertical, Metrics.spacing / 2)
            }
            .scrollClipDisabled()
        }
        // new titles from the parent (a reload): start over from them, so a row never keeps showing stale ones
        .onChange(of: source.map(\.id)) { _, _ in items = source; page = startPage; done = false }
    }

    private func loadMore() async {
        guard let more, !done, !loading else { return }
        loading = true
        defer { loading = false }
        for _ in 0..<3 {  // a page of nothing but repeats: try the next one before giving up
            let next = await more(page + 1)
            if next.isEmpty { done = true; return }
            page += 1
            let seen = Set(items.map(\.id))
            let fresh = next.filter { !seen.contains($0.id) }
            if !fresh.isEmpty { items += fresh; return }
        }
    }
}

/// A grid of tiles (search results, "see all").
struct ItemGrid: View {
    var items: [Item]
    var theme: ServiceTheme
    /// Called when one of the last few tiles comes on screen (load the next page).
    var nearEnd: (() -> Void)? = nil

    var body: some View {
        let size = theme.tile == .wide ? Metrics.wide : Metrics.poster
        LazyVGrid(columns: [GridItem(.adaptive(minimum: size.width), spacing: Metrics.spacing / 2)], spacing: Metrics.spacing) {
            ForEach(Array(items.enumerated()), id: \.element.id) { i, it in
                NavigationLink(value: Route.item(it)) { ItemCard(item: it, theme: theme) }.cardButton()
                    .onAppear { if i >= items.count - 8 { nearEnd?() } }
            }
        }
        .padding(.horizontal, Metrics.gutter)
    }
}

/// Where a tap goes.
enum Route: Hashable {
    case service(Provider)
    case item(Item)
    case search(Provider?)
    case requests
    case browse(Provider, String, [String: String])   // a paged grid: title + query (type/sort/cat)
    case section(Provider, String, String, String?)    // a service-style page: title, type, genre
    case library(String?)                              // your Plex/Jellyfin, or one genre of it
    case libraryAll(String, [String: String])          // everything in it (grid): title + query (type/genre)
    case yourflix
    case seasonal
    case office
}

struct ErrorView: View {
    var message: String
    var retry: (() -> Void)? = nil
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle").font(.largeTitle)
            Text(message).multilineTextAlignment(.center)
            if let retry { Button("Try again", action: retry) }
        }
        .foregroundStyle(.white)
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
