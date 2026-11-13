import SwiftUI

@main
struct NuniFlixApp: App {
    @StateObject private var model = AppModel()
    #if os(iOS)
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate  // notifications (Native.swift)
    #endif

    init() {
        // Posters and backdrops: keep plenty on disk so browsing back is instant.
        URLCache.shared = URLCache(memoryCapacity: 64 << 20, diskCapacity: 512 << 20)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Group {
            if model.server == nil {
                ServerView()
            } else if !model.signedIn {
                SignInView()
            } else {
                MainView()
            }
        }
        .animation(.default, value: model.signedIn)
        .animation(.default, value: model.server)
        #if os(tvOS)
        // quick connect: an iPhone on the same network can set this TV up (QuickConnect.swift)
        .task(id: model.signedIn) {
            if model.signedIn { QuickConnectTV.shared.stop() } else {
                QuickConnectTV.shared.onServer = { [weak model] url in if model?.server != url { model?.setServer(url) } }
                QuickConnectTV.shared.start()
            }
        }
        #endif
    }
}

/// Signed in. iPhone/iPad: the NuniFlix website itself (WebAppView), so it always matches the web app.
/// Apple TV: native screens: pick a service, browse it, open a title, request it, play it.
struct MainView: View {
    @EnvironmentObject var model: AppModel
    @State private var path = NavigationPath()

    var body: some View {
        #if os(iOS)
        WebAppView()
            .task { await model.loadMe() }
        #else
        NavigationStack(path: $path) {
            ServicesView()
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .service(let p): ServiceHomeView(provider: p)
                    case .item(let it): DetailView(item: it)
                    case .search(let p): SearchView(provider: p)
                    case .requests: RequestsView()
                    case .browse(let p, let title, let q): BrowseGridView(provider: p, title: title, query: q)
                    case .section(let p, let title, let type, let cat): SectionPage(provider: p, title: title, type: type, cat: cat)
                    case .yourflix: YourFlixView()
                    case .seasonal: SeasonalPage()
                    case .library(let genre): LibraryPage(genre: genre)
                    case .libraryAll(let title, let q): BrowseGridView(provider: nil, title: title, query: q)
                    }
                }
        }
        .task { await model.loadMe() }
        .onOpenURL { url in  // nuniflix://item/movie/603 (Top Shelf)
            let parts = url.pathComponents.filter { $0 != "/" }
            guard url.host() == "item", parts.count == 2, let id = Int(parts[1]) else { return }
            let item = parts[0] == "tvtmdb" ? Item(type: "tv", extID: nil, tmdb: id) : Item(type: parts[0], extID: id, tmdb: parts[0] == "movie" ? id : nil)
            path.append(Route.item(item))
        }
        #endif
    }
}
