import SwiftUI

@main
struct NuniFlixApp: App {
    @StateObject private var model = AppModel()

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
    }
}

/// Signed in: pick a service, browse it, open a title, request it.
struct MainView: View {
    @EnvironmentObject var model: AppModel
    @State private var path = NavigationPath()

    var body: some View {
        NavigationStack(path: $path) {
            ServicesView()
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .service(let p): ServiceHomeView(provider: p)
                    case .item(let it): DetailView(item: it)
                    case .search(let p): SearchView(provider: p)
                    case .requests: RequestsView()
                    }
                }
        }
        .task { await model.loadMe() }
    }
}
