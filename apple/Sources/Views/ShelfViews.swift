import SwiftUI

/// Shelves: permanent themed tiles (Kids, Christmas, Halloween, Horror…), each with its own pixel-art scene from the
/// server (web/shelves/<key>.png). The ones in season come first and say so (server: shelves.py).
struct Shelf: Decodable, Identifiable, Hashable {
    var key: String
    var title: String
    var tagline: String?
    var art: String?
    var now: Bool?
    var season: String?    // the seasonal background its page borrows (thanksgiving → fall)
    var id: String { key }
}

struct ShelfList: Decodable { var shelves: [Shelf] }

/// Pixel art drawn crisp (no smoothing), filling the box.
struct PixelPicture: View {
    var path: String?
    @State private var img: UIImage?
    var body: some View {
        Color.clear.overlay {
            if let img { Image(uiImage: img).resizable().interpolation(.none).aspectRatio(contentMode: .fill) }
        }
        .clipped()
        .task(id: path) { if let path { img = await HostArt.image(path) } }
    }
}

struct ShelfTile: View {
    @EnvironmentObject var model: AppModel
    var shelf: Shelf
    var body: some View {
        let t = model.appTheme
        ZStack(alignment: .bottomLeading) {
            Color(hex: 0x0B0B12)
            PixelPicture(path: shelf.art)
            LinearGradient(colors: [.clear, .clear, .black.opacity(0.85)], startPoint: .top, endPoint: .bottom)
            VStack(alignment: .leading, spacing: 2) {
                Text(t.uppercase ? shelf.title.uppercased() : shelf.title)
                    .font(t.display == .pixel ? t.font(Metrics.rowTitleSize * 0.8, .black) : .headline.weight(.heavy))
                    .foregroundStyle(.white).shadow(color: .black, radius: 0, x: 2, y: 2).lineLimit(1).minimumScaleFactor(0.6)
                if let tag = shelf.tagline { Text(tag).font(.caption2).foregroundStyle(.white.opacity(0.8)).lineLimit(1) }
            }
            .padding(14)
        }
        .overlay(alignment: .topTrailing) {
            if shelf.now == true {
                Text("IN SEASON").font(.caption2.weight(.heavy)).padding(.horizontal, 8).padding(.vertical, 4)
                    .background(t.accent).foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: t.display == .pixel ? 0 : 6, style: .continuous))
                    .padding(10)
            }
        }
        .frame(width: Metrics.serviceTile.width, height: Metrics.serviceTile.height)
        .clipShape(RoundedRectangle(cornerRadius: t.display == .pixel ? 0 : 14, style: .continuous))
    }
}

/// One shelf: its scene as a banner, then rows (your server's own first, then what's ready, then TMDB rows).
struct ShelfPage: View {
    @EnvironmentObject var model: AppModel
    var shelf: Shelf
    @State private var page: Page?
    @State private var error: String?

    struct Page: Decodable { var title: String; var tagline: String?; var art: String?; var hero: Item?; var rows: [Row] }

    var theme: ServiceTheme { var t = model.appTheme; t.tile = .poster; return t }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Metrics.spacing) {
                ZStack(alignment: .bottomLeading) {
                    PixelPicture(path: shelf.art)
                    LinearGradient(colors: [.clear, .black.opacity(0.75)], startPoint: .center, endPoint: .bottom)
                    VStack(alignment: .leading, spacing: 6) {
                        theme.wordmark(shelf.title, size: Metrics.rowTitleSize * 1.8)
                        if let tag = shelf.tagline { Text(tag).foregroundStyle(.white.opacity(0.85)) }
                    }
                    .padding(Metrics.gutter)
                }
                .frame(maxWidth: .infinity)
                .frame(height: Metrics.serviceTile.height * 2.6)
                if let error {
                    ErrorView(message: error) { Task { await load() } }
                } else if let page {
                    if page.rows.isEmpty {
                        Text("Nothing on this shelf yet. Browsing needs a TMDB key (the owner adds it in Settings).")
                            .foregroundStyle(.secondary).padding(.horizontal, Metrics.gutter)
                    }
                    ForEach(page.rows) { row in ItemRow(title: row.title, theme: theme, items: row.items) }
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 400)
                }
            }
            .padding(.bottom, Metrics.spacing)
        }
        .ignoresSafeArea(edges: .top)
        .background(theme.backgroundView.environment(\.seasonOverride, HolidaySeason(rawValue: shelf.season ?? (shelf.key == "thanksgiving" ? "fall" : shelf.key))))
        .onAppear { model.theme = model.appTheme }
        .task { if page == nil { await load() } }
    }

    private func load() async {
        error = nil
        do { page = try await API.shared.get("/shelves/\(shelf.key)") }
        catch { if !(error is CancellationError) { self.error = error.localizedDescription } }
    }
}
