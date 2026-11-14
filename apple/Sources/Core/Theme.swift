import SwiftUI

/// Each service is browsed in its own colours and layout: wide tiles or tall posters, square or rounded,
/// red on black or blue on navy. (Their look, not their logos-as-ours: the real logo comes from TMDB.)
struct ServiceTheme {
    enum Tile { case wide, poster }
    var background: [Color]
    var accent: Color
    var onAccent: Color = .white
    var tile: Tile = .wide
    var corner: CGFloat = 8
    var rowFont: Font.Weight = .semibold
    var heroAlignment: HorizontalAlignment = .leading
    /// Lettering for headings: the web themes' display fonts, approximated with the system's own designs.
    var display: Display = .standard
    var uppercase = false
    /// The NuniFlix wordmark's colour (defaults to the accent).
    var brand: Color? = nil
    /// Pixel art behind the screens (web/theme/<art>/: sky.png along the top), loaded from the server.
    var art: String? = nil

    enum Display { case standard, condensed, serif, serifItalic, rounded, engraved, pixel }

    func font(_ size: CGFloat, _ weight: Font.Weight = .black) -> Font {
        switch display {
        case .standard: return .system(size: size, weight: weight)
        case .condensed: return .system(size: size, weight: weight).width(.condensed)
        case .serif: return .system(size: size, weight: weight, design: .serif)
        case .serifItalic: return .system(size: size, weight: weight, design: .serif).italic()
        case .rounded: return .system(size: size, weight: weight, design: .rounded)
        case .engraved: return .system(size: size, weight: .semibold, design: .serif)
        case .pixel: return .custom("Press Start 2P", fixedSize: (size * 0.6).rounded())  // a very wide face: smaller sizes read the same
        }
    }

    /// A row / section heading in this theme's lettering.
    func heading(_ s: String) -> some View {
        let base = Metrics.rowTitleSize
        return Text(uppercase ? s.uppercased() : s)
            .font(display == .standard ? Metrics.rowTitle.weight(rowFont) : font(base, rowFont))
            .tracking(display == .engraved ? 2 : (uppercase && display != .pixel ? 0.8 : 0))
            .foregroundStyle(.white)
            .shadow(color: display == .pixel ? accent : .clear, radius: 0, x: 3, y: 3)
    }

    /// The app's name as its wordmark, in this theme's lettering. Pixel: yellow with a hard red drop, like a title screen.
    func wordmark(_ name: String, size: CGFloat) -> some View {
        HStack(spacing: size * 0.25) {
            Text(uppercase ? name.uppercased() : name)
                .font(font(size))
                .foregroundStyle(brandColor)
                .shadow(color: display == .pixel ? accent : .clear, radius: 0, x: size * 0.07, y: size * 0.07)
                .shadow(color: display == .pixel ? .black : .clear, radius: 0, x: size * 0.12, y: size * 0.12)
            if let art { ThemeSprite(path: "/theme/\(art)/popcorn.png", size: size * 0.9) }
        }
    }

    var brandColor: Color { brand ?? accent }

    static let nuniflix = ServiceTheme(background: [Color(hex: 0x0B0B0F), .black], accent: Color(hex: 0xE50914), tile: .poster, corner: 8)

    // ---- the web app's themes (Settings → Theme), for NuniFlix's own screens. Each person's pick is saved on the
    // server, so the website and the apps match. Light themes use their dark versions; Atomic Age (light only on
    // the web) gets a night version made from its own colours.
    static let appThemes: [(id: String, name: String)] = [
        ("nuniflix", "NuniFlix"), ("repertory", "Repertory"), ("premiere", "Premiere"), ("nunitech", "Nunitech"),
        ("blockbuster", "Blockbuster"), ("retro", "Retro"), ("atomic", "Atomic Age"), ("horror", "Horror"), ("pixel", "Pixel"),
    ]

    static func app(_ id: String?) -> ServiceTheme {
        switch id {
        case "repertory":
            return ServiceTheme(background: [Color(hex: 0x181714), Color(hex: 0x100F0D)], accent: Color(hex: 0xFF5A2B), onAccent: Color(hex: 0x120D0B),
                                tile: .poster, corner: 3, rowFont: .regular, display: .serif)
        case "premiere":
            return ServiceTheme(background: [Color(hex: 0x1C1C1E), .black], accent: Color(hex: 0xFF5A2B), tile: .poster, corner: 18, rowFont: .bold)
        case "nunitech":
            return ServiceTheme(background: [Color(hex: 0x1D2C5C), Color(hex: 0x0B0C10), Color(hex: 0x2A1426)], accent: Color(hex: 0x0A84FF),
                                tile: .poster, corner: 22, rowFont: .semibold, brand: .white)
        case "blockbuster":
            return ServiceTheme(background: [Color(hex: 0x12306E), Color(hex: 0x0A1F4D)], accent: Color(hex: 0xFFCC00), onAccent: Color(hex: 0x0A1F4D),
                                tile: .poster, corner: 3, rowFont: .bold, display: .condensed, uppercase: true)
        case "retro":
            return ServiceTheme(background: [Color(hex: 0x2E1C12), Color(hex: 0x1E120B)], accent: Color(hex: 0xE8631C), onAccent: Color(hex: 0x1E120B),
                                tile: .poster, corner: 16, rowFont: .heavy, display: .serifItalic, brand: Color(hex: 0xF2A33A))
        case "atomic":
            return ServiceTheme(background: [Color(hex: 0x1F3439), Color(hex: 0x142326)], accent: Color(hex: 0xE2574C), onAccent: Color(hex: 0xFFFAF0),
                                tile: .poster, corner: 18, rowFont: .bold, display: .rounded, brand: Color(hex: 0xF4A259))
        case "horror":
            return ServiceTheme(background: [Color(hex: 0x1A1410), Color(hex: 0x0B0A09)], accent: Color(hex: 0x8E1B1F), onAccent: Color(hex: 0xF3EAD8),
                                tile: .poster, corner: 3, rowFont: .semibold, display: .engraved, uppercase: true, brand: Color(hex: 0xB8963E))
        case "pixel":
            return ServiceTheme(background: [Color(hex: 0x1B1446), Color(hex: 0x0A0820)], accent: Color(hex: 0xFF2E4D), onAccent: .white,
                                tile: .poster, corner: 0, rowFont: .regular, display: .pixel, uppercase: true, brand: Color(hex: 0xFFD43B),
                                art: "pixel")
        default:
            return .nuniflix
        }
    }

    static func of(_ name: String) -> ServiceTheme {
        let n = name.lowercased()
        if n.contains("netflix") {
            return ServiceTheme(background: [Color(hex: 0x141414), Color(hex: 0x141414)], accent: Color(hex: 0xE50914), tile: .wide, corner: 4, rowFont: .bold)
        }
        if n.contains("disney") {
            return ServiceTheme(background: [Color(hex: 0x1A1D29), Color(hex: 0x0E0F14)], accent: Color(hex: 0x0072D2), tile: .wide, corner: 12)
        }
        if n == "max" || n.contains("hbo") {
            return ServiceTheme(background: [Color(hex: 0x0A1240), .black], accent: Color(hex: 0x002BE7), tile: .poster, corner: 6, rowFont: .bold)
        }
        if n.contains("prime") || n.contains("amazon") {
            return ServiceTheme(background: [Color(hex: 0x0F171E), Color(hex: 0x0F171E)], accent: Color(hex: 0x1A98FF), tile: .wide, corner: 8, rowFont: .bold)
        }
        if n.contains("hulu") {
            return ServiceTheme(background: [Color(hex: 0x16181D), Color(hex: 0x0B0C0F)], accent: Color(hex: 0x1CE783), onAccent: .black, tile: .wide, corner: 10)
        }
        if n.contains("apple") {
            return ServiceTheme(background: [Color(hex: 0x1C1C1E), .black], accent: .white, onAccent: .black, tile: .wide, corner: 14)
        }
        if n.contains("paramount") {
            return ServiceTheme(background: [Color(hex: 0x0B1A3A), Color(hex: 0x000814)], accent: Color(hex: 0x0064FF), tile: .poster, corner: 8)
        }
        if n.contains("peacock") {
            return ServiceTheme(background: [Color(hex: 0x111111), .black], accent: Color(hex: 0xF5F5F5), onAccent: .black, tile: .wide, corner: 6, rowFont: .heavy)
        }
        if n.contains("crunchyroll") {
            return ServiceTheme(background: [Color(hex: 0x141519), .black], accent: Color(hex: 0xF47521), tile: .poster, corner: 4, rowFont: .heavy)
        }
        if n.contains("starz") || n.contains("showtime") || n.contains("mgm") {
            return ServiceTheme(background: [Color(hex: 0x101010), .black], accent: Color(hex: 0xD4AF37), onAccent: .black, tile: .poster, corner: 6)
        }
        return .nuniflix
    }

    var backgroundView: some View {
        ZStack {
            LinearGradient(colors: background, startPoint: .top, endPoint: .bottom).ignoresSafeArea()
            if let art { ThemeArt(theme: art) }
            SeasonalLayer()  // leaves, snow… behind every screen (Seasonal.swift)
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

/// Sizes differ a lot between a TV across the room and a phone in your hand.
enum Metrics {
    #if os(tvOS)
    static let wide = CGSize(width: 400, height: 225)
    static let poster = CGSize(width: 220, height: 330)
    static let heroHeight: CGFloat = 760
    static let gutter: CGFloat = 80
    static let spacing: CGFloat = 40
    static let rowTitle: Font = .title3
    static let rowTitleSize: CGFloat = 38
    static let serviceTile = CGSize(width: 300, height: 170)
    #else
    static let wide = CGSize(width: 220, height: 124)
    static let poster = CGSize(width: 120, height: 180)
    static let heroHeight: CGFloat = 480
    static let gutter: CGFloat = 16
    static let spacing: CGFloat = 10
    static let rowTitle: Font = .headline
    static let rowTitleSize: CGFloat = 18
    static let serviceTile = CGSize(width: 160, height: 92)
    #endif
}

extension View {
    /// Focusable, lifting card on Apple TV; a plain tap target on the phone.
    @ViewBuilder func cardButton() -> some View {
        #if os(tvOS)
        self.buttonStyle(.card)
        #else
        self.buttonStyle(.plain)
        #endif
    }
}


/// A theme's pixel art (web/theme/<theme>/): a skyline along the top of the screen, faded into the background, with
/// scanlines over everything. Loaded from the server like the seasonal art, so it can change without an app update.
struct ThemeArt: View {
    var theme: String
    @State private var sky: UIImage?
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .top) {
                if let sky {
                    Image(uiImage: sky).resizable().interpolation(.none).aspectRatio(contentMode: .fill)
                        .frame(width: g.size.width, height: g.size.width * sky.size.height / max(1, sky.size.width))
                        .mask(LinearGradient(colors: [.black, .black.opacity(0.85), .clear], startPoint: .top, endPoint: .bottom))
                        .opacity(0.55)
                }
                Canvas { ctx, size in  // scanlines
                    var y: CGFloat = 0
                    while y < size.height { ctx.fill(Path(CGRect(x: 0, y: y, width: size.width, height: 2)), with: .color(.black.opacity(0.14))); y += 6 }
                }
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
        .task(id: theme) { sky = await HostArt.image("/theme/\(theme)/sky.png") }
    }
}

/// One of a theme's pixel sprites (web/theme/<theme>/), drawn with hard pixel edges.
struct ThemeSprite: View {
    var path: String
    var size: CGFloat
    @State private var img: UIImage?
    var body: some View {
        Group {
            if let img { Image(uiImage: img).resizable().interpolation(.none).aspectRatio(contentMode: .fit) } else { Color.clear }
        }
        .frame(width: size, height: size)
        .task(id: path) { img = await HostArt.image(path) }
    }
}
