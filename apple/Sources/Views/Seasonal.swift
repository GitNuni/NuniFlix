import SwiftUI

/// The seasonal background (same as the website's web/season.js): a few slow particles behind every screen, and now
/// and then a small horror cameo along the bottom. October leaves + bats, November leaves + a turkey with an axe,
/// Dec 1 – Jan 6 snow + Krampus, Jan–Feb light snow, spring petals, summer fireflies, September leaves.
/// Everything is worked out from the clock (no state), so it costs almost nothing. On by default; Settings or the
/// website turn it off (prefs.season), and so does Reduce Motion.
struct SeasonalLayer: View {
    @AppStorage("season") private var on = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if on && !reduceMotion {
            TimelineView(.animation(minimumInterval: 1 / 30)) { tl in
                Canvas { ctx, size in
                    HolidaySeason.current.draw(&ctx, size, tl.date.timeIntervalSinceReferenceDate)
                }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .ignoresSafeArea()
        }
    }
}

enum HolidaySeason: String {
    case halloween, fall, autumn, christmas, winter, spring, summer

    static var current: HolidaySeason {
        #if DEBUG  // simulator previews: NF_SEASON=christmas
        if let s = ProcessInfo.processInfo.environment["NF_SEASON"], let v = HolidaySeason(rawValue: s) { return v }
        #endif
        let c = Calendar.current.dateComponents([.month, .day], from: Date())
        switch (c.month ?? 1, c.day ?? 1) {
        case (10, _): return .halloween
        case (11, _): return .fall
        case (12, _), (1, ...6): return .christmas
        case (1, _), (2, _): return .winter
        case (3...5, _): return .spring
        case (6...8, _): return .summer
        default: return .autumn
        }
    }

    private enum Kind { case leaf, snow, petal, fly }
    private var kind: Kind {
        switch self {
        case .halloween, .fall, .autumn: return .leaf
        case .christmas, .winter: return .snow
        case .spring: return .petal
        case .summer: return .fly
        }
    }
    private var count: Int {
        switch self {
        case .christmas: return 70
        case .winter: return 30
        case .fall: return 22
        case .halloween: return 14
        case .autumn: return 12
        case .spring, .summer: return 12
        }
    }
    private enum Cameo { case krampus, turkey, bats }
    private var cameo: Cameo? {
        switch self {
        case .christmas: return .krampus
        case .fall: return .turkey
        case .halloween: return .bats
        default: return nil
        }
    }
    private var eyes: Bool { self == .christmas || self == .halloween }

    /// A stable pseudo-random number in 0..<1 for particle i, property k.
    private func r(_ i: Int, _ k: Int) -> Double {
        let x = sin(Double(i * 127 + k * 311) * 12.9898) * 43758.5453
        return x - x.rounded(.down)
    }

    func draw(_ ctx: inout GraphicsContext, _ size: CGSize, _ t: Double) {
        let W = size.width, H = size.height
        for i in 0..<count { particle(&ctx, i, W, H, t) }
        if eyes { drawEyes(&ctx, W, H, t) }
        if let cameo { drawCameo(&ctx, cameo, W, H, t) }
    }

    private static let leafColors: [Color] = [0xB8461B, 0xA5541A, 0x8A3A14, 0xC2741C, 0x7A2E12, 0x9C6A17].map { Color(hex: $0) }

    private func particle(_ ctx: inout GraphicsContext, _ i: Int, _ W: Double, _ H: Double, _ t: Double) {
        switch kind {
        case .snow:
            let speed = 18 + r(i, 1) * 34, rad = 1.2 + r(i, 2) * 2.4
            let y = (r(i, 3) * (H + 40) + t * speed).truncatingRemainder(dividingBy: H + 40) - 20
            let x = r(i, 4) * W + sin(t * (0.4 + r(i, 5)) + r(i, 6) * 6) * 14
            ctx.fill(Path(ellipseIn: CGRect(x: x, y: y, width: rad * 2, height: rad * 2)), with: .color(.white.opacity(0.3 + r(i, 7) * 0.45)))
        case .leaf, .petal:
            let leaf = kind == .leaf
            let speed = leaf ? 22 + r(i, 1) * 26 : 14 + r(i, 1) * 16, rad = leaf ? 9 + r(i, 2) * 9 : 4 + r(i, 2) * 3
            let y = (r(i, 3) * (H + 60) + t * speed).truncatingRemainder(dividingBy: H + 60) - 30
            let x = r(i, 4) * W + sin(t * (0.5 + r(i, 5) * 0.6) + r(i, 6) * 6) * 30
            var c = ctx
            c.translateBy(x: x, y: y)
            c.rotate(by: .radians(r(i, 8) * 6.28 + t * (r(i, 9) - 0.5) * 1.2))
            c.opacity = leaf ? 0.45 + r(i, 7) * 0.25 : 0.35 + r(i, 7) * 0.25
            var p = Path()
            if leaf {
                p.move(to: CGPoint(x: 0, y: -rad))
                p.addQuadCurve(to: CGPoint(x: 0, y: rad), control: CGPoint(x: rad * 0.9, y: 0))
                p.addQuadCurve(to: CGPoint(x: 0, y: -rad), control: CGPoint(x: -rad * 0.9, y: 0))
                c.fill(p, with: .color(Self.leafColors[i % Self.leafColors.count]))
                var vein = Path(); vein.move(to: CGPoint(x: 0, y: -rad)); vein.addLine(to: CGPoint(x: 0, y: rad * 1.3))
                c.stroke(vein, with: .color(.black.opacity(0.25)), lineWidth: 1)
            } else {
                c.fill(Path(ellipseIn: CGRect(x: -rad, y: -rad * 0.6, width: rad * 2, height: rad * 1.2)), with: .color(Color(hex: 0xF9C6D3)))
            }
        case .fly:
            let x = r(i, 1) * W + sin(t * (0.2 + r(i, 2) * 0.3) + r(i, 3) * 6) * 80
            let y = H * (0.35 + r(i, 4) * 0.6) + cos(t * (0.15 + r(i, 5) * 0.25) + r(i, 6) * 6) * 50
            let a = max(0, sin(t * (0.8 + r(i, 7)) + r(i, 8) * 6)) * 0.8
            var c = ctx
            c.addFilter(.shadow(color: Color(hex: 0xBEF264), radius: 8))
            c.fill(Path(ellipseIn: CGRect(x: x, y: y, width: 4, height: 4)), with: .color(Color(hex: 0xD9F99D).opacity(a)))
        }
    }

    // MARK: horror bits

    private func redEyes(_ ctx: inout GraphicsContext, _ x: Double, _ y: Double, _ r: Double, _ alpha: Double = 1) {
        var c = ctx
        c.addFilter(.shadow(color: .red, radius: r * 3))
        let col = Color(red: 1, green: 0.16, blue: 0.16).opacity(alpha)
        c.fill(Path(ellipseIn: CGRect(x: x - r * 2.8, y: y - r, width: r * 2, height: r * 2)), with: .color(col))
        c.fill(Path(ellipseIn: CGRect(x: x + r * 0.8, y: y - r, width: r * 2, height: r * 2)), with: .color(col))
    }

    /// A pair of red eyes that opens somewhere in the dark for a few seconds, once a minute or so.
    private func drawEyes(_ ctx: inout GraphicsContext, _ W: Double, _ H: Double, _ t: Double) {
        let period = 70.0, q = (t.truncatingRemainder(dividingBy: period)) / 4.5
        guard q < 1 else { return }
        let n = Int(t / period)
        if q > 0.45 && q < 0.5 { return }  // a blink
        redEyes(&ctx, 60 + r(n, 1) * (W - 120), 80 + r(n, 2) * H * 0.4, 3, sin(q * .pi) * 0.7)
    }

    /// Every ~95 seconds something crosses the bottom of the screen, alternating direction.
    private func drawCameo(_ ctx: inout GraphicsContext, _ which: Cameo, _ W: Double, _ H: Double, _ t: Double) {
        var period = 95.0
        let dur = which == .bats ? 10.0 : 18.0
        #if DEBUG
        if ProcessInfo.processInfo.environment["NF_CAMEO"] != nil { period = 22 }  // simulator previews: one every 22 s
        #endif
        let phase = (t + 30).truncatingRemainder(dividingBy: period)
        guard phase < dur else { return }
        let q = phase / dur, n = Int((t + 30) / period)
        let right = n % 2 == 0, travel = W + 400
        let x = right ? -200 + q * travel : W + 200 - q * travel
        let s = max(1.2, min(2.2, W / 900)), g = H - 40
        var c = ctx
        c.opacity = min(1, q * 8, (1 - q) * 8) * 0.85
        if !right { c.translateBy(x: W, y: 0); c.scaleBy(x: -1, y: 1) }
        let px = right ? x : W - x, ph = phase * 6
        switch which {
        case .krampus: krampus(&c, px, g, s, ph)
        case .turkey: turkey(&c, px, g, s, ph)
        case .bats: bats(&c, px, H * 0.3, s, ph)
        }
    }

    /// Shadowy charcoal: the app's backgrounds are dark, so pure black would leave only the eyes showing.
    private static let sil = Color(red: 0.24, green: 0.22, blue: 0.22).opacity(0.9)

    private func krampus(_ ctx: inout GraphicsContext, _ x: Double, _ g: Double, _ s: Double, _ ph: Double) {
        var c = ctx
        c.translateBy(x: x, y: g); c.scaleBy(x: s, y: s)
        let sw = sin(ph) * 6, ink = GraphicsContext.Shading.color(Self.sil)
        var legs = Path()
        legs.move(to: CGPoint(x: -6, y: -34)); legs.addLine(to: CGPoint(x: -8 + sw, y: -16)); legs.addLine(to: CGPoint(x: -12 + sw, y: 0))
        legs.move(to: CGPoint(x: 4, y: -34)); legs.addLine(to: CGPoint(x: 6 - sw, y: -16)); legs.addLine(to: CGPoint(x: 2 - sw, y: 0))
        c.stroke(legs, with: ink, style: StrokeStyle(lineWidth: 5, lineCap: .round))
        c.fill(Path(ellipseIn: CGRect(x: -14, y: -66, width: 28, height: 36)), with: ink)  // shaggy body
        var fringe = Path()
        for i in stride(from: -12.0, through: 10, by: 4) {
            fringe.move(to: CGPoint(x: i, y: -36)); fringe.addLine(to: CGPoint(x: i + 2, y: -28)); fringe.addLine(to: CGPoint(x: i + 4, y: -36))
        }
        c.fill(fringe, with: ink)
        c.fill(Path(ellipseIn: CGRect(x: 1, y: -74, width: 16, height: 16)), with: ink)  // head
        var horns = Path()
        horns.move(to: CGPoint(x: 6, y: -72)); horns.addQuadCurve(to: CGPoint(x: 2, y: -94), control: CGPoint(x: -4, y: -86))
        horns.move(to: CGPoint(x: 12, y: -72)); horns.addQuadCurve(to: CGPoint(x: 16, y: -94), control: CGPoint(x: 22, y: -86))
        c.stroke(horns, with: ink, style: StrokeStyle(lineWidth: 3, lineCap: .round))
        var arm = Path(); arm.move(to: CGPoint(x: 10, y: -52)); arm.addLine(to: CGPoint(x: 22, y: -40 - sw * 0.3))
        c.stroke(arm, with: ink, style: StrokeStyle(lineWidth: 3, lineCap: .round))
        var sw2 = Path()
        for i in 0..<5 { sw2.move(to: CGPoint(x: 22, y: -40)); sw2.addLine(to: CGPoint(x: 30 + Double(i) * 2, y: -60 + Double(i) * 3)) }
        c.stroke(sw2, with: ink, lineWidth: 1.2)  // birch switch
        var chain = Path(); chain.move(to: CGPoint(x: -10, y: -44)); chain.addQuadCurve(to: CGPoint(x: -26, y: -6), control: CGPoint(x: -20, y: -24 + sw * 0.5))
        c.stroke(chain, with: ink, style: StrokeStyle(lineWidth: 1.5, dash: [2, 2]))
        redEyes(&c, 11, -67, 1.3)
    }

    private func turkey(_ ctx: inout GraphicsContext, _ x: Double, _ g: Double, _ s: Double, _ ph: Double) {
        var c = ctx
        c.translateBy(x: x, y: g); c.scaleBy(x: s, y: s)
        let sw = sin(ph) * 5, bob = abs(sin(ph)) * 2, ink = GraphicsContext.Shading.color(Self.sil)
        for i in -3...3 {  // tail fan
            var f = c
            f.translateBy(x: -8, y: -30 - bob); f.rotate(by: .radians(Double(i) * 0.32 - 0.5))
            f.fill(Path(ellipseIn: CGRect(x: -5, y: -34, width: 10, height: 32)), with: ink)
        }
        c.fill(Path(ellipseIn: CGRect(x: -14, y: -36 - bob, width: 28, height: 24)), with: ink)  // body
        var neck = Path(); neck.move(to: CGPoint(x: 8, y: -32 - bob)); neck.addQuadCurve(to: CGPoint(x: 12, y: -50 - bob), control: CGPoint(x: 14, y: -44))
        c.stroke(neck, with: ink, lineWidth: 4)
        c.fill(Path(ellipseIn: CGRect(x: 7, y: -57 - bob, width: 10, height: 10)), with: ink)  // head
        var beak = Path(); beak.move(to: CGPoint(x: 16, y: -52 - bob)); beak.addLine(to: CGPoint(x: 22, y: -50 - bob)); beak.addLine(to: CGPoint(x: 16, y: -49 - bob))
        c.fill(beak, with: ink)
        var legs = Path(); legs.move(to: CGPoint(x: -3, y: -13)); legs.addLine(to: CGPoint(x: -4 + sw, y: 0)); legs.move(to: CGPoint(x: 4, y: -13)); legs.addLine(to: CGPoint(x: 5 - sw, y: 0))
        c.stroke(legs, with: ink, lineWidth: 2)
        let lift = sin(ph * 0.5) * 3
        var handle = Path(); handle.move(to: CGPoint(x: 12, y: -26 - bob)); handle.addLine(to: CGPoint(x: 26, y: -60 - bob - lift))
        c.stroke(handle, with: .color(Color(red: 0.27, green: 0.16, blue: 0.08).opacity(0.9)), style: StrokeStyle(lineWidth: 2.4, lineCap: .round))
        var blade = Path(); blade.move(to: CGPoint(x: 24, y: -56 - bob - lift))
        blade.addQuadCurve(to: CGPoint(x: 38, y: -74 - bob - lift), control: CGPoint(x: 40, y: -58)); blade.addLine(to: CGPoint(x: 27, y: -66 - bob - lift))
        c.fill(blade, with: .color(Color(white: 0.76).opacity(0.95)))
        c.fill(Path(ellipseIn: CGRect(x: 35.6, y: -63.4 - bob - lift, width: 2.8, height: 2.8)), with: .color(Color(red: 0.6, green: 0.04, blue: 0.04).opacity(0.8)))
        redEyes(&c, 13, -53 - bob, 1.1)
    }

    private func bats(_ ctx: inout GraphicsContext, _ x: Double, _ y0: Double, _ s: Double, _ ph: Double) {
        for i in 0..<6 {
            let d = Double(i), bx = x - d * 26 * s, by = y0 + sin(ph * 0.6 + d) * 18 + d * 9, f = sin(ph * 3 + d) * 5 * s
            var p = Path()
            p.move(to: CGPoint(x: bx, y: by))
            p.addQuadCurve(to: CGPoint(x: bx - 16 * s, y: by - f), control: CGPoint(x: bx - 8 * s, y: by - 6 * s - f))
            p.addQuadCurve(to: CGPoint(x: bx, y: by + 3 * s), control: CGPoint(x: bx - 8 * s, y: by - s))
            p.addQuadCurve(to: CGPoint(x: bx + 16 * s, y: by - f), control: CGPoint(x: bx + 8 * s, y: by - s))
            p.addQuadCurve(to: CGPoint(x: bx, y: by), control: CGPoint(x: bx + 8 * s, y: by - 6 * s - f))
            ctx.fill(p, with: .color(Self.sil))
        }
    }
}
