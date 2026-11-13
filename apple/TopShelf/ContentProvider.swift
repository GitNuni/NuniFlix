import TVServices

/// Top Shelf: with NuniFlix highlighted on the Apple TV home screen, the top of the screen shows your Continue watching
/// and what's new on your Plex/Jellyfin (server: /api/library/rows). Selecting one opens it in NuniFlix
/// (nuniflix://item/<type>/<id>). The app shares the server address and sign-in through the app group.
final class ContentProvider: TVTopShelfContentProvider {
    static let group = "group.com.nunitech.nuniflix"

    override func loadTopShelfContent() async -> TVTopShelfContent? {
        let shared = UserDefaults(suiteName: Self.group)
        guard let server = shared?.string(forKey: "server"), let token = shared?.string(forKey: "token"),
              let url = URL(string: server + "/api/library/rows") else { return nil }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, resp) = try? await URLSession.shared.data(for: req), (resp as? HTTPURLResponse)?.statusCode == 200,
              let page = try? JSONDecoder().decode(Page.self, from: data) else { return nil }
        let wanted = ["resume": "Continue watching", "added": "New on \(page.name ?? "your server")"]
        let sections: [TVTopShelfItemCollection<TVTopShelfSectionedItem>] = page.rows.compactMap { row in
            guard let title = wanted[row.key] else { return nil }
            let items = row.items.prefix(12).compactMap { item(server, $0) }
            guard !items.isEmpty else { return nil }
            let c = TVTopShelfItemCollection(items: items)
            c.title = title
            return c
        }
        return sections.isEmpty ? nil : TVTopShelfSectionedContent(sections: sections)
    }

    private func item(_ server: String, _ x: Page.Item) -> TVTopShelfSectionedItem? {
        guard let id = x.id ?? x.tmdb, let open = URL(string: "nuniflix://item/\(x.id == nil ? "tvtmdb" : x.type)/\(id)") else { return nil }
        let it = TVTopShelfSectionedItem(identifier: "\(x.type)-\(id)")
        it.title = x.sub.map { "\(x.title ?? "") · \($0)" } ?? x.title
        it.imageShape = .poster
        if let p = x.poster, let img = URL(string: p.hasPrefix("/") ? server + p : p) {
            it.setImageURL(img, for: .screenScale1x)
            it.setImageURL(img, for: .screenScale2x)
        }
        it.displayAction = TVTopShelfAction(url: open)
        it.playAction = TVTopShelfAction(url: open)
        return it
    }

    private struct Page: Decodable {
        var name: String?
        var rows: [Row]
        struct Row: Decodable { var key: String; var items: [Item] }
        struct Item: Decodable { var type: String; var id: Int?; var tmdb: Int?; var title: String?; var sub: String?; var poster: String? }
    }
}
