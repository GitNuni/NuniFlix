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

    static let nuniflix = ServiceTheme(background: [Color(hex: 0x0B0B0F), .black], accent: Color(hex: 0xE50914), tile: .poster, corner: 8)

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
        LinearGradient(colors: background, startPoint: .top, endPoint: .bottom).ignoresSafeArea()
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
    static let serviceTile = CGSize(width: 300, height: 170)
    #else
    static let wide = CGSize(width: 220, height: 124)
    static let poster = CGSize(width: 120, height: 180)
    static let heroHeight: CGFloat = 480
    static let gutter: CGFloat = 16
    static let spacing: CGFloat = 10
    static let rowTitle: Font = .headline
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
