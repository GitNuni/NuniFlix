import CoreGraphics
import CoreText
import Foundation
import JavaScriptCore
import UIKit

/// NuniFlix HQ on the Apple TV: the website's own Office code (web/office.js, fetched from the server) running in
/// JavaScriptCore, drawing through a small canvas bridge into Core Graphics. So the building on the TV is the same
/// building as on the website (people, cats, the truck, the cars, the roof), and it changes when the server does,
/// without an app update.
///
/// The JS side (HQShim.js below) records canvas calls into a Float64Array; Swift reads it in one go and replays it
/// on bitmap contexts, one per canvas. Everything here runs on one serial queue; finished frames go to the main
/// thread as CGImages.
final class HQEngine {
    struct Labels: Decodable {
        struct Sign: Decodable { var x, y, w, h: Double }
        struct Floor: Decodable, Identifiable { var k: String; var fi: Int; var x, y: Double; var text: String; var id: String { k } }
        struct Tag: Decodable, Identifiable { var id: String; var text: String; var me: Bool; var hue: Double?; var x, y: Double; var alpha: Double }
        var W, H, roof, band: Double
        var brand: String?
        var sign: Sign
        var floors: [Floor]
        var tags: [Tag]
    }

    var onFrame: ((CGImage) -> Void)?
    var onLabels: ((Labels) -> Void)?
    var onFail: ((String) -> Void)?

    private let queue = DispatchQueue(label: "nuniflix.hq", qos: .userInitiated)
    private var js: JSContext!
    private var frameFn: JSValue?, labelsFn: JSValue?, syncFn: JSValue?
    private var timer: DispatchSourceTimer?
    private var last = CACurrentMediaTime(), frames = 0
    private var base: URL?
    private var pending: String?

    // the canvas bridge's state
    private var surfaces: [Int: HQSurface] = [:]
    private var strings: [String] = []
    private var colors: [Int: CGColor] = [:]
    private var grads: [Int: HQGradient] = [:]

    deinit { timer?.cancel() }

    /// Loads office.js from the server and starts the building. Calls onFail if this server is too old to have it.
    func start(base: URL, brand: String) {
        self.base = base
        Task {
            guard let url = URL(string: "/office.js?tv=1", relativeTo: base),
                  let (data, resp) = try? await URLSession.shared.data(from: url), (resp as? HTTPURLResponse)?.statusCode == 200,
                  let code = String(data: data, encoding: .utf8), code.contains("function ofDrawWorld") else {
                await MainActor.run { self.onFail?("This server doesn't have the new HQ yet.") }
                return
            }
            queue.async { self.boot(code, brand: brand) }
        }
    }

    func stop() {
        queue.async { self.timer?.cancel(); self.timer = nil }
    }

    /// A fresh /api/office snapshot (the raw JSON), every few seconds.
    func sync(_ json: String) {
        queue.async {
            if let f = self.syncFn { _ = f.call(withArguments: [json]) } else { self.pending = json }  // not booted yet: apply it when it is
        }
    }

    // MARK: - JavaScript

    private func boot(_ code: String, brand: String) {
        guard let js = JSContext() else { return }
        self.js = js
        surfaces = [:]; strings = []; colors = [:]; grads = [:]   // a fresh building each time HQ opens (JS ids start again at 1)
        js.exceptionHandler = { _, e in NSLog("HQ js: %@ %@", e?.toString() ?? "?", e?.objectForKeyedSubscript("stack")?.toString() ?? "") }
        let native = JSValue(newObjectIn: js)!
        let flush: @convention(block) (JSValue, Int, JSValue) -> Void = { [unowned self] buf, n, news in self.flush(buf, n, news) }
        let load: @convention(block) (Int, String) -> Void = { [unowned self] id, src in self.loadImage(id, src) }
        let get: @convention(block) (Int, Double, Double, Int, Int, JSValue) -> Void = { [unowned self] id, x, y, w, h, out in self.getPixels(id, x, y, w, h, out) }
        let put: @convention(block) (Int, JSValue, Int, Int, Double, Double) -> Void = { [unowned self] id, data, w, h, dx, dy in self.putPixels(id, data, w, h, dx, dy) }
        let log: @convention(block) (String) -> Void = { NSLog("HQ: %@", $0) }
        let reset: @convention(block) () -> Void = { [unowned self] in self.strings = []; self.colors = [:] }
        native.setObject(reset, forKeyedSubscript: "reset" as NSString)
        native.setObject(flush, forKeyedSubscript: "flush" as NSString)
        native.setObject(load, forKeyedSubscript: "load" as NSString)
        native.setObject(get, forKeyedSubscript: "get" as NSString)
        native.setObject(put, forKeyedSubscript: "put" as NSString)
        native.setObject(log, forKeyedSubscript: "log" as NSString)
        js.setObject(native, forKeyedSubscript: "__native" as NSString)
        js.evaluateScript(HQEngine.shim)
        js.evaluateScript(code)
        js.objectForKeyedSubscript("tvStart").call(withArguments: [brand.replacingOccurrences(of: "Flix", with: "")])
        frameFn = js.objectForKeyedSubscript("tvFrame")
        labelsFn = js.objectForKeyedSubscript("tvLabels")
        syncFn = js.objectForKeyedSubscript("tvSync")
        if let p = pending { _ = syncFn?.call(withArguments: [p]); pending = nil }
        last = CACurrentMediaTime()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: 1.0 / 30)
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    private func tick() {
        let now = CACurrentMediaTime(), dt = min(0.1, now - last)
        last = now
        guard let id = frameFn?.call(withArguments: [dt])?.toInt32(), id > 0, let s = surfaces[Int(id)], let img = s.image() else { return }
        DispatchQueue.main.async { self.onFrame?(img) }
        frames += 1
        if frames % 5 == 0, let json = labelsFn?.call(withArguments: [])?.toString(), let data = json.data(using: .utf8),
           let labels = try? JSONDecoder().decode(Labels.self, from: data) {
            DispatchQueue.main.async { self.onLabels?(labels) }
        }
    }

    private func loadImage(_ id: Int, _ src: String) {
        guard let base, let url = URL(string: src, relativeTo: base) else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, resp, _ in
            guard let self else { return }
            let cg = (resp as? HTTPURLResponse)?.statusCode == 200 ? data.flatMap { UIImage(data: $0)?.cgImage } : nil
            self.queue.async {
                if let cg {
                    let s = HQSurface(cg.width, cg.height)
                    s.ctx.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
                    s.touched()
                    self.surfaces[id] = s
                }
                _ = self.js.objectForKeyedSubscript("__loaded").call(withArguments: [id, cg?.width ?? 0, cg?.height ?? 0])
            }
        }.resume()
    }

    private func surface(_ id: Int) -> HQSurface {
        if let s = surfaces[id] { return s }
        let s = HQSurface(300, 150)
        surfaces[id] = s
        return s
    }

    private func getPixels(_ id: Int, _ x: Double, _ y: Double, _ w: Int, _ h: Int, _ out: JSValue) {
        guard let dst = typedBytes(out) else { return }
        surface(id).read(Int(x), Int(y), w, h, into: dst)
    }

    private func putPixels(_ id: Int, _ data: JSValue, _ w: Int, _ h: Int, _ dx: Double, _ dy: Double) {
        guard let src = typedBytes(data) else { return }
        surface(id).write(src, w, h, Int(dx), Int(dy))
    }

    private func typedBytes(_ v: JSValue) -> UnsafeMutablePointer<UInt8>? {
        guard let ref = js?.jsGlobalContextRef else { return nil }
        let p = JSObjectGetTypedArrayBytesPtr(ref, v.jsValueRef, nil)
        return p?.assumingMemoryBound(to: UInt8.self)
    }

    // MARK: - replaying canvas calls

    private func color(_ sid: Int) -> CGColor {
        if let c = colors[sid] { return c }
        let c = HQColor.parse(sid < strings.count ? strings[sid] : "#000")
        colors[sid] = c
        return c
    }

    private func flush(_ buf: JSValue, _ n: Int, _ news: JSValue) {
        if let added = news.toArray() as? [String] { strings += added }
        guard n > 0, let ref = js?.jsGlobalContextRef, let raw = JSObjectGetTypedArrayBytesPtr(ref, buf.jsValueRef, nil) else { return }
        let f = raw.assumingMemoryBound(to: Double.self)
        var i = 0
        @inline(__always) func next() -> Double { defer { i += 1 }; return f[i] }
        @inline(__always) func int() -> Int { Int(next()) }
        while i < n {
            let op = int()
            switch op {
            case 24, 25, 26:  // gradients aren't tied to a canvas
                let gid = int()
                if op == 24 { grads[gid] = HQGradient(radial: false, p: [next(), next(), next(), next()]) }
                else if op == 25 { grads[gid] = HQGradient(radial: true, p: [next(), next(), next(), next(), next(), next()]) }
                else { let off = next(), c = color(int()); grads[gid]?.add(off, c) }
                continue
            default: break
            }
            let s = surface(int())
            switch op {
            case 1: s.st.fill = .color(color(int()))
            case 2: let g = int(); s.st.fill = grads[g].map { .gradient($0) } ?? .color(UIColor.black.cgColor)
            case 3: s.st.alpha = next()
            case 4: s.st.blend = HQColor.blend(strings[int()])
            case 5: s.st.font = strings[int()]
            case 6: s.st.baseline = strings[int()]
            case 7: s.save()
            case 8: s.restore()
            case 9: s.st.m = CGAffineTransform(a: next(), b: next(), c: next(), d: next(), tx: next(), ty: next())
            case 10: s.st.m = CGAffineTransform(a: next(), b: next(), c: next(), d: next(), tx: next(), ty: next()).concatenating(s.st.m)
            case 11: s.st.m = CGAffineTransform(translationX: next(), y: next()).concatenating(s.st.m)
            case 12: s.st.m = CGAffineTransform(scaleX: next(), y: next()).concatenating(s.st.m)
            case 30: s.st.m = CGAffineTransform(rotationAngle: next()).concatenating(s.st.m)
            case 13: s.fillRect(CGRect(x: next(), y: next(), width: next(), height: next()))
            case 14: s.clearRect(CGRect(x: next(), y: next(), width: next(), height: next()))
            case 15: s.path = CGMutablePath()
            case 16: s.path.move(to: CGPoint(x: next(), y: next()), transform: s.st.m)
            case 17: let p = CGPoint(x: next(), y: next()); if s.path.isEmpty { s.path.move(to: p, transform: s.st.m) } else { s.path.addLine(to: p, transform: s.st.m) }
            case 18: s.path.closeSubpath()
            case 19:
                let x = next(), y = next(), r = next(), a0 = next(), a1 = next(), ccw = next() != 0
                s.path.addArc(center: CGPoint(x: x, y: y), radius: r, startAngle: a0, endAngle: a1, clockwise: ccw, transform: s.st.m)
            case 31: s.path.addRect(CGRect(x: next(), y: next(), width: next(), height: next()), transform: s.st.m)
            case 20: s.fillPath()
            case 21:
                let src = int(), r = CGRect(x: next(), y: next(), width: next(), height: next()), d = CGRect(x: next(), y: next(), width: next(), height: next())
                if src != s.id, let img = surfaces[src]?.image() { s.drawImage(img, r, d) }
            case 22: let t = strings[int()]; s.fillText(t, next(), next())
            case 23: s.resize(int(), int())
            case 27: s.st.shadowBlur = next(); s.st.shadowColor = color(int())
            case 29: s.st.smooth = next() != 0
            default:
                NSLog("HQ: unknown canvas op %d", op)
                return
            }
            s.touched()
        }
    }
}

/// One canvas: a bitmap context plus the 2D state the canvas API keeps.
final class HQSurface {
    enum Fill { case color(CGColor), gradient(HQGradient) }
    struct State {
        var m = CGAffineTransform.identity
        var fill = Fill.color(UIColor.black.cgColor)
        var alpha = 1.0
        var blend = CGBlendMode.normal
        var font = "10px sans-serif"
        var baseline = "alphabetic"
        var shadowBlur = 0.0
        var shadowColor: CGColor?
        var smooth = true
    }
    private static var ids = 0
    let id: Int
    private(set) var w: Int, h: Int
    private(set) var ctx: CGContext
    var st = State()
    private var stack: [State] = []
    var path = CGMutablePath()
    private var cached: CGImage?

    init(_ w: Int, _ h: Int) {
        HQSurface.ids += 1
        id = -HQSurface.ids  // (never a JS id: drawImage onto itself is skipped by id)
        self.w = max(1, w); self.h = max(1, h)
        ctx = HQSurface.context(self.w, self.h)
    }

    private static func context(_ w: Int, _ h: Int) -> CGContext {
        CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    }

    /// Canvas space (top-left origin, y down) -> the bitmap's (bottom-left origin).
    private var flip: CGAffineTransform { CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: CGFloat(h)) }

    func touched() { cached = nil }
    func image() -> CGImage? {
        if cached == nil { cached = ctx.makeImage() }
        return cached
    }

    func resize(_ nw: Int, _ nh: Int) {
        w = max(1, nw); h = max(1, nh)
        ctx = HQSurface.context(w, h)
        st = State(); stack = []; path = CGMutablePath()
    }
    func save() { stack.append(st) }
    func restore() { if let s = stack.popLast() { st = s } }

    private func begin(_ transformed: Bool) {
        ctx.saveGState()
        ctx.setAlpha(st.alpha)
        ctx.setBlendMode(st.blend)
        ctx.interpolationQuality = st.smooth ? .default : .none
        if st.shadowBlur > 0, let c = st.shadowColor { ctx.setShadow(offset: .zero, blur: st.shadowBlur * abs(st.m.a), color: c) }
        ctx.concatenate(transformed ? st.m.concatenating(flip) : flip)
    }

    private func paintGradient(_ g: HQGradient) {
        guard let grad = g.gradient() else { return }
        let opts: CGGradientDrawingOptions = [.drawsBeforeStartLocation, .drawsAfterEndLocation]
        if g.radial {
            ctx.drawRadialGradient(grad, startCenter: CGPoint(x: g.p[0], y: g.p[1]), startRadius: g.p[2],
                                   endCenter: CGPoint(x: g.p[3], y: g.p[4]), endRadius: g.p[5], options: opts)
        } else {
            ctx.drawLinearGradient(grad, start: CGPoint(x: g.p[0], y: g.p[1]), end: CGPoint(x: g.p[2], y: g.p[3]), options: opts)
        }
    }

    func fillRect(_ r: CGRect) {
        begin(true)
        switch st.fill {
        case .color(let c): ctx.setFillColor(c); ctx.fill(r)
        case .gradient(let g): ctx.clip(to: r); paintGradient(g)
        }
        ctx.restoreGState()
    }

    func clearRect(_ r: CGRect) {
        ctx.saveGState()
        ctx.concatenate(st.m.concatenating(flip))
        ctx.clear(r)
        ctx.restoreGState()
    }

    func fillPath() {
        guard !path.isEmpty else { return }
        begin(false)
        ctx.addPath(path)
        switch st.fill {
        case .color(let c): ctx.setFillColor(c); ctx.fillPath()
        case .gradient(let g): ctx.clip(); ctx.concatenate(st.m); paintGradient(g)
        }
        ctx.restoreGState()
    }

    func drawImage(_ img: CGImage, _ src: CGRect, _ dst: CGRect) {
        guard dst.width != 0, dst.height != 0, src.width > 0, src.height > 0 else { return }
        var pic = img
        let whole = CGRect(x: 0, y: 0, width: img.width, height: img.height)
        let s = src.integral.intersection(whole)
        if s.isEmpty { return }
        if s != whole, let c = img.cropping(to: s) { pic = c }
        begin(true)
        ctx.translateBy(x: dst.minX, y: dst.minY + dst.height)
        ctx.scaleBy(x: 1, y: -1)
        ctx.draw(pic, in: CGRect(x: 0, y: 0, width: dst.width, height: dst.height))
        ctx.restoreGState()
    }

    func fillText(_ text: String, _ x: Double, _ y: Double) {
        let font = HQColor.font(st.font)
        let color: CGColor
        if case .color(let c) = st.fill { color = c } else { color = UIColor.white.cgColor }
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): color]))
        var yy = y
        let asc = CTFontGetAscent(font), desc = CTFontGetDescent(font)
        switch st.baseline {
        case "top", "hanging": yy += asc
        case "middle": yy += (asc - desc) / 2
        case "bottom", "ideographic": yy -= desc
        default: break
        }
        begin(true)
        ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
        ctx.textPosition = CGPoint(x: x, y: yy)
        CTLineDraw(line, ctx)
        ctx.restoreGState()
    }

    /// getImageData: straight (un-premultiplied) RGBA.
    func read(_ x: Int, _ y: Int, _ rw: Int, _ rh: Int, into dst: UnsafeMutablePointer<UInt8>) {
        guard let data = ctx.data?.assumingMemoryBound(to: UInt8.self) else { return }
        let bpr = ctx.bytesPerRow
        for row in 0..<rh {
            let sy = y + row
            for col in 0..<rw {
                let sx = x + col, o = (row * rw + col) * 4
                guard sx >= 0, sy >= 0, sx < w, sy < h else { dst[o] = 0; dst[o + 1] = 0; dst[o + 2] = 0; dst[o + 3] = 0; continue }
                let p = sy * bpr + sx * 4, a = data[p + 3]
                if a == 0 { dst[o] = 0; dst[o + 1] = 0; dst[o + 2] = 0; dst[o + 3] = 0; continue }
                if a == 255 { dst[o] = data[p]; dst[o + 1] = data[p + 1]; dst[o + 2] = data[p + 2] } else {
                    dst[o] = UInt8(min(255, Int(data[p]) * 255 / Int(a)))
                    dst[o + 1] = UInt8(min(255, Int(data[p + 1]) * 255 / Int(a)))
                    dst[o + 2] = UInt8(min(255, Int(data[p + 2]) * 255 / Int(a)))
                }
                dst[o + 3] = a
            }
        }
    }

    /// putImageData: replaces pixels as they are (no transform, alpha or blending), premultiplying on the way in.
    func write(_ src: UnsafeMutablePointer<UInt8>, _ rw: Int, _ rh: Int, _ dx: Int, _ dy: Int) {
        guard let data = ctx.data?.assumingMemoryBound(to: UInt8.self) else { return }
        let bpr = ctx.bytesPerRow
        for row in 0..<rh {
            let ty = dy + row
            guard ty >= 0, ty < h else { continue }
            for col in 0..<rw {
                let tx = dx + col
                guard tx >= 0, tx < w else { continue }
                let o = (row * rw + col) * 4, p = ty * bpr + tx * 4, a = Int(src[o + 3])
                data[p] = UInt8(Int(src[o]) * a / 255); data[p + 1] = UInt8(Int(src[o + 1]) * a / 255); data[p + 2] = UInt8(Int(src[o + 2]) * a / 255)
                data[p + 3] = UInt8(a)
            }
        }
        touched()
    }
}

final class HQGradient {
    let radial: Bool
    let p: [Double]
    private var stops: [(Double, CGColor)] = []
    private var built: CGGradient?
    init(radial: Bool, p: [Double]) { self.radial = radial; self.p = p }
    func add(_ off: Double, _ c: CGColor) { stops.append((min(1, max(0, off)), c)); built = nil }
    func gradient() -> CGGradient? {
        if built == nil, !stops.isEmpty {
            let s = stops.sorted { $0.0 < $1.0 }
            built = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: s.map(\.1) as CFArray, locations: s.map { CGFloat($0.0) })
        }
        return built
    }
}

/// CSS colours, blend modes and fonts, as the Office code writes them.
enum HQColor {
    static func parse(_ raw: String) -> CGColor {
        let s = raw.trimmingCharacters(in: .whitespaces).lowercased()
        func rgba(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> CGColor {
            CGColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
        }
        if s.hasPrefix("#") {
            let hex = String(s.dropFirst())
            var v: UInt64 = 0
            Scanner(string: hex).scanHexInt64(&v)
            switch hex.count {
            case 3: return rgba(Double((v >> 8) & 0xF) * 17, Double((v >> 4) & 0xF) * 17, Double(v & 0xF) * 17)
            case 4: return rgba(Double((v >> 12) & 0xF) * 17, Double((v >> 8) & 0xF) * 17, Double((v >> 4) & 0xF) * 17, Double(v & 0xF) / 15)
            case 6: return rgba(Double((v >> 16) & 0xFF), Double((v >> 8) & 0xFF), Double(v & 0xFF))
            case 8: return rgba(Double((v >> 24) & 0xFF), Double((v >> 16) & 0xFF), Double((v >> 8) & 0xFF), Double(v & 0xFF) / 255)
            default: return rgba(0, 0, 0)
            }
        }
        if let open = s.firstIndex(of: "("), s.hasSuffix(")") {
            let fn = s[..<open], body = s[s.index(after: open)..<s.index(before: s.endIndex)]
            let parts = body.replacingOccurrences(of: "/", with: " ").replacingOccurrences(of: ",", with: " ").split(separator: " ").map(String.init)
            func num(_ i: Int, _ scale: Double = 1) -> Double? {
                guard i < parts.count else { return nil }
                let p = parts[i]
                if p.hasSuffix("%") { return (Double(p.dropLast()) ?? 0) / 100 * scale }
                return Double(p.replacingOccurrences(of: "deg", with: ""))
            }
            if fn.hasPrefix("rgb") {
                return rgba(num(0, 255) ?? 0, num(1, 255) ?? 0, num(2, 255) ?? 0, num(3, 1) ?? 1)
            }
            if fn.hasPrefix("hsl") {
                let h = (num(0) ?? 0).truncatingRemainder(dividingBy: 360), sat = num(1, 1) ?? 0, l = num(2, 1) ?? 0, a = num(3, 1) ?? 1
                let q = sat * min(l, 1 - l)
                func k(_ n: Double) -> Double { (n + h / 30).truncatingRemainder(dividingBy: 12) }
                func f(_ n: Double) -> Double { l - q * max(-1, min(k(n) - 3, 9 - k(n), 1)) }
                return CGColor(srgbRed: f(0), green: f(8), blue: f(4), alpha: a)
            }
        }
        switch s {
        case "white": return rgba(255, 255, 255)
        case "transparent": return rgba(0, 0, 0, 0)
        case "red": return rgba(255, 0, 0)
        case "yellow": return rgba(255, 255, 0)
        default: return rgba(0, 0, 0)
        }
    }

    static func blend(_ op: String) -> CGBlendMode {
        switch op {
        case "lighter": return .plusLighter
        case "destination-in": return .destinationIn
        case "destination-out": return .destinationOut
        case "destination-over": return .destinationOver
        case "source-atop": return .sourceAtop
        case "source-in": return .sourceIn
        case "multiply": return .multiply
        case "screen": return .screen
        case "overlay": return .overlay
        case "copy": return .copy
        default: return .normal
        }
    }

    private static var fonts: [String: CTFont] = [:]
    /// "bold 70px Silkscreen, monospace" -> a CTFont (Silkscreen is bundled; anything else is the system monospace).
    static func font(_ css: String) -> CTFont {
        if let f = fonts[css] { return f }
        let bold = css.contains("bold") || css.contains("700") || css.contains("800") || css.contains("900")
        var size = 10.0
        if let r = css.range(of: #"([\d.]+)px"#, options: .regularExpression) { size = Double(css[r].dropLast(2)) ?? 10 }
        let name: String
        if css.contains("Silkscreen") { name = bold ? "Silkscreen-Bold" : "Silkscreen-Regular" }
        else if css.contains("Press Start") { name = "PressStart2P-Regular" }
        else { name = bold ? "Menlo-Bold" : "Menlo-Regular" }
        let f = CTFontCreateWithName(name as CFString, size, nil)
        fonts[css] = f
        return f
    }
}
