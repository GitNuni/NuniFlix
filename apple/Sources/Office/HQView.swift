import SwiftUI
import UIKit

/// Holds the HQ engine and the view its frames go into. Frames go straight onto a layer (no SwiftUI redraw per frame);
/// only the labels (sign, floor names, name tags) go through SwiftUI, a few times a second.
@MainActor
final class HQModel: ObservableObject {
    let engine = HQEngine()
    let canvas = HQCanvasUIView()
    @Published var labels: HQEngine.Labels?
    @Published var failed = false
    @Published var ready = false
    private var started = false

    func start(brand: String) {
        guard !started, let base = API.shared.base else { failed = API.shared.base == nil; return }
        started = true
        engine.onFrame = { [weak self] img in
            guard let self else { return }
            self.canvas.layer.contents = img
            if !self.ready { self.ready = true }
        }
        engine.onLabels = { [weak self] l in self?.labels = l }
        engine.onFail = { [weak self] _ in self?.failed = true }
        engine.start(base: base, brand: brand)
    }

    func stop() { engine.stop(); started = false }
}

final class HQCanvasUIView: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        layer.magnificationFilter = .nearest   // hard pixel edges, like the website's canvas
        layer.contentsGravity = .resize
        isUserInteractionEnabled = false
    }
    required init?(coder: NSCoder) { fatalError() }
}

struct HQCanvas: UIViewRepresentable {
    let view: HQCanvasUIView
    func makeUIView(context: Context) -> HQCanvasUIView { view }
    func updateUIView(_ uiView: HQCanvasUIView, context: Context) {}
}

/// The building, drawn by the website's Office code, at `width` points wide. Each floor is a focusable band, so the
/// remote moves down the building and the scroll view follows.
struct HQBuilding: View {
    @ObservedObject var hq: HQModel
    var width: CGFloat
    var onFloor: (String) -> Void = { _ in }
    @FocusState private var focused: String?

    var body: some View {
        let l = hq.labels
        let s = width / CGFloat(l?.W ?? 240), height = CGFloat(l?.H ?? 624) * s
        ZStack(alignment: .topLeading) {
            HQCanvas(view: hq.canvas).frame(width: width, height: height)
            if let l { labels(l, s) }
            // the floors as focus targets (roof first, the street last)
            VStack(spacing: 0) {
                ForEach(bands(l, s), id: \.0) { key, h in
                    Button { onFloor(key) } label: { Color.clear.frame(width: width, height: h) }
                        .buttonStyle(FloorStyle())
                        .focused($focused, equals: key)
                }
            }
        }
        .frame(width: width, height: height)
        .opacity(hq.ready ? 1 : 0)
        .overlay { if !hq.ready { ProgressView() } }
    }

    private func bands(_ l: HQEngine.Labels?, _ s: CGFloat) -> [(String, CGFloat)] {
        guard let l else { return [] }
        var out: [(String, CGFloat)] = []
        for f in l.floors {
            let top = f.fi == 0 ? 0 : (l.roof + Double(f.fi) * l.band) * s
            let bottom = (l.roof + Double(f.fi + 1) * l.band) * s
            out.append((f.k, bottom - top))
        }
        out.append(("street", l.H * s - (l.roof + Double(l.floors.count) * l.band) * s))
        return out
    }

    @ViewBuilder private func labels(_ l: HQEngine.Labels, _ s: CGFloat) -> some View {
        let skew = CGAffineTransform(a: 1, b: 0.5, c: 0, d: 1, tx: 0, ty: 0)  // skewY(26.565deg): along the building's right-hand face
        let brand = (l.brand ?? "Nuni")
        // the rooftop sign
        HStack(spacing: 0) {
            Text(brand).foregroundStyle(.white).shadow(color: Color(hex: 0x9FB4FF), radius: 6)
            HQFlicker { on in Text("Flix").foregroundStyle(Color(hex: 0xFF5468)).opacity(on ? 1 : 0.35).shadow(color: Color(hex: 0xFF2240), radius: on ? 10 : 2) }
        }
        .font(.custom("Silkscreen-Bold", size: 10 * s))
        .lineLimit(1).minimumScaleFactor(0.4)
        .frame(width: l.sign.w * s, height: l.sign.h * s)
        .transformEffect(skew)
        .offset(x: l.sign.x * s, y: l.sign.y * s)
        ForEach(l.floors.filter { $0.k != "roof" }) { f in
            Text(f.text.uppercased())
                .font(.custom("Silkscreen-Regular", size: 4.2 * s))
                .foregroundStyle(.white.opacity(0.78))
                .fixedSize()
                .transformEffect(skew)
                .offset(x: f.x * s, y: f.y * s)
        }
        ForEach(l.tags) { t in
            Text(t.text)
                .font(.custom("Silkscreen-Regular", size: 3.6 * s))
                .foregroundStyle(t.me ? Color(hex: 0xFFD34D) : .white)
                .padding(.horizontal, 1.2 * s).padding(.vertical, 0.8 * s)
                .background(Color(red: 0.04, green: 0.03, blue: 0.07).opacity(0.85))
                .overlay(alignment: .bottom) { Rectangle().fill(Color(hue: (t.hue ?? 0) / 360, saturation: 0.62, brightness: 0.8)).frame(height: 0.5 * s) }
                .fixedSize()
                .opacity(t.alpha)
                .position(x: t.x * s, y: t.y * s - 3 * s)
        }
    }
}

/// The neon "Flix" on the sign: on, with the odd flicker.
private struct HQFlicker<C: View>: View {
    @ViewBuilder var content: (Bool) -> C
    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.15)) { tl in
            let t = Int(tl.date.timeIntervalSince1970 / 0.15)
            content(!(t % 47 == 0 || t % 47 == 2 || t % 113 == 5))
        }
    }
}

/// A floor band: invisible until focused, then a soft outline so you can see where you are.
private struct FloorStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { FloorBody(configuration: configuration) }
    struct FloorBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isFocused) private var focused
        var body: some View {
            configuration.label
                .overlay(Rectangle().stroke(Color.white.opacity(focused ? 0.55 : 0), lineWidth: 4))
                .background(Color.white.opacity(focused ? 0.04 : 0))
                .animation(.easeOut(duration: 0.2), value: focused)
        }
    }
}
