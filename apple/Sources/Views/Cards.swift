import SwiftUI

/// Remote picture that fills its frame (TMDB posters and backdrops), with a quiet placeholder.
struct Picture: View {
    var url: String?
    var label: String? = nil

    var body: some View {
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
        .clipped()
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
    @State var items: [Item]
    var more: ((Int) async -> [Item])? = nil
    @State private var page = 1
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
    }

    private func loadMore() async {
        guard let more, !done, !loading else { return }
        loading = true
        let next = await more(page + 1)
        let seen = Set(items.map(\.id))
        let fresh = next.filter { !seen.contains($0.id) }
        if fresh.isEmpty { done = true } else { items += fresh; page += 1 }
        loading = false
    }
}

/// A grid of tiles (search results, "see all").
struct ItemGrid: View {
    var items: [Item]
    var theme: ServiceTheme

    var body: some View {
        let size = theme.tile == .wide ? Metrics.wide : Metrics.poster
        LazyVGrid(columns: [GridItem(.adaptive(minimum: size.width), spacing: Metrics.spacing / 2)], spacing: Metrics.spacing) {
            ForEach(items) { it in
                NavigationLink(value: Route.item(it)) { ItemCard(item: it, theme: theme) }.cardButton()
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
