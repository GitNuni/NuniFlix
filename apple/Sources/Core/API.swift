import Foundation

struct APIError: LocalizedError {
    var status: Int
    var message: String
    var errorDescription: String? { message }
}

/// Talks to the NuniFlix server with `Authorization: Bearer <token>`.
@MainActor
final class API {
    static let shared = API()

    var base: URL?
    var token: String?
    /// Called when the server says the session is gone (signed out elsewhere, or 90 days unused).
    var onUnauthorized: (@MainActor () -> Void)?

    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 30
        return URLSession(configuration: c)
    }()
    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    /// "/browse/provider/8|9/rows" -> server/api/browse/provider/8%7C9/rows?...
    func url(_ path: String, _ query: [String: String] = [:]) throws -> URL {
        guard let base else { throw APIError(status: 0, message: "No server set.") }
        let encoded = path.replacingOccurrences(of: "|", with: "%7C")
        guard var c = URLComponents(string: base.absoluteString + "/api" + encoded) else {
            throw APIError(status: 0, message: "Bad address.")
        }
        if !query.isEmpty { c.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        guard let u = c.url else { throw APIError(status: 0, message: "Bad address.") }
        return u
    }

    /// Raw call: (body, HTTP status). Throws for errors (status >= 400) with the server's own message.
    func send(_ method: String, _ path: String, query: [String: String] = [:], body: [String: Any]? = nil) async throws -> (Data, Int) {
        var req = URLRequest(url: try url(path, query))
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data, resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch let e as URLError where e.code == .cancelled {
            throw CancellationError()  // the screen went away mid-request: not a network problem
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw APIError(status: 0, message: "Can't reach the server. Check that it's on and the address is right.")
        }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if status >= 400 {
            if status == 401, token != nil { onUnauthorized?() }
            throw APIError(status: status, message: Self.detail(data) ?? "Something went wrong (\(status)).")
        }
        return (data, status)
    }

    func get<T: Decodable>(_ path: String, _ query: [String: String] = [:]) async throws -> T {
        let (data, _) = try await send("GET", path, query: query)
        return try decode(data)
    }

    @discardableResult
    func post(_ path: String, _ body: [String: Any] = [:]) async throws -> (Data, Int) {
        try await send("POST", path, body: body)
    }

    func decode<T: Decodable>(_ data: Data) throws -> T {
        do { return try decoder.decode(T.self, from: data) } catch {
            throw APIError(status: 0, message: "The server sent something unexpected. Is NuniFlix up to date?")
        }
    }

    private static func detail(_ data: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let s = obj["detail"] as? String { return s }
        if let arr = obj["detail"] as? [[String: Any]], let m = arr.first?["msg"] as? String { return m }
        return nil
    }

    /// Server health check for the "which server?" screen.
    func check(_ candidate: URL) async -> Bool {
        guard let u = URL(string: candidate.absoluteString + "/api/health"),
              let r = try? await session.data(from: u),
              (r.1 as? HTTPURLResponse)?.statusCode == 200,
              let obj = try? JSONSerialization.jsonObject(with: r.0) as? [String: Any] else { return false }
        return obj["ok"] as? Bool == true
    }
}

extension URL {
    init?(img: String?) {
        guard let img, !img.isEmpty else { return nil }
        self.init(string: img)
    }
}

/// A request cut short because its screen went away. Most screens skip it; any that show it say this, not "Can't reach".
extension CancellationError: @retroactive LocalizedError {
    public var errorDescription: String? { "Cancelled." }
}
