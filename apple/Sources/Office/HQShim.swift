extension HQEngine {
    /// The browser bits web/office.js expects, for JavaScriptCore: document.createElement("canvas"), Image, ImageData,
    /// timers, plus stand-ins for the website's globals (esc, BRAND, ME…). Canvas calls are recorded as numbers into a
    /// Float64Array that Swift replays (HQEngine.flush); the opcodes here and there must match.
    static let shim = #"""
    var window = globalThis, self = globalThis;
    var location = {search: "", href: "", hostname: ""};
    var devicePixelRatio = 1;
    var __now = 0;
    var performance = {now: () => __now};
    var ME = {}, BRAND = "Nuni", OF_TV = true;
    var APP = () => BRAND + "Flix";
    var esc = s => String(s == null ? "" : s);
    var $ = () => null, $$ = () => [];
    var CSS = {escape: s => s};
    var structuredClone = o => JSON.parse(JSON.stringify(o));
    class URLSearchParams { constructor() {} get() { return null; } has() { return false; } }
    var __timers = [], __tid = 0;
    function setTimeout(fn, ms) { const id = ++__tid; __timers.push({id, at: __now + (ms || 0), fn}); return id; }
    function clearTimeout(id) { __timers = __timers.filter(t => t.id !== id); }
    var setInterval = () => 0, clearInterval = () => {}, requestAnimationFrame = () => 0, cancelAnimationFrame = () => {};
    function __runTimers() {
      if (!__timers.length) return;
      const due = __timers.filter(t => t.at <= __now);
      __timers = __timers.filter(t => t.at > __now);
      for (const t of due) { try { t.fn(); } catch (e) { __native.log("timer: " + e); } }
    }
    var console = {log: (...a) => __native.log(a.join(" ")), warn: (...a) => __native.log(a.join(" ")), error: (...a) => __native.log(a.join(" "))};

    // ---- the command buffer
    var __F = new Float64Array(1 << 18), __n = 0, __S = new Map(), __Snew = [];
    function __s(str) {
      str = String(str); let id = __S.get(str);
      if (id === undefined && __S.size >= 40000) { __flushNow(); __S.clear(); __native.reset(); }  // colours made on the fly add up over hours
      if (id === undefined) { id = __S.size; __S.set(str, id); __Snew.push(str); }
      return id;
    }
    function __need(k) { if (__n + k > __F.length) __flushNow(); }
    function __flushNow() { if (__n || __Snew.length) { __native.flush(__F, __n, __Snew); __n = 0; __Snew = []; } }

    var __ids = 0, __gids = 0, __imgs = new Map();
    class ImageData { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } }
    class Image {
      constructor() { this._id = ++__ids; this.width = 0; this.height = 0; this.naturalWidth = 0; this.naturalHeight = 0; this.complete = false; this.onload = null; this.onerror = null; this._src = ""; }
      get src() { return this._src; }
      set src(u) { this._src = String(u); this.complete = false; __imgs.set(this._id, this); __native.load(this._id, this._src); }
      decode() { return Promise.resolve(); }
    }
    function __loaded(id, w, h) {
      const im = __imgs.get(id); if (!im) return;
      __imgs.delete(id);
      im.complete = true; im.width = im.naturalWidth = w; im.height = im.naturalHeight = h;
      try { if (w > 0) { if (im.onload) im.onload(); } else if (im.onerror) im.onerror(); } catch (e) { __native.log("onload: " + e + " " + e.stack); }
    }
    class __Canvas {
      constructor() { this._id = ++__ids; this._w = 300; this._h = 150; this._ctx = null; this.style = {}; this.dataset = {}; }
      get width() { return this._w; }
      set width(v) { this._w = v | 0; this._resize(); }
      get height() { return this._h; }
      set height(v) { this._h = v | 0; this._resize(); }
      _resize() { __need(4); __F[__n++] = 23; __F[__n++] = this._id; __F[__n++] = this._w; __F[__n++] = this._h; if (this._ctx) this._ctx._reset(); }
      get clientWidth() { return this._w; }
      getContext() { return this._ctx || (this._ctx = new __Ctx(this)); }
      getBoundingClientRect() { return {left: 0, top: 0, width: this._w, height: this._h}; }
    }
    var HTMLImageElement = Image, HTMLCanvasElement = __Canvas;
    var __el = () => ({style: {}, dataset: {}, classList: {add() {}, remove() {}, toggle() {}, contains() { return false; }}, append() {}, appendChild() {},
                       setAttribute() {}, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, children: []});
    var document = {hidden: false, body: __el(), documentElement: __el(), createElement: t => t === "canvas" ? new __Canvas() : __el(),
                    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}};
    class __Grad {
      constructor() { this._gid = ++__gids; }
      addColorStop(o, c) { __need(4); __F[__n++] = 26; __F[__n++] = this._gid; __F[__n++] = o; __F[__n++] = __s(c); }
    }
    class __Ctx {
      constructor(cv) { this.canvas = cv; this._reset(); }
      _reset() { this._st = {fs: "#000000", a: 1, op: "source-over", font: "10px sans-serif", tb: "alphabetic", sb: 0, sc: "rgba(0,0,0,0)", sm: true}; this._stack = []; }
      _1(op, v) { __need(3); __F[__n++] = op; __F[__n++] = this.canvas._id; __F[__n++] = v; }
      get fillStyle() { return this._st.fs; }
      set fillStyle(v) { this._st.fs = v; if (v instanceof __Grad) this._1(2, v._gid); else this._1(1, __s(v)); }
      get strokeStyle() { return "#000"; } set strokeStyle(v) {}
      get lineWidth() { return 1; } set lineWidth(v) {}
      get globalAlpha() { return this._st.a; }
      set globalAlpha(v) { v = +v; if (!(v >= 0 && v <= 1)) return; this._st.a = v; this._1(3, v); }
      get globalCompositeOperation() { return this._st.op; }
      set globalCompositeOperation(v) { this._st.op = v; this._1(4, __s(v)); }
      get font() { return this._st.font; }
      set font(v) { this._st.font = v; this._1(5, __s(v)); }
      get textBaseline() { return this._st.tb; }
      set textBaseline(v) { this._st.tb = v; this._1(6, __s(v)); }
      get imageSmoothingEnabled() { return this._st.sm; }
      set imageSmoothingEnabled(v) { this._st.sm = !!v; this._1(29, v ? 1 : 0); }
      get shadowBlur() { return this._st.sb; }
      set shadowBlur(v) { this._st.sb = +v || 0; this._shadow(); }
      get shadowColor() { return this._st.sc; }
      set shadowColor(v) { this._st.sc = v; this._shadow(); }
      _shadow() { __need(4); __F[__n++] = 27; __F[__n++] = this.canvas._id; __F[__n++] = this._st.sb; __F[__n++] = __s(this._st.sc); }
      save() { this._stack.push(Object.assign({}, this._st)); __need(2); __F[__n++] = 7; __F[__n++] = this.canvas._id; }
      restore() { if (this._stack.length) this._st = this._stack.pop(); __need(2); __F[__n++] = 8; __F[__n++] = this.canvas._id; }
      _6(op, a, b, c, d, e, f) { __need(8); __F[__n++] = op; __F[__n++] = this.canvas._id; __F[__n++] = a; __F[__n++] = b; __F[__n++] = c; __F[__n++] = d; __F[__n++] = e; __F[__n++] = f; }
      _4(op, a, b, c, d) { __need(6); __F[__n++] = op; __F[__n++] = this.canvas._id; __F[__n++] = a; __F[__n++] = b; __F[__n++] = c; __F[__n++] = d; }
      _2(op, a, b) { __need(4); __F[__n++] = op; __F[__n++] = this.canvas._id; __F[__n++] = a; __F[__n++] = b; }
      _0(op) { __need(2); __F[__n++] = op; __F[__n++] = this.canvas._id; }
      setTransform(a, b, c, d, e, f) { if (typeof a === "object") ({a, b, c, d, e, f} = a); this._6(9, a, b, c, d, e, f); }
      resetTransform() { this._6(9, 1, 0, 0, 1, 0, 0); }
      transform(a, b, c, d, e, f) { this._6(10, a, b, c, d, e, f); }
      translate(x, y) { this._2(11, x, y); }
      scale(x, y) { this._2(12, x, y); }
      rotate(r) { this._1(30, r); }
      fillRect(x, y, w, h) { this._4(13, x, y, w, h); }
      clearRect(x, y, w, h) { this._4(14, x, y, w, h); }
      strokeRect() {}
      beginPath() { this._0(15); }
      moveTo(x, y) { this._2(16, x, y); }
      lineTo(x, y) { this._2(17, x, y); }
      closePath() { this._0(18); }
      rect(x, y, w, h) { this._4(31, x, y, w, h); }
      arc(x, y, r, a0, a1, ccw) { __need(8); __F[__n++] = 19; __F[__n++] = this.canvas._id; __F[__n++] = x; __F[__n++] = y; __F[__n++] = r; __F[__n++] = a0; __F[__n++] = a1; __F[__n++] = ccw ? 1 : 0; }
      ellipse(x, y, rx, ry, rot, a0, a1, ccw) { this.save(); this.translate(x, y); this.rotate(rot || 0); this.scale(rx, ry); this.arc(0, 0, 1, a0, a1, ccw); this.restore(); }
      fill() { this._0(20); }
      stroke() {} clip() {}
      fillText(t, x, y) { __need(5); __F[__n++] = 22; __F[__n++] = this.canvas._id; __F[__n++] = __s(t); __F[__n++] = x; __F[__n++] = y; }
      strokeText() {}
      measureText(t) { const m = /([\d.]+)px/.exec(this._st.font); return {width: String(t).length * (m ? +m[1] : 10) * 0.62}; }
      drawImage(src, a, b, c, d, e, f, g, h) {
        if (!src || !(src.width > 0)) return;
        const n = arguments.length; let sx = 0, sy = 0, sw = src.width, sh = src.height, dx, dy, dw, dh;
        if (n <= 3) { dx = a; dy = b; dw = sw; dh = sh; }
        else if (n <= 5) { dx = a; dy = b; dw = c; dh = d; }
        else { sx = a; sy = b; sw = c; sh = d; dx = e; dy = f; dw = g; dh = h; }
        __need(11); __F[__n++] = 21; __F[__n++] = this.canvas._id; __F[__n++] = src._id;
        __F[__n++] = sx; __F[__n++] = sy; __F[__n++] = sw; __F[__n++] = sh; __F[__n++] = dx; __F[__n++] = dy; __F[__n++] = dw; __F[__n++] = dh;
      }
      createLinearGradient(x0, y0, x1, y1) { const g = new __Grad(); __need(6); __F[__n++] = 24; __F[__n++] = g._gid; __F[__n++] = x0; __F[__n++] = y0; __F[__n++] = x1; __F[__n++] = y1; return g; }
      createRadialGradient(x0, y0, r0, x1, y1, r1) { const g = new __Grad(); __need(8); __F[__n++] = 25; __F[__n++] = g._gid; __F[__n++] = x0; __F[__n++] = y0; __F[__n++] = r0; __F[__n++] = x1; __F[__n++] = y1; __F[__n++] = r1; return g; }
      createPattern() { return "#000"; }
      getImageData(x, y, w, h) { __flushNow(); const d = new Uint8ClampedArray(w * h * 4); __native.get(this.canvas._id, x, y, w, h, d); return new ImageData(d, w, h); }
      putImageData(img, dx, dy) { __flushNow(); __native.put(this.canvas._id, img.data, img.width, img.height, dx, dy); }
    }

    // ---- what HQEngine calls
    function tvStart(brand) { BRAND = brand || "Nuni"; OF.seen = null; OF.demoData = null; OF.W = ofNewWorld(); ofSpritesLoad(); }
    function tvSync(json) { try { if (OF.W) ofSyncWorld(JSON.parse(json)); } catch (e) { __native.log("sync: " + e + " " + e.stack); } }
    function tvFrame(dt) {
      __now += dt * 1000; __runTimers();
      if (!OF.W) return 0;
      try { ofAdvance(dt); const o = ofDrawWorld(); __flushNow(); return o._id; }
      catch (e) { __native.log("frame: " + e + " " + e.stack); __n = 0; return 0; }
    }
    function tvLabels() { try { return OF.W ? ofLabelsData() : "{}"; } catch (e) { return "{}"; } }
    """#
}
