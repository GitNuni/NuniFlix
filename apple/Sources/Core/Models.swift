import Foundation

// What the NuniFlix server sends. Decoded with .convertFromSnakeCase (`can_movie` -> `canMovie`, `request_4k` -> `request4K`).

struct Me: Decodable {
    var name: String
    var admin: Bool
    var owner: Bool
    var perms: Perms
    var has4k: Has4K

    struct Perms: Decodable {
        var canMovie: Bool?
        var canTv: Bool?
        var request4K: Bool?   // "request_4k": the snake-case conversion capitalises the k
    }
    struct Has4K: Decodable {
        var movie: Bool
        var tv: Bool
    }

    func canRequest(_ type: String) -> Bool {
        admin || (type == "movie" ? perms.canMovie ?? true : perms.canTv ?? true)
    }
    func can4K(_ type: String) -> Bool {
        (type == "movie" ? has4k.movie : has4k.tv) && (admin || perms.request4K == true)
    }
}

struct AuthOptions: Decodable {
    var jellyfin: Bool
    var plex: Bool
    var discord: Bool
    var fluxer: Bool?      // older servers don't send it
    var name: String?
}

struct Provider: Decodable, Hashable, Identifiable {
    var id: String
    var name: String
    var logo: String?
}

struct Season: Decodable {
    var n: Int
    var episodes: Int?
    var have: Int?
    var monitored: Bool?
    var complete: Bool { (episodes ?? 0) > 0 && (have ?? 0) >= (episodes ?? 0) }
}

/// A movie or show: the same shape for catalog tiles and (with more filled in) the detail page.
struct Item: Decodable, Hashable, Identifiable {
    var type: String            // "movie" | "tv"
    var extID: Int?             // TMDB id for movies, TVDB id for shows (nil: a show not looked up yet)
    var tmdb: Int?
    var title: String?
    var year: Int?
    var poster: String?
    var backdrop: String?
    var overview: String?
    var rating: Double?
    var genres: [String]?
    var status: String?         // none | pending | processing | partial | available
    var progress: Double?
    var requestedBy: String?
    // detail only
    var runtime: Int?
    var certification: String?
    var network: String?
    var seasons: [Season]?
    var status4k: String?
    var streaming: [Provider]?

    enum CodingKeys: String, CodingKey {
        case type, extID = "id", tmdb, title, year, poster, backdrop, overview, rating, genres, status, progress, requestedBy,
             runtime, certification, network, seasons, status4k, streaming
    }

    var id: String { "\(type):\(tmdb ?? extID ?? 0)" }
    var isMovie: Bool { type == "movie" }
    static func == (a: Item, b: Item) -> Bool { a.id == b.id }
    func hash(into h: inout Hasher) { h.combine(id) }
}

struct Row: Decodable, Identifiable {
    var key: String
    var title: String
    var sort: String
    var cat: String?
    var items: [Item]
    var id: String { key }
}

struct RowsPage: Decodable {
    var hero: Item?
    var rows: [Row]
}

struct DiscoverPage: Decodable {
    var results: [Item]
    var page: Int
    var totalPages: Int
}

struct Results: Decodable { var results: [Item] }

struct Providers: Decodable {
    var enabled: Bool
    var providers: [Provider]
}

struct Extras: Decodable {
    var trailer: String?
    var cast: [Cast]
    var collection: Collection?
    var logo: String?
    var recommendations: [Item]

    struct Cast: Decodable, Identifiable {
        var id: Int
        var name: String
        var photo: String?
        var role: String?
    }
    struct Collection: Decodable {
        var name: String?
        var items: [Item]
    }
}

struct MyRequest: Decodable, Identifiable {
    var id: Int
    var type: String
    var mediaId: Int?
    var tmdb: Int?
    var title: String?
    var year: Int?
    var poster: String?
    var seasons: [Int]?
    var is4k: Bool
    var status: String          // pending | approved | denied | failed
    var mediaStatus: String?
    var progress: Double?
    var note: String?

    var asItem: Item {
        Item(type: type, extID: mediaId, tmdb: tmdb, title: title, year: year, poster: poster)
    }
    var label: String {
        switch (status, mediaStatus) {
        case ("pending", _): return "Waiting for approval"
        case ("denied", _): return "Declined"
        case ("failed", _): return "Couldn't send"
        case (_, "available"): return "Ready to watch"
        default:
            if let p = progress { return "Downloading \(Int(p))%" }
            return "On its way"
        }
    }
}

struct Requests: Decodable { var requests: [MyRequest] }

struct SignedIn: Decodable { var token: String }

struct TVCode: Decodable {
    var code: String
    var state: String
    var url: String
    var link: String
    var expires: Int
}

struct StartURL: Decodable {
    var state: String
    var url: String
}
