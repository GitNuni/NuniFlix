/* NuniFlix HQ (the Office). Shared by the website (index.html loads it before its main script) and the Apple TV app,
   which runs it in JavaScriptCore with a small canvas bridge (apple/Sources/Office/). Top level: declarations only. */
/* ---------- the Office: a pixel-art isometric building. Every person and box in it is something really happening ----------
   Drawn on a small canvas (208 px wide) and blown up with hard pixels. People walk between rooms and ride the elevator:
   a viewer walks in from the street and up to their couch; a request comes in by mail, goes up to the search desk,
   comes down to the loading dock as a box, rides the belt while it downloads, and ends up on the Delivered shelf. */
const OF = {timer: null, demo: false, seen: null, raf: 0, W: null, demoData: null, demoN: 0, demoBench: null};
const SKIN = ["#f1c7a0", "#d9a066", "#a86b3c", "#7a4a2a", "#f5d6b8", "#c68b59"];
const HAIR = ["#2b1d14", "#5a3a22", "#0f0b0a", "#c9a15a", "#7a2e1c", "#3b3b3b"];
const ofHue = h => `hsl(${h} 62% 56%)`;
const ofAgo = t => { const s = Math.max(0, Date.now() / 1000 - t); return s < 60 ? "just now" : s < 3600 ? `${s / 60 | 0}m ago` : s < 86400 ? `${s / 3600 | 0}h ago` : `${s / 86400 | 0}d ago`; };
const ofLeft = s => s == null ? "" : s < 60 ? "under a minute left" : s < 3600 ? `about ${Math.round(s / 60)}m left` : `about ${(s / 3600).toFixed(s < 36000 ? 1 : 0)}h left`;
const ofWho = p => `<span class="of-who${p.me ? " of-me" : ""}"><i style="background:${ofHue(p.hue)}"></i>${esc(p.who)}</span>`;
function ofEvent(e) {
  const who = e.who ? `<b style="color:${ofHue(e.hue)}">${esc(e.who)}</b>` : "", t = e.title ? `<b>${esc(e.title)}</b>` : "";
  switch (e.kind) {
    case "watch": return ["🛋️", t ? `${who} started watching ${t}` : `${who} started watching something`];
    case "stop": return ["🚪", t ? `${who} stopped watching ${t}` : `${who} left their screening room`];
    case "dl": return ["📦", `${t}${e.sub ? ` (${esc(e.sub)})` : ""} arrived at the loading dock`];
    case "dl_done": return ["✅", `${t} finished downloading`];
    case "dl_gone": return ["↩️", `${t} left the loading dock`];
    case "req": return ["✉️", `${who} asked for ${t}`];
    case "delivered": return ["🎉", `${t} was delivered${who ? ` for ${who}` : ""}`];
  }
  return ["•", t];
}

// ---- geometry: tile (i, j) on floor fi -> screen. i runs down-right along the long back wall, j down-left along the short one.
const OF_RES = 4;  // offscreen pixels per world pixel
const OF_ART = 18;
// world px per picture px: 4x art (>= 90 px canvases), 2x art (the first HD round), or 1x (the very first sprites)
const ofDens = w => 1 / (w >= 90 ? 4 : w > 32 ? 2 : 1);  // bump when the sprite/prop PNGs change, so browsers don't keep the old ones
const ISO = {T: 8, TH: 4, GI: 12, GJ: 6, WALL: 30, SLAB: 6, W: 240, X0: 100, ROOF: 16, STREET: 92, RTOP: 5};
// floors as close as they go without one floor's front edge hiding the top of the room below (the front corner is off-centre)
ISO.BAND = ISO.WALL + (ISO.GI + ISO.GJ) * ISO.TH * 0.75 + 2;
// time of day: 0 = broad daylight, 1 = night (dusk and dawn ramp between). ?of_hour=22 previews an hour.
const OF_HOUR = (() => { const t = new URLSearchParams(location.search).get("of_hour"); return t !== null && t !== "" && !isNaN(+t) ? +t : null; })();
function ofNightness() {
  const d = new Date(), h = OF_HOUR ?? d.getHours() + d.getMinutes() / 60;
  return h < 6 || h >= 20 ? 1 : h < 7.5 ? 1 - (h - 6) / 1.5 : h >= 18.5 ? (h - 18.5) / 1.5 : 0;
}
const ofMix = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);  // colour arrays: a at t=0, b at t=1
const ofSkyGlass = () => rgb(ofMix([150, 200, 236], [11, 20, 56], OF.W.night));  // what a window shows: sky by day, night by night
const ofHslHex = h => { const f = n => { const k = (n + h / 30) % 12, v = 0.75 - 0.6 * Math.max(-1, Math.min(k - 3, 9 - k, 1)) * 0.4; return Math.round(255 * Math.min(1, v)).toString(16).padStart(2, "0"); }; return "#" + f(0) + f(8) + f(4); };
function ofGlow(c, x, y, r, col, a, flat = 0.5) {  // a soft additive pool of light (col = "r,g,b")
  if (a <= 0.005) return;
  c.save(); c.globalCompositeOperation = "lighter"; c.translate(x, y); c.scale(1, flat);
  const g = c.createRadialGradient(0, 0, 0, 0, 0, r); g.addColorStop(0, `rgba(${col},${a})`); g.addColorStop(1, `rgba(${col},0)`);
  c.fillStyle = g; c.fillRect(-r, -r, r * 2, r * 2); c.restore();
}
const EL = {i: 11.2, j: 0.8}, DOOR = {i: 0.35, j: 3.1}, CLERK = {i: 4.0, j: 2.6}, WALK = 5.45;
const PAL = {
  watch: {r: [86, 60, 98], l: [66, 46, 78], f: [[58, 42, 66], [52, 37, 60]]},
  dock: {r: [76, 84, 102], l: [60, 67, 84], f: [[52, 57, 70], [47, 52, 64]]},
  search: {r: [54, 86, 110], l: [43, 70, 92], f: [[42, 60, 80], [38, 55, 74]]},
  mail: {r: [128, 76, 62], l: [104, 60, 50], f: [[196, 184, 160], [150, 140, 122]]},
};
const rgb = (c, k = 0) => `rgb(${c.map(v => Math.max(0, Math.min(255, Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k))))).join(",")})`;
const ofType = k => k[0] === "w" ? "watch" : k;
const ofFi = k => OF.W.floors.indexOf(k);
const P = (fi, i, j) => [ISO.X0 + (i - j) * ISO.T, ISO.ROOF + fi * ISO.BAND + ISO.WALL + (i + j) * ISO.TH];
// out = where you step on and off the couch: on the open strip between the couches and the screens (j 2.55, clear of
// the dividers and the couches), right in front of the seat, so nobody walks through an armrest
const ofSeat = p => { const k = p % 3, b = 3.4 * k; return {fk: "w" + Math.floor(p / 3), k, b, i: b + 1.7, j: 3.25, out: [b + 1.7, 2.55]}; };
const ofDesk = d => { const c = d % 3, r = Math.floor(d / 3), i0 = 0.7 + 3.2 * c, j0 = r ? 3.3 : 0.9; return {i0, j0, i: i0 + 1.1, j: j0 + 1.25, out: [i0 - 0.45, j0 + 1.25]}; };
const ofHash = s => Math.abs([...String(s)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7));

function ofNewWorld() {
  return {agents: new Map(), crates: new Map(), hold: {}, floors: ["roof", "w1", "w0", "search", "mail", "dock"], doors: {}, hits: [], imgs: new Map(),
          fx: [], t: 0, data: null, first: true, sky: null, last: 0, night: ofNightness()};
}
function ofImg(url) {
  if (!url) return null;
  const W = OF.W; let im = W.imgs.get(url);
  if (!im) { im = new Image(); im.decoding = "async"; im.src = url; W.imgs.set(url, im); }
  return im.complete && im.naturalWidth ? im : null;
}

// ---- drawing primitives
function poly(c, pts, fill) { c.fillStyle = fill; c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < pts.length; k++) c.lineTo(pts[k][0], pts[k][1]); c.closePath(); c.fill(); }
function ofBox(c, fi, i0, j0, di, dj, h, col, z = 0, front) {
  const q = (i, j, hh) => { const [x, y] = P(fi, i, j); return [x, y - hh]; }, i1 = i0 + di, j1 = j0 + dj;
  poly(c, [q(i0, j1, z), q(i1, j1, z), q(i1, j1, z + h), q(i0, j1, z + h)], front || rgb(col, -.1));
  poly(c, [q(i1, j0, z), q(i1, j1, z), q(i1, j1, z + h), q(i1, j0, z + h)], rgb(col, -.32));
  poly(c, [q(i0, j0, z + h), q(i1, j0, z + h), q(i1, j1, z + h), q(i0, j1, z + h)], rgb(col, .12));
}
// a box to depth-sort with people (see ofCmp)
const ofBoxD = (c, fi, i0, j0, di, dj, h, col, z = 0, front, after) =>
  ({i0, i1: i0 + di, j0, j1: j0 + dj, draw: () => { ofBox(c, fi, i0, j0, di, dj, h, col, z, front); if (after) after(); }});
// something flat on a back wall: side "r" = the long wall (along i), "l" = the short wall (along j); u in tiles, h in pixels up from the floor
function ofWall(c, fi, side, u0, u1, h0, h1, fill, alpha = 1, pan = null, at = 0) {  // at = the j (or i) of the plane, 0 = the back walls
  const [x, y] = side === "r" ? P(fi, u0, at) : P(fi, at, u0);
  c.save(); c.globalAlpha = alpha; c.transform(side === "r" ? ISO.T : -ISO.T, ISO.TH, 0, 1, x, y - h1);
  const w = u1 - u0, h = h1 - h0;
  if (fill instanceof HTMLImageElement) {
    const r = (w * ISO.T) / h, nw = fill.naturalWidth, nh = fill.naturalHeight;
    let sw = nw, sh = nh, sx = 0, sy = 0;
    if (nw / nh > r) { sw = nh * r; sx = (nw - sw) / 2; } else { sh = nw / r; sy = (nh - sh) / 2; }
    if (pan) {  // a slow camera move across the picture (pan = {z: zoom, x, y: 0..1})
      const zw = sw / pan.z, zh = sh / pan.z;
      sx += (sw - zw) * pan.x; sy += (sh - zh) * pan.y; sw = zw; sh = zh;
    }
    c.imageSmoothingEnabled = true; c.drawImage(fill, sx, sy, sw, sh, 0, 0, w, h);
  } else { c.fillStyle = fill; c.fillRect(0, 0, w, h); }
  c.restore();
}
function ofTilePoly(c, fi, i0, j0, i1, j1, fill) { poly(c, [P(fi, i0, j0), P(fi, i1, j0), P(fi, i1, j1), P(fi, i0, j1)], fill); }
// people in front of a box's front faces are drawn after it; everyone else before
function ofCmp(a, b) {
  if (a.pt && b.pt) return a.i + a.j - (b.i + b.j);
  const pb = (p, B) => (p.i >= B.i1 - 0.01 || p.j >= B.j1 - 0.01) ? 1 : -1;
  if (a.pt) return pb(a, b);
  if (b.pt) return -pb(b, a);
  return (a.i0 + a.i1 + a.j0 + a.j1) - (b.i0 + b.i1 + b.j0 + b.j1);
}

// ---- PixelLab sprites (web/office/*.png): one white-shirted person, recoloured per agent (shirt = hue, skin, hair).
// se = walking down-right; ne = walking up-right (seen from behind); mirrored for the other two diagonals.
// Outfits: "" = everyone (white shirt, tinted per person); "dock-" = hard hat + hi-vis; "mail-" = courier uniform.
// Uniforms keep their colours; only skin and hair vary. An outfit that fails to load falls back to the plain one.
const OFS = {sets: {}, cache: new Map(), ok: false};
const OF_OUTFIT = {dock: "dock-", porter: "dock-", courier: "mail-", runner: "mail-", cat: "cat-", guard: "guard-"};
const OF_LOOKS = ["", "v1-", "v2-", "v3-"];  // everyday looks for viewers and desk staff (all white tops, tinted per person)
function ofSpritesLoad() {
  for (const pre of ["", "dock-", "mail-", "v1-", "v2-", "v3-", "cat-", "cat2-", "guard-"]) {
    if (OFS.sets[pre]) continue;
    const S = OFS.sets[pre] = {pre, raw: {}, ok: false, foot: 0, top: 0, tint: pre === "" || pre[0] === "v"};
    for (const d of ["se", "ne"]) for (let f = 0; f < 4; f++) {  // optional breathing loop for standing still
      const n = `breath-${d}-${f}`, im = new Image();
      im.onload = () => { const cv = document.createElement("canvas"); cv.width = im.width; cv.height = im.height; const g = cv.getContext("2d"); g.drawImage(im, 0, 0); S.raw[n] = g.getImageData(0, 0, im.width, im.height); };
      im.src = `/office/${pre}${n}.png?v=${OF_ART}`;
    }
    const names = ["idle-se", "idle-ne", ...[0, 1, 2, 3, 4, 5].flatMap(k => [`walk-se-${k}`, `walk-ne-${k}`])];
    S.walkN = 6;  // frames 6 and 7 are optional (the 8-frame walks); counted in as they load
    for (const d of ["se", "ne"]) for (const f of [6, 7]) { const n = `walk-${d}-${f}`, im = new Image();
      im.onload = () => { const cv = document.createElement("canvas"); cv.width = im.width; cv.height = im.height; const g = cv.getContext("2d"); g.drawImage(im, 0, 0);
        S.raw[n] = g.getImageData(0, 0, im.width, im.height); if (S.raw["walk-se-7"] && S.raw["walk-ne-7"] && S.raw["walk-se-6"] && S.raw["walk-ne-6"]) S.walkN = 8; };
      im.onerror = () => {}; im.src = `/office/${pre}${n}.png?v=${OF_ART}`; }
    let left = names.length;
    for (const n of names) {
      const im = new Image();
      im.onload = () => {
        const cv = document.createElement("canvas"); cv.width = im.width; cv.height = im.height;
        const g = cv.getContext("2d"); g.drawImage(im, 0, 0);
        S.raw[n] = g.getImageData(0, 0, im.width, im.height);
        if (--left === 0) {
          const d = S.raw["idle-se"], w = d.width; let foot = 0, top = d.height;
          let x0 = w, x1 = 0;
          for (let y = 0; y < d.height; y++) for (let x = 0; x < w; x++) if (d.data[(y * w + x) * 4 + 3] > 0) { foot = Math.max(foot, y); top = Math.min(top, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
          S.cx = Math.round((x0 + x1) / 2);  // the figure's middle (it isn't always the middle of the picture)
          S.foot = foot; S.top = top; S.k = ofDens(w); S.ok = true;  // k = world px per sprite px (HD sprites are 2x)
          if (pre === "") OFS.ok = true;
        }
      };
      im.onerror = () => {};  // missing plain sprites = hand-drawn people; a missing uniform = the plain one
      im.src = `/office/${pre}${n}.png?v=${OF_ART}`;
    }
    if (pre === "") {  // optional: a proper seated pose facing the camera (the clerk); seated-from-behind stays cropped
      const im = new Image();
      im.onload = () => {
        const cv = document.createElement("canvas"); cv.width = im.width; cv.height = im.height;
        const g = cv.getContext("2d"); g.drawImage(im, 0, 0);
        const d = g.getImageData(0, 0, im.width, im.height); let foot = 0, top = im.height;
        for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) if (d.data[(y * im.width + x) * 4 + 3] > 0) { foot = Math.max(foot, y); top = Math.min(top, y); }
        S.raw["sit-se"] = d; S.sitFoot = foot; S.sitTop = top; S.sitK = ofDens(im.width);
      };
      im.src = `/office/sit-se.png?v=${OF_ART}`;
    }
  }
}
const ofSet = a => {
  const pre = a.role === "cat" ? a.look || "cat-" : OF_OUTFIT[a.role] ?? (a.role === "viewer" || a.role === "desk" ? OF_LOOKS[(ofHash(a.id) >> 5) % OF_LOOKS.length] : "");
  const s = OFS.sets[pre]; return s && s.ok ? s : OFS.sets[""];
};
const ofHex = h => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16));
function ofSprite(S, name, a) {
  const key = `${S.pre}|${name}|${a.hue}|${a.skin}|${a.hair}`;
  let cv = OFS.cache.get(key);
  if (cv) return cv;
  const src = S.raw[name], out = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height), p = out.data;
  const skin = ofHex(a.skin), hair = ofHex(a.hair), hsl = (h, s, l) => { const k = n => (n + h / 30) % 12, q = s * Math.min(l, 1 - l);
    return [0, 8, 4].map(n => Math.round(255 * (l - q * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))))); };
  const shirtHi = hsl(a.hue, .58, .56), shirtLo = hsl(a.hue, .5, .38);
  if (!S.pre.startsWith("cat")) for (let o = 0; o < p.length; o += 4) {  // (cats keep their own coats)
    if (!p[o + 3]) continue;
    const r = p[o], g = p[o + 1], b = p[o + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 510;
    let to = null;
    if (S.tint && l > .6 && mx - mn < 28) to = l > .84 ? shirtHi : shirtLo;             // the white shirt
    else if (r > 150 && r - b > 40 && b / r > .5 && g / r > .6 && g / r < .9) to = skin.map(v => v * (r + g + b) / (229 + 175 + 163));  // skin (not vests or hats), keeping its shading
    else if (S.tint && l > .12 && l < .42 && r >= b) to = hair.map(v => Math.min(255, v * (r + g + b) / (72 + 62 + 67) * 1.15));  // hair (pants lean blue, so they stay)
    if (to) { p[o] = to[0]; p[o + 1] = to[1]; p[o + 2] = to[2]; }
  }
  cv = document.createElement("canvas"); cv.width = src.width; cv.height = src.height; cv.getContext("2d").putImageData(out, 0, 0);
  if (OFS.cache.size > 400) OFS.cache.clear();
  OFS.cache.set(key, cv);
  return cv;
}
function ofPerson(c, fi, a) {
  if (a.role === "cat" && !OFS.sets[a.look || "cat-"]?.ok) { ofSpritesLoad(); return; }  // no cat sprite, no cat (never a person)
  if (!OFS.ok) { ofSpritesLoad(); return ofPersonPx(c, fi, a); }
  const W = OF.W, [px, py] = P(fi, a.i, a.j), x = Math.round(px), t = W.t, sit = a.pose === "sit";
  const y = Math.round(py) - (a.jump ? Math.round(Math.abs(Math.sin(t * 9)) * 4) : 0);
  const d = a.back ? "ne" : "se", S = ofSet(a), breath = `breath-${d}-${Math.floor(t * 4 + a.i * 3) % 4}`;
  const name = a.walking ? `walk-${d}-${Math.floor(t * (S.walkN === 8 ? 12 : 10)) % (S.walkN || 6)}` : !sit && S.raw[breath] ? breath : `idle-${d}`;
  const front = sit && !a.back && S.raw["sit-se"];  // seated facing us: the real seated pose
  const flip = a.dir < 0;  // every picture faces right ("se" down-right, "ne" up-right); facing left = mirrored
  const img = ofSprite(S, front ? "sit-se" : name, a), w = img.width, cx = front || S.cx == null ? Math.floor(w / 2) : S.cx, foot = front ? S.sitFoot : S.foot;
  // seated from behind: the legs fold away behind the couch/desk, so only the top of the sprite is drawn, sunk a little
  const k = front ? S.sitK || S.k : S.k, cut = sit && !front ? Math.round((S.foot - S.top) * 0.42) : 0,  // the legs: about 40% of a standing figure
    sink = sit && !front ? Math.round((S.foot - S.top) * 0.26) : 0,  // and the body drops to seat height (hips on the cushion), not standing behind it
    sy = y - (foot + 1) * k + sink * k, sh = foot + 1 - cut;
  c.save(); c.globalAlpha = Math.max(0, a.alpha);
  if (!sit) { c.fillStyle = "rgba(0,0,0,.28)"; c.fillRect(x - 4, y, 8, 1); }
  c.translate(x, 0); if (flip) c.scale(-1, 1);
  c.drawImage(img, 0, 0, w, sh, -cx * k, sy, w * k, sh * k);
  c.restore(); c.save(); c.globalAlpha = Math.max(0, a.alpha);
  const head = Math.round(sy + (front ? S.sitTop : S.top) * k), R = (dx, dy, ww, hh, col) => { c.fillStyle = col; c.fillRect(x + (flip ? -dx - ww : dx), dy, ww, hh); };
  if ((a.role === "courier" || a.role === "runner") && !S.pre) {  // a drawn-on cap until the uniform sprite is in
    R(-3, head - 1, 7, 2, "#0d0b16"); R(-3, head - 1, 6, 1, "#2f5fd0"); R(flip ? -4 : 3, head, 2, 1, "#2f5fd0"); }
  const chest = head + 9;
  if (a.carry === "box") { R(-4, chest - 1, 8, 6, "#0d0b16"); R(-3, chest, 6, 4, "#b88a52"); R(-1, chest, 2, 4, "#e3c891"); }
  if (a.carry === "env") { R(-3, chest, 7, 5, "#0d0b16"); R(-2, chest + 1, 5, 3, "#f7f3ea"); R(-2, chest + 1, 5, 1, "#e0303a"); }
  if (a.asleep && (sit || a.role === "cat")) {  // z z z
    const k = (t * 0.5 + a.i) % 1, zx = x + 4, zy = head - 4 - Math.round(k * 7);
    c.fillStyle = `rgba(207,224,255,${1 - k})`; c.fillRect(zx, zy, 3, 1); c.fillRect(zx + 1, zy + 1, 1, 1); c.fillRect(zx, zy + 2, 3, 1);
  }
  if (a.role === "guard") {  // the torch: a beam on the floor ahead, sweeping a little
    const vx = a.dir * 8, vy = a.back ? -4 : 4, L = Math.hypot(vx, vy), nx = -vy / L, ny = vx / L, sw = Math.sin(t * 1.3 + a.j) * 4;
    const hx = x + a.dir * 3, hy = head + 11, ex = x + vx * 2.6 + nx * sw, ey = y + vy * 2.6 + ny * sw;
    c.save(); c.globalCompositeOperation = "lighter";
    poly(c, [[hx, hy], [ex + nx * 8, ey + ny * 4], [ex - nx * 8, ey - ny * 4]], `rgba(255,240,190,${0.1 * W.night})`); c.restore();
    ofGlow(c, ex, ey, 10, "255,240,190", 0.25 * W.night);
  }
  c.restore();
  a.headY = head - y;
  W.hits.push({x0: x - 6, x1: x + 6, y0: head, y1: y + 2, what: {agent: a.id}});
}
// ---- PixelLab props (web/office/props/*.png, 28x28 isometric). Placed by the FRONT corner of their footprint (i, j),
// so they depth-sort like people; each one also blocks a ~0.7-tile square behind that corner so walkers go round.
const OFP = {};
// a few of the movie pieces fill their whole picture, so they're drawn a bit smaller to sit right next to people
const OF_PSCALE = {puzzlebox: .62, volleyball: .5, ring: .6, idol: .72, falcon: .7, typewriter: .72, "hockey-mask": .68, briefcase: .72,
  lasersword: .8, hoverboard: .78, "hoverboard-float": .55, "red-balloon": .45, "amber-cane": .75, "sweater-stand": .85, "et-bike": .72, "proton-pack": .8, "robot-arm": .85,
  searchlight: .8, "balloon-drain": .75, "movie-camera": .8, "ark-crate": .8, monolith: 1.05, hydrant: .7, pumpkins: .8, "pumpkin-lantern": .75, "office-chair": .62, "bike-rack": .8, "street-clock": 1.1};
function ofPropImg(n) {
  let e = OFP[n];
  if (!e) {
    e = OFP[n] = {img: new Image(), ok: false};
    e.img.onload = () => {
      const im = e.img, cv = document.createElement("canvas"); cv.width = im.width; cv.height = im.height;
      const g = cv.getContext("2d"); g.drawImage(im, 0, 0);
      const W = im.width, H = im.height, id = g.getImageData(0, 0, W, H), d = id.data;
      // the props were cut from one big sheet, so some carry slivers of their neighbours along the edges:
      // keep the biggest blob, plus any other blob that doesn't touch the border
      const lab = new Int32Array(W * H).fill(-1), blobs = [];
      for (let p0 = 0; p0 < W * H; p0++) {
        if (lab[p0] >= 0 || d[p0 * 4 + 3] <= 40) continue;
        const b = {n: 0, edge: false, px: []}, st = [p0]; lab[p0] = blobs.length;
        while (st.length) {
          const p = st.pop(), x = p % W, y = (p - x) / W; b.n++; b.px.push(p);
          if (!x || !y || x === W - 1 || y === H - 1) b.edge = true;
          for (const q of [x > 0 && p - 1, x < W - 1 && p + 1, y > 0 && p - W, y < H - 1 && p + W])
            if (q !== false && lab[q] < 0 && d[q * 4 + 3] > 40) { lab[q] = blobs.length; st.push(q); }
        }
        blobs.push(b);
      }
      const big = blobs.reduce((m, b) => b.n > m.n ? b : m, {n: 0});
      let x0 = W, x1 = 0, y1 = 0;
      for (const b of blobs) {
        const keep = b === big || (!b.edge && b.n >= 3);
        for (const p of b.px) {
          if (!keep) { d[p * 4 + 3] = 0; continue; }
          const x = p % W, y = (p - x) / W; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
      }
      for (let p = 0; p < W * H; p++) if (d[p * 4 + 3] <= 40) d[p * 4 + 3] = 0;  // and no faint fringe
      g.putImageData(id, 0, 0); e.img = cv;
      if (n === "bus-se") {  // the number on the roof
        g.save(); g.transform(1, 0.44, 0, 1, 104, 79); g.font = "bold 22px monospace"; g.fillStyle = "#1c2a4a"; g.fillText("2525", 0, 0); g.restore(); e.img = cv;
      }
      e.cx = Math.round((x0 + x1) / 2); e.bottom = y1; e.k = ofDens(W) * (OF_PSCALE[n] || 1); e.ok = true;
    };
    e.img.src = `/office/props/${n}.png?v=${OF_ART}`;
  }
  return e.ok ? e : null;
}
// [name, i0, j0, s, flip, top]: the prop's footprint is the s x s square from its back corner (i0, j0); s = picture width / 16
// (a 2:1 tile is 16 px across). top = [name, px] draws a second prop standing on this one (a box on a pallet).
// Kept clear of the elevator column (i ~11.2), the front walkway (j ~5.45) and the paths people take to their seats.
// The props are the 48 px HD pack (drawn at half size = native pixels on the 2x canvas), so s = picture width / 32.
// Facing: most pictures face down-left (+j); cubby, vending, rack, popcorn and newsbox face down-right (+i).
// Against the long back wall (j = 0) a piece must face +j, against the short left wall (i = 0) +i: flip when it doesn't.
// Kept clear: the lift corridor (i 10.7-11.7), the front walkway (j ~5.45), the street door (dock, left wall j 1.2-4.8)
// and everyone's way to their seat (couch/desk "out" spots).
const PROPS = {
  // screening rooms: popcorn and the arcade on every floor; each floor has its own pieces on show by the lift
  watch: [["popcorn", 0.6, 4.1, 0.85], ["arcade", 9.85, 1.9, 0.75]],
  w0: [["puzzlebox", 9.85, 3.8, 0.75], ["hockey-mask", 4.7, 4.25, 0.7]],
  w1: [["lasersword", 9.85, 3.8, 0.75], ["ring", 4.7, 4.25, 0.7]],
  w2: [["movie-camera", 9.85, 3.8, 0.75]],
  // the shelving and the pallet back onto the wall behind the belt; just the forklift and the crate out on the floor
  // (the pieces that set something off out on the street live down here, where you can see it happen)
  dock: [["rack", 6.4, 0.05, 1.15, true], ["pallet-boxes", 7.75, 0.05, 1.3], ["robot-arm", 9.5, 2.1, 0.7],
         ["proton-pack", 0.05, 4.95, 0.75, true], ["ark-crate", 5.2, 4.2, 0.9], ["forklift", 7.3, 3.8, 1.3]],
  search: [["filing", 9.7, 0.05, 0.85], ["watercooler", 9.75, 1.2, 0.6], ["fern", 0.2, 4.6, 1.15],
           ["typewriter", 3.0, 0.05, 0.8], ["falcon", 6.2, 0.05, 0.75]],
  mail: [["mailcart", 0.2, 0.3, 1.3], ["cubby", 1.7, 0.05, 1.0, true], ["vending", 4.4, 0.05, 0.85, true],
         ["sweater-stand", 0.1, 1.6, 0.7, true],
         ["idol", 6.7, 3.2, 0.7], ["briefcase", 7.7, 3.2, 0.7], ["amber-cane", 8.7, 3.2, 0.7]],  // a little display corner; the volleyball sits on the front desk
  roof: [["water-tower", 0.25, 0.3, 1.9], ["monolith", 2.6, 0.2, 0.8], ["searchlight", 7.4, 0.15, 0.9], ["dish", 9.0, 0.5, 0.9],
         ["ac-unit", 0.3, 3.0, 1.0], ["ac-unit", 0.3, 4.1, 1.0], ["cafe-table", 4.4, 3.0, 1.1], ["deckchair", 6.2, 3.3, 1.0],
         ["deckchair", 7.5, 3.3, 1.0], ["grill", 9.3, 2.9, 0.8], ["planter", 10.9, 4.0, 0.9]],
};
// out front: [name, i, j, flip] on the pavement (ground level, tile coords of the ground floor); the road runs along i at j 9.2-13.2.
// Kerb row along j ~8.5; the little square right of the building (i 13-17) has the bench, a tree, the old clock and the bike rack.
const OF_LIGHT = [13.0, 8.75];  // the traffic light at the crossing (tap it: a race)
const STREET_PROPS = [["streetlamp", 1.0, 8.7], ["balloon-drain", 3.1, 8.85, true], ["hydrant", 5.6, 8.5], ["streetlamp", 8.0, 8.7],
  ["trash", 10.6, 8.4], ["traffic-light", ...OF_LIGHT], ["streetlamp", 15.5, 8.7], ["busstop", 19.2, 8.7],
  ["tree", 13.6, 2.4], ["bench", 13.6, 5.0], ["street-clock", 16.4, 3.4], ["tree", -1.6, 8.0],
  ["bike-rack", 16.1, 6.0], ["bicycle", 15.7, 6.25], ["et-bike", 16.6, 6.25]];
const OF_HOVER = [17.4, 5.9];  // where the hoverboard hovers when it's not out on a lap
const OF_LAMPS = [[1.0, 8.7], [8.0, 8.7], [15.5, 8.7]], OF_LAMP_H = 19;  // lamp head height (world px)
// seasonal decorations (web/office/props/xmas-tree.png ...), picked by today's date; free spots only
function ofSeason(now = new Date()) {
  const m = now.getMonth() + 1, d = now.getDate(), md = m * 100 + d;
  if (md >= 1001 && md <= 1031) return {name: "halloween", mail: [["pumpkin-lantern", 0.2, 4.3, 0.75], ["ghost", 9.7, 3.2, 0.7]], watch: [["pumpkins", 7.8, 4.2, 0.8]], street: [["pumpkins", 13.0, 6.9], ["pumpkin-lantern", 12.3, 6.2]]};
  if (md >= 1101 && md <= 1130) return {name: "autumn", mail: [["cornucopia", 0.2, 4.3, 0.8]], street: [["pumpkins", 13.0, 6.9]]};
  if (md >= 1201 && md <= 1226) return {name: "holidays", mail: [["xmas-tree", 0.2, 4.2, 0.9], ["presents", 9.7, 3.2, 0.8]], search: [["poinsettia", 0.3, 1.3, 0.7], ["menorah", 0.3, 0.2, 0.7]], street: [["snowman", 13.0, 6.9]]};
  if (md >= 1227 || md <= 102) return {name: "newyear", mail: [["balloons", 0.2, 4.3, 0.8], ["champagne", 9.7, 3.2, 0.8]], watch: [["balloons", 7.8, 4.2, 0.8]]};
  if (md >= 207 && md <= 214) return {name: "valentines", mail: [["hearts", 0.2, 4.3, 0.8]], watch: [["hearts", 7.8, 4.2, 0.8]]};
  if (md >= 310 && md <= 317) return {name: "stpatricks", mail: [["shamrock", 0.2, 4.3, 0.7]]};
  if (md >= 401 && md <= 420) return {name: "spring", mail: [["easter-basket", 0.2, 4.3, 0.8]]};
  return {name: ""};
}
const OF_SEASON = (() => { const t = new URLSearchParams(location.search).get("of_date");  // ?of_date=12-15 previews a season
  return ofSeason(t && /^\d{2}-\d{2}$/.test(t) ? new Date(`2026-${t}T12:00:00`) : new Date()); })();
const ofPropsFor = (type, k) => [...(PROPS[type] || []), ...(k && k !== type && PROPS[k] || []), ...(OF_SEASON[type] || [])];
const ofPropBlockers = (type, k) => ofPropsFor(type, k).map(([, i, j, s]) => [i, i + s, j, j + s]);
function ofPropDraw(c, x, y, n, flip) {
  const e = ofPropImg(n); if (!e) return;
  c.save(); c.translate(Math.round(x), 0); if (flip) c.scale(-1, 1);
  const k = e.k, w = e.img.width, h = e.img.height;
  c.drawImage(e.img, 0, 0, w, h, -e.cx * k, Math.round(y) - (e.bottom + 1) * k, w * k, h * k); c.restore();
}
// big furniture (PixelLab 8-direction objects, one facing picked per piece): drawn centred over its footprint
// [i0, i0+di] x [j0, j0+dj] with its bottom on the footprint's front corner; depth-sorts as a box, like ofBoxD.
const BELT_Z = 9, COUNTER_Z = 13;  // heights (world px) of the belt top and the counter top, where things sit
function ofTint(n, deg) {  // a hue-rotated copy of a prop picture (canvas filters aren't everywhere yet)
  const e = ofPropImg(n); if (!e || !deg) return e;
  const key = n + "@" + deg; if (OFP[key]) return OFP[key];
  const src = e.img, cv = document.createElement("canvas"); cv.width = src.width; cv.height = src.height;
  const g = cv.getContext("2d"); g.drawImage(src, 0, 0);
  const id = g.getImageData(0, 0, cv.width, cv.height), p = id.data, a = deg * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
  // rotate hue in YIQ space: keeps brightness and saturation, so the shading survives
  for (let o = 0; o < p.length; o += 4) {
    if (!p[o + 3]) continue;
    const r = p[o], gg = p[o + 1], b = p[o + 2], y = .299 * r + .587 * gg + .114 * b, i = .596 * r - .274 * gg - .322 * b, q = .211 * r - .523 * gg + .312 * b;
    const i2 = i * cs - q * sn, q2 = i * sn + q * cs;
    p[o] = y + .956 * i2 + .621 * q2; p[o + 1] = y - .272 * i2 - .647 * q2; p[o + 2] = y - 1.106 * i2 + 1.703 * q2;
  }
  g.putImageData(id, 0, 0);
  return (OFP[key] = {img: cv, ok: true, cx: e.cx, bottom: e.bottom, k: e.k});
}
function ofFurnD(c, fi, n, i0, j0, di, dj, o = {}) {
  return {i0, i1: i0 + di, j0, j1: j0 + dj, draw: () => {
    const e = ofTint(n, o.hue); if (!e) return o.after && o.after();
    const [x] = P(fi, i0 + di / 2, j0 + dj / 2), [, y] = P(fi, i0 + di, j0 + dj), k = e.k;
    c.save(); c.translate(Math.round(x), 0); if (o.flip) c.scale(-1, 1);
    c.drawImage(e.img, 0, 0, e.img.width, e.img.height, -e.cx * k, Math.round(y) - (e.bottom + 1) * k, e.img.width * k, e.img.height * k);
    c.restore();
    if (o.after) o.after();
  }};
}
function ofProps(c, fi, type, list, k) {
  for (const [n, i0, j0, s, flip, top] of ofPropsFor(type, k)) {
    const i = i0 + s, j = j0 + s;  // drawn from its front corner, and depth-sorted there
    list.push({pt: true, i: i - 0.05, j: j - 0.05, draw: () => {
      const [x, y] = P(fi, i, j); ofPropDraw(c, x, y, n, flip); ofFxHit(x, y, n, {fk: k});
      if (top) ofPropDraw(c, x, y - top[1], top[0], flip);
    }});
  }
}
// ---- floors and walls with a bit of texture, so each room reads as its own kind of place
function ofSurfaces(c, fi, type, pal) {
  const {GI, GJ, WALL} = ISO, f = pal.f, h = (a, b) => ((a * 73856093) ^ (b * 19349663)) >>> 0;
  if (type === "watch") {  // wooden planks running along the long wall, staggered ends
    for (let s = 0; s < GJ * 2; s++) for (let i = -(s % 2) * 0.5; i < GI; i += 1.5) {
      const k = h(s, Math.round(i * 2)) % 3, col = k === 0 ? f[0] : k === 1 ? f[1] : f[0].map(v => v * 1.08);
      ofTilePoly(c, fi, Math.max(0, i), s / 2, Math.min(GI, i + 1.5), s / 2 + 0.5, rgb(col));
      ofTilePoly(c, fi, Math.max(0, i), s / 2, Math.min(GI, i + 1.5), s / 2 + 0.06, rgb(f[1], -.25));
    }
  } else if (type === "dock") {  // poured concrete: big slabs with joints and a few oil stains
    ofTilePoly(c, fi, 0, 0, GI, GJ, rgb(f[0]));
    for (let i = 3; i < GI; i += 3) ofTilePoly(c, fi, i - 0.03, 0, i + 0.03, GJ, rgb(f[1], -.2));
    for (let j = 3; j < GJ; j += 3) ofTilePoly(c, fi, 0, j - 0.03, GI, j + 0.03, rgb(f[1], -.2));
    for (const [i, j, r] of [[2.2, 4.1, 0.5], [5.6, 3.6, 0.35], [8.1, 3.3, 0.45], [4.0, 5.2, 0.3]]) ofTilePoly(c, fi, i, j, i + r, j + r * 0.8, "rgba(10,10,20,.22)");
  } else if (type === "search") {  // office carpet tiles, quarter-turned
    for (let i = 0; i < GI; i++) for (let j = 0; j < GJ; j++) {
      ofTilePoly(c, fi, i, j, i + 1, j + 1, rgb(f[(i + j) % 2]));
      for (let k = 0; k < 3; k++) { const u = i + 0.15 + k * 0.3; (i + j) % 2 ? ofTilePoly(c, fi, u, j + 0.1, u + 0.05, j + 0.9, rgb(f[0], .05)) : ofTilePoly(c, fi, i + 0.1, j + 0.15 + k * 0.3, i + 0.9, j + 0.2 + k * 0.3, rgb(f[1], .05)); }
    }
  } else for (let i = 0; i < GI; i++) for (let j = 0; j < GJ; j++) ofTilePoly(c, fi, i, j, i + 1, j + 1, rgb(f[(i + j) % 2]));  // mailroom: lobby checkerboard
  // walls: a skirting board on every floor, plus each room's own finish above it
  const r = pal.r, l = pal.l;
  if (type === "dock") {  // painted cinder block
    for (let row = 0; row < 7; row++) {
      const y = 3 + row * 4;
      ofWall(c, fi, "r", 0, GI, y, y + 0.6, rgb(r, -.18)); ofWall(c, fi, "l", 0, GJ, y, y + 0.6, rgb(l, -.18));
      for (let u = (row % 2) * 0.75; u < GI; u += 1.5) ofWall(c, fi, "r", u, u + 0.08, y, y + 4, rgb(r, -.18));
      for (let u = (row % 2) * 0.75; u < GJ; u += 1.5) ofWall(c, fi, "l", u, u + 0.08, y, y + 4, rgb(l, -.18));
    }
  } else {  // wainscot panelling under a rail, wallpaper stripes above
    const wain = type === "mail" ? 11 : 9;
    ofWall(c, fi, "r", 0, GI, 0, wain, rgb(r, -.2)); ofWall(c, fi, "l", 0, GJ, 0, wain, rgb(l, -.2));
    ofWall(c, fi, "r", 0, GI, wain, wain + 1, rgb(r, .2)); ofWall(c, fi, "l", 0, GJ, wain, wain + 1, rgb(l, .2));
    for (let u = 0.5; u < GI; u += 1) ofWall(c, fi, "r", u, u + 0.06, 1, wain - 1, rgb(r, -.32));
    for (let u = 0.5; u < GJ; u += 1) ofWall(c, fi, "l", u, u + 0.06, 1, wain - 1, rgb(l, -.32));
    for (let u = 0.25; u < GI; u += 0.5) ofWall(c, fi, "r", u, u + 0.18, wain + 1, WALL, rgb(r, .045));
    for (let u = 0.25; u < GJ; u += 0.5) ofWall(c, fi, "l", u, u + 0.18, wain + 1, WALL, rgb(l, .045));
  }
  ofWall(c, fi, "r", 0, GI, 0, 2, rgb(r, -.4)); ofWall(c, fi, "l", 0, GJ, 0, 2, rgb(l, -.4));
}
// ---- the hand-drawn fallback: a little person, 6 x 13 pixels, standing on (x, y)
function ofPersonPx(c, fi, a) {
  const W = OF.W, [px, py] = P(fi, a.i, a.j), x = Math.round(px), t = W.t;
  const sit = a.pose === "sit", walk = a.walking ? Math.floor(t * 7) % 2 : -1;
  const y = Math.round(py) - (a.jump ? Math.round(Math.abs(Math.sin(t * 9)) * 4) : 0), b = sit ? 3 : 0;
  const shirt = `hsl(${a.hue} 58% 52%)`, dark = `hsl(${a.hue} 50% 34%)`, pants = "#2a2740", out = "#0d0b16";
  const hy = -13 + b + (a.asleep && sit ? 1 : 0), parts = [];
  if (!sit) parts.push([-2, -4, 2, walk === 0 ? 3 : 4, pants], [0, -4, 2, walk === 1 ? 3 : 4, pants]);
  parts.push([-3, -9 + b, 6, 5, shirt], [-3, -5 + b, 6, 1, dark]);
  if (!a.carry && !sit) parts.push([-3, -6 + (walk === 0 ? -1 : 0), 1, 2, a.skin], [2, -6 + (walk === 1 ? -1 : 0), 1, 2, a.skin]);
  parts.push([-2, hy, 4, 4, a.skin]);
  if (a.back) parts.push([-2, hy, 4, 3, a.hair]);
  else parts.push([-2, hy, 4, 1, a.hair], [-2, hy + 1, 1, 1, a.hair], [-1, hy + 2, 1, 1, "#1a1020"], [1, hy + 2, 1, 1, "#1a1020"]);
  if (a.role === "courier" || a.role === "runner") parts.push([-2, hy - 1, 5, 1, "#2f5fd0"]);
  if (a.carry === "box") parts.push([-3, -11 + b, 6, 5, "#b88a52"], [-1, -11 + b, 2, 5, "#e3c891"]);
  if (a.carry === "env") parts.push([-3, -8 + b, 5, 3, "#f7f3ea"], [-3, -8 + b, 5, 1, "#e0303a"]);
  c.save(); c.globalAlpha = Math.max(0, a.alpha);
  if (!sit) { c.fillStyle = "rgba(0,0,0,.28)"; c.fillRect(x - 3, y, 6, 1); }
  const R = (dx, dy, w, h, col) => { c.fillStyle = col; c.fillRect(x + (a.dir < 0 ? -dx - w : dx), y + dy, w, h); };
  for (const [dx, dy, w, h] of parts) { R(dx - 1, dy, w + 2, h, out); R(dx, dy - 1, w, h + 2, out); }
  for (const [dx, dy, w, h, col] of parts) R(dx, dy, w, h, col);
  if (a.asleep && sit) {  // z z z
    const k = (t * 0.5 + a.i) % 1, zx = x + 3, zy = y - 16 - Math.round(k * 7);
    c.fillStyle = `rgba(207,224,255,${1 - k})`; c.fillRect(zx, zy, 3, 1); c.fillRect(zx + 1, zy + 1, 1, 1); c.fillRect(zx, zy + 2, 3, 1);
  }
  c.restore();
  W.hits.push({x0: x - 5, x1: x + 5, y0: y - 16, y1: y + 2, what: {agent: a.id}});
}

// ---- people: where they are, where they're going
function ofAgent(id, o) {
  const n = ofHash(id);
  const a = {id, fk: o.fk, i: o.i, j: o.j, hue: o.hue ?? n % 360, skin: SKIN[n % SKIN.length], hair: HAIR[(n >> 3) % HAIR.length],
             pose: o.pose || "stand", back: !!o.back, dir: o.dir || 1, steps: [], carry: o.carry || null, alpha: o.fade ? 0 : 1,
             fadeIn: !!o.fade, role: o.role, tag: o.tag || null, me: !!o.me, out: o.out || null, idleT: 2 + Math.random() * 5, walking: false};
  OF.W.agents.set(id, a);
  return a;
}
function ofBlockers(fk) {
  return [...ofBlockersFurn(fk), ...ofPropBlockers(ofType(fk), fk)];
}
function ofBlockersFurn(fk) {
  switch (ofType(fk)) {
    case "watch": return [0, 1, 2].flatMap(k => [[3.4 * k + 0.45, 3.4 * k + 2.95, 2.95, 3.85], ...(k ? [[3.4 * k - 0.15, 3.4 * k + 0.15, 0, 2.3]] : [])]);
    case "dock": return [[0.55, 6.05, 1.55, 2.55]];
    case "search": return [0, 1, 2, 3, 4, 5].map(d => { const s = ofDesk(d); return [s.i0, s.i0 + 2.2, s.j0, s.j0 + 0.75]; });
    case "mail": return [[2.95, 6.25, 3.15, 4.05]];
    case "roof": return [[10.25, 12.1, 0, 0.5]];  // the stair and lift housing
  }
  return [];
}
function ofBlocked(fk, a, b) {
  const si0 = Math.min(a.i, b.i), si1 = Math.max(a.i, b.i), sj0 = Math.min(a.j, b.j), sj1 = Math.max(a.j, b.j);
  return ofBlockers(fk).some(([i0, i1, j0, j1]) => si1 > i0 && si0 < i1 && sj1 > j0 && sj0 < j1);
}
function ofLegs(fk, p, q) {  // an L-shaped walk that doesn't go through furniture (or round the front of the room if it must)
  for (const c of [{i: q.i, j: p.j}, {i: p.i, j: q.j}]) if (!ofBlocked(fk, p, c) && !ofBlocked(fk, c, q)) return [{go: [c.i, c.j]}, {go: [q.i, q.j]}];
  return [{go: [p.i, WALK]}, {go: [q.i, WALK]}, {go: [q.i, q.j]}];
}
function ofGo(a, fk, i, j, extra = [], via = []) {
  const s0 = a.steps[0], riding = s0 && s0.ride && s0.left != null;
  let at = riding ? s0.ride : a.fk, pos = riding ? {...EL} : {i: a.i, j: a.j};
  const st = riding ? [s0] : [];
  if (!riding && a.pose === "sit" && a.out) { st.push({go: a.out}); pos = {i: a.out[0], j: a.out[1]}; }
  const leg = q => { st.push(...ofLegs(at, pos, q)); pos = q; };
  if (at !== fk) { leg(EL); st.push({fn: b => ofDoor(b.fk)}, {ride: fk}); at = fk; pos = {...EL}; }
  for (const [vi, vj] of via) leg({i: vi, j: vj});
  leg({i, j});
  st.push(...extra);
  if (!riding) a.pose = "stand";
  a.steps = st;
}
const ofExit = (a, fk) => ofGo(a, fk, EL.i, EL.j, [{fn: b => ofDoor(b.fk)}, {remove: 1}]);
const ofDoor = k => { OF.W.doors[k] = 1.3; };

function ofStep(a, dt) {
  a.walking = false;
  if (a.fadeIn && a.alpha < 1) a.alpha = Math.min(1, a.alpha + dt * 2.5);
  const s = a.steps[0];
  if (!s) return ofIdle(a, dt);
  if (s.go) {
    const [ti, tj] = s.go, di = ti - a.i, dj = tj - a.j, d = 2.6 * dt;
    if (Math.abs(di) > 0.02) { a.i += Math.sign(di) * Math.min(d, Math.abs(di)); a.back = di < 0; a.dir = di > 0 ? 1 : -1; a.walking = true; }
    else if (Math.abs(dj) > 0.02) { a.i = ti; a.j += Math.sign(dj) * Math.min(d, Math.abs(dj)); a.back = dj < 0; a.dir = dj > 0 ? -1 : 1; a.walking = true; }
    else { a.i = ti; a.j = tj; a.steps.shift(); }
  } else if (s.ride) {
    if (s.left == null) { s.left = 0.8 + 0.45 * Math.abs(ofFi(s.ride) - ofFi(a.fk)); a.hidden = true; }
    if ((s.left -= dt) <= 0) { a.fk = s.ride; a.i = EL.i; a.j = EL.j; a.hidden = false; a.back = false; a.dir = -1; ofDoor(a.fk); a.steps.shift(); }
  } else if (s.wait != null) { if ((s.wait -= dt) <= 0) a.steps.shift(); }
  else if (s.jump != null) { a.jump = true; if ((s.jump -= dt) <= 0) { a.jump = false; a.steps.shift(); } }
  else if (s.sit) { a.pose = "sit"; a.back = s.sit === "back"; if (a.back) a.dir = 1; a.out = s.out || a.out; a.steps.shift(); }  // seated facing the screen/desk: always the same way round
  else if (s.fn) { a.steps.shift(); s.fn(a); }
  else if (s.street) { ofDoor("street"); a.steps.shift(); }
  else if (s.remove) { a.alpha -= dt * 3; if (a.alpha <= 0) OF.W.agents.delete(a.id); }
}
function ofIdle(a, dt) {
  if ((a.idleT -= dt) > 0) return;
  a.idleT = 3 + Math.random() * 5;
  const W = OF.W;
  if (a.role === "viewer") {
    const s = ofSeat(a.seat);
    if (a.paused) ofGo(a, s.fk, s.b + 0.5 + Math.random() * 2.3, 1.3 + Math.random() * 1.3, [{wait: 1 + Math.random() * 2}]);  // stretching their legs
    else if (a.pose !== "sit") ofGo(a, s.fk, s.i, s.j, [{sit: "back", out: s.out}], [s.out]);
  } else if (a.role === "dock") {
    const cr = [...W.crates.values()].filter(c => !c.hold), c = cr[Math.floor(Math.random() * cr.length)];
    ofGo(a, "dock", c ? Math.min(9.3, c.x + 0.3) : 1 + Math.random() * 6, c ? 3.0 : 3.2 + Math.random() * 1.8, [{wait: 1 + Math.random() * 2}]);
  } else if (a.role === "desk") {
    const s = ofDesk(a.desk);
    if (a.pose !== "sit") ofGo(a, "search", s.i, s.j, [{sit: "back", out: s.out}], [s.out]);
    else if (!a.asleep && Math.random() < 0.12) ofGo(a, "search", 10.1, 2.25, [{wait: 2.5}], []);  // water cooler break
  } else if (a.role === "cat") {  // the building cats: pad about the front of their floor, nap a lot, sometimes go up on the roof
    if (a.asleep) a.asleep = false;
    else if (Math.random() < 0.35) { a.asleep = true; a.idleT = 8 + Math.random() * 10; }
    else { const to = Math.random() < 0.1 ? (a.fk === "roof" ? a.home : "roof") : a.fk, [i, j] = ofSpot(to); ofGo(a, to, i, j, [{wait: 1 + Math.random() * 2}]); }
  } else if (a.role === "guard") {  // night security: a slow round of every floor, roof included
    const fk = Math.random() < 0.45 ? a.fk : W.floors[Math.floor(Math.random() * W.floors.length)], [i, j] = ofSpot(fk, true);
    ofGo(a, fk, i, j, [{wait: 2 + Math.random() * 3}]); a.idleT = 0.5 + Math.random();
  }
}

// somewhere free to stand: along the front of a floor (the open middle of the roof)
function ofSpot(fk, guard) {
  const roof = fk === "roof", bl = ofBlockers(fk);
  for (let n = 0; n < 12; n++) {
    const i = 0.8 + Math.random() * 9.4, j = roof ? 2.2 + Math.random() * 3.0 : guard ? WALK : 4.6 + Math.random() * 0.9;
    if (!bl.some(([i0, i1, j0, j1]) => i > i0 - 0.3 && i < i1 + 0.3 && j > j0 - 0.3 && j < j1 + 0.3)) return [i, j];
  }
  return [5.5, WALK];
}

// ---- the data -> who should be where
function ofSyncWorld(d) {
  const W = OF.W, first = W.first, prev = W.data;
  W.data = d;
  const live = (role, fn) => [...W.agents.values()].filter(a => a.role === role && !a.leaving && (!fn || fn(a)));
  if (!W.agents.has("clerk")) ofAgent("clerk", {fk: "mail", ...CLERK, pose: "sit", role: "clerk", hue: 205, dir: -1});  // facing the counter's customers
  if (!W.agents.has("cat")) ofAgent("cat", {fk: "w0", i: 5.6, j: 5.0, role: "cat", hue: 30}).home = "w0";
  if (!W.agents.has("cat2")) Object.assign(ofAgent("cat2", {fk: "mail", i: 8.2, j: 5.1, role: "cat", hue: 0}), {home: "mail", look: "cat2-"});
  // after dark a night guard does the rounds; gone again by morning
  const night = ofNightness() > 0.5, guard = W.agents.get("guard");
  if (night && !guard) { ofAgent("guard", {fk: "dock", ...EL, role: "guard", hue: 222, dir: -1}).idleT = 0.6; ofDoor("dock"); }
  else if (!night && guard && !guard.leaving) { guard.leaving = true; ofExit(guard, guard.fk); }
  const crew = d.downloads.length > 2 ? 2 : 1;
  for (let k = 0; k < 2; k++) {
    const id = "dock" + k, a = W.agents.get(id);
    if (k < crew && !a) ofAgent(id, {fk: "dock", i: 2 + k * 4, j: 3.4, role: "dock", hue: 28 + k * 18});
    else if (k >= crew && a && !a.leaving) { a.leaving = true; ofExit(a, "dock"); }
  }
  // viewers: in from the street, up to their couch; out the same way when they stop
  const streaming = new Set(d.streams.map(s => "v:" + s.key));
  for (const s of d.streams) {
    const id = "v:" + s.key; let a = W.agents.get(id);
    if (!a) {
      const used = new Set(live("viewer").map(v => v.seat)); let p = 0; while (used.has(p)) p++;
      const seat = ofSeat(p);
      if (first) a = ofAgent(id, {fk: seat.fk, i: seat.i, j: seat.j, pose: "sit", back: true, role: "viewer", hue: s.hue, out: seat.out});
      else {
        a = ofAgent(id, {fk: "dock", ...DOOR, fade: true, role: "viewer", hue: s.hue}); ofDoor("street");
        ofGo(a, seat.fk, seat.i, seat.j, [{sit: "back", out: seat.out}], [seat.out]);
      }
      a.seat = p;
    }
    if (a.paused !== (s.state === "paused")) a.idleT = 0.3;
    Object.assign(a, {s, paused: s.state === "paused", tag: s.who, me: s.me, hue: s.hue});
  }
  for (const a of live("viewer", v => !streaming.has(v.id))) { a.leaving = true; a.seat = -1; ofGo(a, "dock", DOOR.i, DOOR.j, [{street: 1}, {remove: 1}]); }
  // search desk: one worker per request being looked for
  const hunt = d.searching.slice(0, 6), hunting = new Set(hunt.map(x => "s:" + x.key));
  const gonePending = prev ? prev.pending.filter(x => !d.pending.some(y => y.title === x.title)) : [];
  for (const x of hunt) {
    const id = "s:" + x.key; let a = W.agents.get(id);
    if (!a) {
      const used = new Set(live("desk").map(v => v.desk)); let k = 0; while (used.has(k)) k++;
      const s = ofDesk(k);
      if (first) a = ofAgent(id, {fk: "search", i: s.i, j: s.j, pose: "sit", back: true, role: "desk", out: s.out});
      else {
        a = ofAgent(id, {fk: "search", ...EL, role: "desk", dir: -1}); ofDoor("search");
        ofGo(a, "search", s.i, s.j, [{sit: "back", out: s.out}], [s.out]);
        if (gonePending.some(y => y.title === x.title)) {  // the front desk runs the approved request upstairs
          const r = ofAgent("run:" + id + Date.now(), {fk: "mail", i: 2.4, j: 2.6, role: "runner", carry: "env", hue: 215});
          ofGo(r, "search", s.out[0], s.j + 0.9, [{wait: 0.6}, {fn: b => { b.carry = null; ofExit(b, "search"); }}]);
        }
      }
      a.desk = k;
    }
    a.x = x; a.asleep = !!x.asleep && !x.now;
  }
  for (const a of live("desk", v => !hunting.has(v.id))) {
    a.leaving = true; a.asleep = false;
    const dl = !first && d.downloads.find(y => y.title === a.x?.title);
    if (dl) {  // found it: carry the box down to the loading dock
      W.hold[dl.key] = true;
      setTimeout(() => { a.carry = "box"; }, 300);
      ofGo(a, "dock", 1.1, 3.0, [{wait: 0.4}, {fn: b => { b.carry = null; delete W.hold[dl.key]; W.fx.push({fk: "dock", i: 1.2, j: 2, t: 1, kind: "puff"}); ofExit(b, "dock"); }}]);
    } else ofGo(a, "search", ofDesk(a.desk).out[0], WALK - 0.4, [{jump: 1.2}, {fn: b => ofExit(b, "search")}]);
  }
  // loading dock: a box per download, sliding along the belt as it fills
  const dls = new Set();
  for (const x of d.downloads) {
    dls.add(x.key);
    let c = W.crates.get(x.key);
    const tx = 0.8 + Math.min(100, x.pct || 0) / 100 * 4.5;
    if (!c) { c = {key: x.key, x: first ? tx : 0.8}; W.crates.set(x.key, c); }
    c.tx = tx; c.d = x; c.hold = !!W.hold[x.key];
  }
  for (const [k, c] of [...W.crates]) if (!dls.has(k)) {
    W.crates.delete(k);
    if (!first && (c.d.pct >= 95 || c.d.state === "importing")) {  // done: the truck brings it round, poster on the side
      (W.truckQ = W.truckQ || []).push({key: k, title: c.d.title, poster: c.d.poster});
      if (W.truckQ.length > 3) W.truckQ.shift();
    }
  }
  // mail: a carrier brings in each new request
  if (prev && !first) for (const x of d.pending) if (!prev.pending.some(y => y.title === x.title)) {
    const m = ofAgent("mail:" + x.title + Date.now(), {fk: "dock", ...DOOR, role: "courier", carry: "env", fade: true, hue: 215});
    ofDoor("street");
    ofGo(m, "mail", 4.4, 4.6, [{wait: 0.7}, {fn: b => { b.carry = null; ofGo(b, "dock", DOOR.i, DOOR.j, [{street: 1}, {remove: 1}]); }}], [[2.4, 4.6]]);
  }
  // enough screening floors for everyone (and for anyone still on their way out)
  let nW = Math.max(2, Math.ceil(d.streams.length / 3));  // two screening floors at least, so the pieces up there are seen
  for (const a of W.agents.values()) {
    if (a.fk[0] === "w") nW = Math.max(nW, +a.fk.slice(1) + 1);
    if (a.role === "viewer" && a.seat >= 0) nW = Math.max(nW, Math.floor(a.seat / 3) + 1);
  }
  W.floors = ["roof", ...Array.from({length: nW}, (_, k) => "w" + (nW - 1 - k)), "search", "mail", "dock"];
  W.first = false;
}

// ---- render
function ofLoop(ts) {
  const W = OF.W;
  if (!W || $("#office").hidden) return;
  const dt = Math.min(0.1, (ts - (W.last || ts)) / 1000); W.last = ts;
  if (!document.hidden) {
    ofAdvance(dt);
    if (ts - (W.drawn || 0) > 30) { W.drawn = ts; ofRender(); }  // ~30 frames a second is plenty, and halves the work
  }
  OF.raf = requestAnimationFrame(ofLoop);
}
function ofAdvance(dt) {  // move the world on by dt seconds (the Apple TV calls this straight from its own clock)
  const W = OF.W;
  W.t += dt;
  for (const a of [...W.agents.values()]) ofStep(a, dt);
  for (const c of W.crates.values()) c.x += (c.tx - c.x) * Math.min(1, dt * 0.8);
  for (const k in W.doors) if ((W.doors[k] -= dt) <= 0) delete W.doors[k];
  W.fx = W.fx.filter(f => (f.t -= dt) > 0);
  ofTraffic(dt);
}
function ofDrawWorld() {  // the whole building, street and sky on the offscreen canvas (world px x OF_RES); returns it
  const W = OF.W;
  const H = ISO.ROOF + W.floors.length * ISO.BAND + ISO.STREET;
  if (!W.off) W.off = document.createElement("canvas");
  // drawn at twice the world's resolution: layout stays in world pixels, sprites draw at their native (finer) pixels
  const o = W.off; if (o.height !== H * OF_RES) { o.width = ISO.W * OF_RES; o.height = H * OF_RES; }
  const c = o.getContext("2d");
  c.setTransform(OF_RES, 0, 0, OF_RES, 0, 0); c.imageSmoothingEnabled = false; c.clearRect(0, 0, ISO.W, H);
  W.hits = []; W.night = ofNightness();
  ofSky(c, H); ofGround(c); ofNeighbours(c, H); ofBeam(c);
  W.floors.forEach((k, fi) => ofFloor(c, k, fi));
  ofStreet(c);
  return o;
}
function ofRender() {
  const W = OF.W, cv = $("#ofCanvas");
  if (!cv) return;
  const H = ISO.ROOF + W.floors.length * ISO.BAND + ISO.STREET, o = ofDrawWorld();
  // blow it up with hard pixel edges
  const cssW = cv.clientWidth || 360, dpr = Math.min(3, devicePixelRatio || 1), w = Math.round(cssW * dpr), h = Math.round(H * cssW / ISO.W * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; cv.style.aspectRatio = `${ISO.W} / ${H}`; }
  const v = cv.getContext("2d"); v.imageSmoothingEnabled = false; v.clearRect(0, 0, w, h); v.drawImage(o, 0, 0, w, h);
  ofLabels(cssW / ISO.W);
}
// the ground floor's slab bottom = street level; G(i, j) is a point on the ground in the ground floor's tile coords
const ofGY = () => ISO.ROOF + OF.W.floors.length * ISO.BAND;  // y of the building's front corner at street level
const G = (i, j) => { const [x, y] = P(OF.W.floors.length - 1, i, j); return [x, y + ISO.SLAB]; };
function ofSky(c, H) {
  const W = OF.W, n = W.night, day = 1 - n, dusk = n > 0 && n < 1 ? 1 - Math.abs(2 * n - 1) : 0, base = ofGY() - 38;
  if (day > 0) {  // daylight (at night the page's own dark sky shows through)
    const g = c.createLinearGradient(0, 0, 0, base);
    g.addColorStop(0, `rgba(84,156,222,${day})`); g.addColorStop(1, `rgba(186,222,240,${day})`);
    c.fillStyle = g; c.fillRect(0, 0, ISO.W, base + 40);
  }
  if (dusk > 0) {  // sunset / sunrise glow low in the sky
    const g = c.createLinearGradient(0, base - 260, 0, base);
    g.addColorStop(0, "rgba(120,70,160,0)"); g.addColorStop(0.6, `rgba(232,120,110,${0.45 * dusk})`); g.addColorStop(1, `rgba(255,190,110,${0.75 * dusk})`);
    c.fillStyle = g; c.fillRect(0, base - 260, ISO.W, 300);
  }
  if (day > 0.05) {  // the sun, and a few clouds drifting by
    ofGlow(c, 26, 46 + n * 120, 22, "255,240,190", 0.5 * day, 1);
    c.fillStyle = `rgba(255,246,206,${day})`; c.beginPath(); c.arc(26, 46 + n * 120, 6, 0, 7); c.fill();
    for (let k = 0; k < 4; k++) {
      const cx = ((k * 61 + W.t * (1.2 + k * 0.3)) % (ISO.W + 60)) - 30, cy = 80 + k * 70;
      c.fillStyle = `rgba(255,255,255,${0.7 * day})`;
      c.fillRect(Math.round(cx), cy, 22, 4); c.fillRect(Math.round(cx) + 4, cy - 3, 12, 3); c.fillRect(Math.round(cx) + 14, cy - 2, 5, 2);
    }
  }
  if (n > 0.05) {  // the moon
    c.fillStyle = `rgba(244,240,216,${n})`; c.beginPath(); c.arc(ISO.W - 24, 40, 5, 0, 7); c.fill();
    c.fillStyle = `rgba(20,24,52,${n})`; c.beginPath(); c.arc(ISO.W - 21.5, 38.5, 4.2, 0, 7); c.fill();
    ofGlow(c, ISO.W - 24, 40, 16, "200,210,255", 0.12 * n, 1);
  }
  if (!W.sky) {
    let s = 99; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
    W.sky = [];
    for (let x = -6; x < ISO.W; x += 9 + Math.floor(r() * 14)) {
      const w = 12 + Math.floor(r() * 16), h = 70 + Math.floor(r() * 240), win = [];
      for (let k = 0; k < w * h / 30; k++) if (r() < 0.3) win.push([1 + Math.floor(r() * (w - 2)), 2 + Math.floor(r() * (h - 3)), r()]);
      W.sky.push({x, w, h, win, tone: r()});
    }
  }
  for (const b of W.sky) {
    c.fillStyle = rgb(ofMix(b.tone > 0.5 ? [138, 160, 190] : [152, 172, 198], b.tone > 0.5 ? [15, 20, 48] : [19, 26, 58], n));
    c.fillRect(b.x, base - b.h, b.w, b.h + 40);
    c.fillStyle = rgb(ofMix([122, 142, 172], [12, 16, 40], n)); c.fillRect(b.x + b.w - 2, base - b.h, 2, b.h + 40);  // shaded side
    for (const [wx, wy, lit] of b.win) {
      c.fillStyle = lit < n * 0.9 ? "rgba(255,214,140,.42)" : `rgba(225,240,255,${0.35 * (1 - n)})`;
      c.fillRect(b.x + wx, base - b.h + wy, 1, 1);
    }
  }
}
function ofBeam(c) {  // the roof searchlight sweeps the sky after dark
  const W = OF.W, n = W.night;
  const on = Math.max(n > 0.3 ? n : 0, W.beamT > 0 ? Math.min(1, W.beamT) * 0.8 : 0);
  if (on > 0 && OF.W.floors[0] === "roof") {
    const [bx, by0] = P(0, 8.2, 1.0), by = by0 - 14, a = -Math.PI / 2 + Math.sin(W.t * 0.22) * 0.55, L = 520, sp = 0.07;
    const g = c.createLinearGradient(bx, by, bx + Math.cos(a) * L, by + Math.sin(a) * L);
    g.addColorStop(0, `rgba(255,248,214,${0.32 * on})`); g.addColorStop(1, "rgba(255,248,214,0)");
    c.save(); c.globalCompositeOperation = "lighter"; c.fillStyle = g; c.beginPath(); c.moveTo(bx, by);
    c.lineTo(bx + Math.cos(a - sp) * L, by + Math.sin(a - sp) * L); c.lineTo(bx + Math.cos(a + sp) * L, by + Math.sin(a + sp) * L); c.closePath(); c.fill(); c.restore();
  }
}
// the street: pavement all round, a road along the front, painted lines and a crossing
function ofGround(c) {
  const W = OF.W, n = W.night, {GI, GJ} = ISO;
  const quad = (i0, j0, i1, j1, col) => poly(c, [G(i0, j0), G(i1, j0), G(i1, j1), G(i0, j1)], col);
  const pave = ofMix([164, 158, 160], [50, 47, 62], n), road = ofMix([88, 88, 98], [24, 23, 31], n), R0 = GJ + 3.2, R1 = GJ + 7.2;
  quad(-12, -12, 60, 60, rgb(pave));
  for (let i = -12; i < 40; i += 1.5) { quad(i, -12, i + 0.05, R0, rgb(pave, -.1)); quad(i, R1, i + 0.05, 60, rgb(pave, -.1)); }
  for (let j = -12; j < R0; j += 1.5) quad(-12, j, 60, j + 0.05, rgb(pave, -.1));
  for (let j = R1 + 1.5; j < 40; j += 1.5) quad(-12, j, 60, j + 0.05, rgb(pave, -.1));
  quad(-30, R0 - 0.25, 60, R0, rgb(pave, .18)); quad(-30, R1, 60, R1 + 0.25, rgb(pave, .18));  // kerbs
  quad(-30, R0, 60, R1, rgb(road));
  for (let i = -30; i < 60; i += 2) quad(i, GJ + 5.13, i + 1.1, GJ + 5.27, rgb(ofMix([236, 210, 110], [150, 134, 80], n)));  // lane dashes
  for (let k = 0; k < 6; k++) quad(GI + 1.2 + k * 0.42, R0 + 0.2, GI + 1.42 + k * 0.42, R1 - 0.2, rgb(road, .55));  // zebra crossing
  quad(0, GJ, GI, GJ + 0.7, "rgba(0,0,0,.22)"); quad(GI, 0, GI + 0.7, GJ + 0.7, "rgba(0,0,0,.16)");  // the building's shadow at its foot
  if (n > 0) for (const [i, j] of OF_LAMPS) { const [x, y] = G(i, j); ofGlow(c, x, y, 26, "255,214,150", 0.4 * n); }
}
// ---- the neighbourhood: buildings either side, so ours isn't standing alone
// a face on the ground: side "i" runs along i at j = fix (faces the street), "j" runs along j at i = fix; heights in px above the pavement
function ofGFace(c, side, a0, a1, fix, h0, h1, fill, alpha = 1) {
  const [x, y] = side === "i" ? G(a0, fix) : G(fix, a0);
  c.save(); c.globalAlpha = alpha; c.transform(side === "i" ? ISO.T : -ISO.T, ISO.TH, 0, 1, x, y - h1);
  const w = a1 - a0, h = h1 - h0;
  if (fill instanceof HTMLImageElement) {  // a picture, cropped to fill
    const r = (w * ISO.T) / h, nw = fill.naturalWidth, nh = fill.naturalHeight;
    let sw = nw, sh = nh, sx = 0, sy = 0;
    if (nw / nh > r) { sw = nh * r; sx = (nw - sw) / 2; } else { sh = nw / r; sy = (nh - sh) / 2; }
    c.imageSmoothingEnabled = true; c.drawImage(fill, sx, sy, sw, sh, 0, 0, w, h);
  } else { c.fillStyle = fill; c.fillRect(0, 0, w, h); }
  c.restore();
}
function ofGText(c, a0, fix, h, text, font, col, glow) {  // writing on a street-facing face, left-aligned at a0, baseline h px up
  const [x, y] = G(a0, fix);
  c.save(); c.transform(1, ISO.TH / ISO.T, 0, 1, x, y - h); c.scale(0.1, 0.1);
  c.font = font.replace(/([\d.]+)px/, (_, v) => v * 10 + "px"); c.textBaseline = "alphabetic";
  if (glow) { c.shadowColor = glow; c.shadowBlur = 30; }
  c.fillStyle = col; c.fillText(text, 0, 0); c.restore();
}
// a plain block: front face (j = j1), right face (i = i1), flat roof; lit windows by night
function ofBlock(c, b) {
  const n = OF.W.night, {i0, i1, j0, j1, h} = b, col = ofMix(b.col, b.ncol || [b.col[0] * .3, b.col[1] * .3, b.col[2] * .4 + 20], n);
  const q = (i, j, hh) => { const [x, y] = G(i, j); return [x, y - hh]; };
  poly(c, [q(i0, j1, 0), q(i1, j1, 0), q(i1, j1, h), q(i0, j1, h)], rgb(col, -.08));
  poly(c, [q(i1, j0, 0), q(i1, j1, 0), q(i1, j1, h), q(i1, j0, h)], rgb(col, -.3));
  poly(c, [q(i0, j0, h), q(i1, j0, h), q(i1, j1, h), q(i0, j1, h)], rgb(col, .1));
  poly(c, [q(i0, j1, h), q(i1, j1, h), q(i1, j1, h + 2), q(i0, j1, h + 2)], rgb(col, .22));  // parapet cap
  poly(c, [q(i1, j0, h), q(i1, j1, h), q(i1, j1, h + 2), q(i1, j0, h + 2)], rgb(col, -.1));
  const glass = rgb(ofMix([150, 190, 222], [20, 26, 52], n)), lit = "#ffd98a";
  for (const [side, a0, a1, fix] of [["i", i0, i1, j1], ["j", j0, j1, i1]]) {
    const cols = Math.floor((a1 - a0 - 0.4) / (b.wx || 1.1));
    for (let z = b.base || 0, r = 0; z + 12 < h; z += b.story || 30, r++) {
      if (r === 0 && b.base) continue;
      for (let k = 0; k < cols; k++) {
        const u = a0 + 0.35 + k * (b.wx || 1.1), on = (ofHash(`${b.id}${side}${r}.${k}`) % 100) / 100 < (b.lit ?? 0.5) * n;
        ofGFace(c, side, u, u + (b.ww || 0.6), fix, z + 9, z + 9 + (b.wh || 13), on ? lit : glass);
        if (!on && n < 0.7) ofGFace(c, side, u + 0.08, u + 0.2, fix, z + 12, z + 18, `rgba(255,255,255,${0.35 * (1 - n)})`);
      }
    }
  }
}
// the neighbours hardly change, so they're drawn once into their own picture and only redrawn when the light or the posters change
function ofNeighbours(c, H) {
  const W = OF.W, ps = (W.data?.delivered || []).slice(0, 3).map(x => ofImg(x.poster) ? 1 : 0).join("");
  const key = `${H}|${Math.round(W.night * 40)}|${ps}|${W.floors.length}`;
  let N = W.nb;
  if (!N || N.key !== key) {
    N = W.nb = N || {cv: document.createElement("canvas")};
    N.key = key; N.cv.width = ISO.W * OF_RES; N.cv.height = H * OF_RES;
    const g = N.cv.getContext("2d"); g.setTransform(OF_RES, 0, 0, OF_RES, 0, 0); g.imageSmoothingEnabled = false;
    ofNeighboursDraw(g);
  }
  c.drawImage(N.cv, 0, 0, ISO.W, H);
  ofNeighboursLive(c);
}
function ofNeighboursLive(c) {  // the moving bits: the tower's warning light, the marquee's chasing bulbs
  const t = OF.W.t, [ax] = G(13, -3), j = 5.4 + 0.6;
  if (Math.floor(t * 1.2) % 2) ofGlow(c, ax - 2, 8, 6, "255,60,60", 0.8, 1);
  for (let k = 0; k < 20; k++) {
    const on = (k + Math.floor(t * 6)) % 3 === 0, [x, y] = G(19.45 + k * 0.4, j);
    c.fillStyle = on ? "#fff6c0" : "#a8803a"; c.fillRect(Math.round(x), Math.round(y) - 37, 1, 1); c.fillRect(Math.round(x), Math.round(y) - 24, 1, 1);
  }
}
function ofNeighboursDraw(c) {
  const W = OF.W, n = W.night, top = ofGY();
  // far right, behind us: a glass office tower that runs off the top of the picture
  ofBlock(c, {id: "tower", i0: 3, i1: 13, j0: -14, j1: -3, h: top + 40, col: [96, 112, 140], ncol: [26, 30, 52], story: 20, wx: 0.8, ww: 0.45, wh: 11, lit: 0.22});
  // left: an old brick walk-up with the video shop downstairs and a billboard on the roof
  const L = {id: "walkup", i0: -12, i1: -1.6, j0: -2, j1: 6.2, h: 250, col: [168, 106, 86], story: 34, base: 1, wx: 1.25, ww: 0.7, wh: 15};
  ofBlock(c, L);
  const sh = [ofMix([54, 40, 74], [20, 16, 34], n)];
  ofGFace(c, "i", -11.6, -2, L.j1, 0, 30, rgb(sh[0]));
  ofGFace(c, "i", -11.2, -5.6, L.j1, 3, 22, n > 0.3 ? "#ffd98a" : rgb(ofMix([150, 190, 222], [30, 34, 60], n)));  // shop window
  const posters = (W.data?.delivered || []).map(x => ofImg(x.poster)).filter(Boolean);
  for (let k = 0; k < 3; k++) {  // what came in lately, in the window
    const im = posters[k], u = -10.9 + k * 1.75;
    ofGFace(c, "i", u, u + 1.2, L.j1, 5, 20, im || ["#6b3b4a", "#3b5a6b", "#5a6b3b"][k]);
  }
  ofGFace(c, "i", -5.2, -3.6, L.j1, 0, 22, "#2a2236"); ofGFace(c, "i", -5.0, -3.8, L.j1, 0, 20, n > 0.3 ? "#ffcf7a" : "#4a6a8a");  // the door
  ofGFace(c, "i", -11.6, -2, L.j1, 23, 30, "#1b6fd8");
  ofGText(c, -10.6, L.j1, 24.6, "VIDEO", "bold 6px Silkscreen, monospace", "#ffd34d", n > 0.3 ? "#ffd34d" : null);
  ofGText(c, -6.3, L.j1, 24.8, "RENT · RETURN", "4px Silkscreen, monospace", "#fff", null);
  ofGFace(c, "i", -11.8, -1.8, L.j1, 30, 31.5, rgb(ofMix([120, 76, 62], [40, 30, 44], n)));
  // the billboard: a big poster for whatever came in last
  const bb = posters[0] || null, bh = L.h + 2;
  for (const u of [-9.8, -5.4]) ofGFace(c, "i", u, u + 0.2, L.j1 - 1.2, bh, bh + 14, "#2c2838");
  ofGFace(c, "i", -11.2, -4.0, L.j1 - 1.2, bh + 12, bh + 46, "#1d1a28");
  if (bb) ofGFace(c, "i", -11.0, -4.2, L.j1 - 1.2, bh + 13, bh + 45, bb);
  else { ofGFace(c, "i", -11.0, -4.2, L.j1 - 1.2, bh + 13, bh + 45, "#e0303a"); ofGText(c, -10.4, L.j1 - 1.2, bh + 26, "NOW", "bold 7px Silkscreen, monospace", "#fff"); ofGText(c, -10.4, L.j1 - 1.2, bh + 18, "SHOWING", "bold 7px Silkscreen, monospace", "#fff"); }
  if (n > 0.2) for (const u of [-10.2, -7.6, -5.0]) { const [x, y] = G(u, L.j1 - 1.2); ofGlow(c, x, y - bh - 30, 14, "255,240,200", 0.25 * n, 1); }
  // right, past the little square: the cinema, marquee and all
  const C = {id: "cinema", i0: 19, i1: 28, j0: -1, j1: 5.4, h: 74, col: [96, 54, 70], story: 30, base: 1, wx: 1.4, ww: 0.8, wh: 14};
  ofBlock(c, C);
  ofGFace(c, "i", 19.7, 28.5, C.j1, 0, 22, "#241626");
  for (let k = 0; k < 3; k++) { const u = 20.1 + k * 1.4; ofGFace(c, "i", u, u + 1.0, C.j1, 0, 18, n > 0.3 ? "#ffcf7a" : "#5a4a6a"); }  // glass doors
  const ps = (W.data?.delivered || []).slice(1).map(x => ofImg(x.poster)).filter(Boolean);
  for (let k = 0; k < 2; k++) { const u = 24.6 + k * 1.6; ofGFace(c, "i", u - 0.1, u + 1.2, C.j1, 2, 20, "#c9a24a"); ofGFace(c, "i", u, u + 1.1, C.j1, 3, 19, ps[k] || ["#3b5a6b", "#6b3b4a"][k]); }
  // the marquee, with chasing bulbs
  ofGFace(c, "i", 19.4, 28.9, C.j1 + 0.6, 24, 36, "#f2ead8"); ofGFace(c, "i", 19.6, 28.7, C.j1 + 0.6, 25, 35, "#1a1424");
  ofGText(c, 20, C.j1 + 0.6, 28.4, "NUNIPLEX", "bold 7px Silkscreen, monospace", "#ffd34d", "#ff9d2e");
  ofGFace(c, "i", 19.4, 28.9, C.j1 + 0.6, 22.5, 24, "#3a2a3a");
  if (n > 0.1) { const [x, y] = G(22.5, C.j1 + 1); ofGlow(c, x, y - 20, 26, "255,200,120", 0.35 * n); }
}

// ---- traffic: a one-way street, cars in the far lane; the delivery truck pulls in at the near kerb
const OF_CARS = {  // picture, does it need mirroring to face down the street, speed (tiles/s); race cars only come out for a race
  van: {img: "van-se", flip: true, v: 3.6}, cop: {img: "copcar-se", flip: false, v: 6.5, siren: 1},
  time: {img: "timecar-se", flip: false, v: 7.5, fire: 1}, ghost: {img: "ghostcar-se", flip: false, v: 5}, mystery: {img: "mysteryvan-se", flip: false, v: 3.4},
  charger: {img: "charger-se", flip: false, v: 11, race: 1}, supra: {img: "supra-se", flip: false, v: 11, race: 1},
  bus: {img: "bus-se", flip: false, v: 13, race: 1, jump: 1},  // (race = only when something calls it)
};
const OF_LANE = {far: ISO.GJ + 6.1, near: ISO.GJ + 4.3}, OF_TRUCK = {stop: 11.6, len: 5.4};
const ofLane = car => car.j ?? OF_LANE[car.lane || "far"];
const OF_KERB = ISO.GJ + 3.8, OF_PARK = 7.6;  // where the ghost car pulls in: the kerb in front of the dock
function ofTraffic(dt) {
  const W = OF.W, t = W.t;
  W.cars = W.cars || []; W.trails = W.trails || []; W.flashes = W.flashes || [];
  if ((W.carT = (W.carT ?? 4) - dt) <= 0) {  // now and then something drives by
    W.carT = 9 + Math.random() * 14;
    const ks = Object.keys(OF_CARS).filter(k => !OF_CARS[k].race && (ofPropImg(OF_CARS[k].img) || k === "van")), k = ks[Math.floor(Math.random() * ks.length)];
    if (k === "ghost" && Math.random() < 0.5) ofGhostCar();
    else W.cars.push({k, i: -16, warp: k === "time" && Math.random() < 0.35});
    if (k === "time" && Math.random() < 0.4 && ofPropImg("copcar-se")) W.cars.push({k: "cop", i: -24, v: 7.5});  // in hot pursuit
  }
  if ((W.raceT = (W.raceT ?? 150 + Math.random() * 150) - dt) <= 0) { W.raceT = 240 + Math.random() * 240; ofRace(); }  // a street race every few minutes
  if (W.light) { W.light.t += dt; if (W.light.t > 2 && !W.light.go) { W.light.go = 1; ofRaceStart(); } if (W.light.t > 6) W.light = null; }
  for (const car of W.cars) if (car.script) ofPullOver(car, dt);
  for (const car of W.cars) {
    if (car.script) continue;
    const o = OF_CARS[car.k];
    car.i += dt * (car.v || o.v) * (o.race ? 1 + 0.12 * Math.sin(t * 1.7 + (car.lane === "near" ? 0 : 2)) : 1);  // neck and neck
    if (o.fire && car.i > 2 && car.i < 30) W.trails.push({i: car.i - 1.6, j: ofLane(car), t: 1.6});
    if (o.jump && car.i > 14.9 && car.i < 15.6) for (let k = 0; k < 6; k++) W.trails.push({i: car.i - k * 0.3, j: ofLane(car), t: 1.2, smoke: 1});  // the landing
    if (o.race && !o.jump && car.i > -6 && car.i < 30 && Math.random() < 0.5) W.trails.push({i: car.i - 1.7, j: ofLane(car), t: 0.8, smoke: 1});
    if (car.warp && car.i > 15) { W.flashes.push({i: car.i, j: ofLane(car), t: 0.8}); car.gone = true; }  // ... and it's gone, back to wherever it came from
  }
  W.cars = W.cars.filter(car => car.i < 38 && !car.gone);
  W.trails = W.trails.filter(f => (f.t -= dt) > 0);
  W.flashes = W.flashes.filter(f => (f.t -= dt) > 0);
  for (const k of ["beamT", "flickT", "boltT"]) if (W[k] > 0) W[k] -= dt;
  if (W.hover?.ride) { const h = W.hover, was = h.i; h.i += dt * 6; if (h.i > 34) h.i = -10; if (was < OF_HOVER[0] && h.i >= OF_HOVER[0]) W.hover = null; }  // round the block and back
  if (W.balloons) W.balloons = W.balloons.filter(b => (b.t += dt) < 9);
  for (const k of ["ringT", "monoT"]) if (W[k] > 0) W[k] -= dt;
  if (W.ghostFx) { W.ghostFx.t += dt; if (W.ghostFx.t > 5) W.ghostFx = null; }
  // the truck: one trip per finished download, a stop out front while it's unloaded
  const T = W.truck;
  if (!T && W.truckQ?.length && !W.cars.some(c => c.script && c.script !== "go")) W.truck = {...W.truckQ.shift(), i: -14, wait: 0, done: false};
  else if (T) {
    if (T.wait > 0) { T.wait -= dt; if (T.wait <= 0) T.done = true; }
    else {
      const was = T.i, v = T.done || T.i < OF_TRUCK.stop - 3 ? 4 : Math.max(0.6, (OF_TRUCK.stop - T.i) * 1.4);
      T.i += dt * v;
      if (!T.done && was < OF_TRUCK.stop && T.i >= OF_TRUCK.stop - 0.02) { T.i = OF_TRUCK.stop; T.wait = 7; ofTruckUnload(T); }
      if (T.i > 40) W.truck = null;
    }
  }
}
function ofPullOver(car, dt) {
  const W = OF.W, far = OF_LANE.far, ease = x => x * x * (3 - 2 * x), pi = car.i, pj = ofLane(car);
  car.j = car.j ?? far;
  if (car.script === "in") { car.i += dt * 7; if (car.i >= OF_PARK - 4.6) { car.script = "swerve"; car.s = 0; } }
  else if (car.script === "swerve") {  // brakes and cuts across to the kerb
    car.s = Math.min(1, car.s + dt / 1.3); const e = 1 - (1 - car.s) ** 2;
    car.i = OF_PARK - 4.6 + 4.6 * e; car.j = far + (OF_KERB - far) * ease(car.s);
    if (Math.random() < 0.6) W.trails.push({i: car.i - 1.4, j: car.j, t: 0.9, smoke: 1});
    if (car.s >= 1) { car.script = "park"; car.wait = 8; car.face = "se"; }
  } else if (car.script === "park") { car.face = "se"; if ((car.wait -= dt) <= 0) { car.script = "out"; car.s = 0; } }
  else if (car.script === "out") {  // indicates, pulls back out into the lane
    car.s = Math.min(1, car.s + dt / 1.6); const e = car.s * car.s;
    car.i = OF_PARK + 4.2 * e; car.j = OF_KERB + (far - OF_KERB) * ease(car.s);
    if (car.s >= 1) { car.script = "go"; car.v = 2.6; }
  } else { car.v = Math.min(6, car.v + dt * 3); car.i += dt * car.v; }
  const di = car.i - pi, dj = car.j - pj;  // which way it's pointing: along the road, nosing in to the kerb, or out
  if (car.script !== "park" && Math.abs(di) + Math.abs(dj) > 1e-4) car.face = dj / Math.max(1e-4, di) < -0.32 ? "e" : dj / Math.max(1e-4, di) > 0.32 ? "s" : "se";
}
// a race: the light at the crossing counts down, then the two of them go side by side (the near lane too, unless the truck's in it)
function ofGhostCar() {
  const W = OF.W;
  if (W.cars.some(c => c.script)) return;
  W.cars.push(W.truck ? {k: "ghost", i: -16, v: 7, siren: 1} : {k: "ghost", i: -16, siren: 1, script: "in"});
}
function ofRace() { const W = OF.W; if (!W.light && !W.cars.some(c => OF_CARS[c.k].race)) W.light = {t: 0}; }
function ofRaceStart() {
  const W = OF.W, near = !W.truck;
  W.cars.push({k: "charger", i: -15, lane: near ? "near" : "far"}, {k: "supra", i: near ? -15 : -21, lane: "far"});
}
// props that do something when tapped (the card says what happened)
const OF_FX = {
  "street-clock": () => { const W = OF.W; W.cars.push({k: "time", i: -1, v: 8, warp: true}); W.flashes.push({i: -1, j: OF_LANE.far, t: 0.8}); },
  "traffic-light": () => ofRace(),
  busstop: () => { const W = OF.W; if (!W.cars.some(c => c.k === "bus")) W.cars.push({k: "bus", i: -18}); },
  "proton-pack": () => { const W = OF.W; W.ghostFx = {t: 0}; ofGhostCar(); },
  puzzlebox: (w) => { const W = OF.W; W.flickT = 3.5; W.flickFk = w.fk; },
  searchlight: () => { OF.W.beamT = 25; },
  hoverboard: () => { const W = OF.W; if (!W.hover?.ride) W.hover = {i: OF_HOVER[0], ride: 1}; },
  "balloon-drain": () => { const W = OF.W; (W.balloons = W.balloons || []).push({t: 0, s: Math.random() * 6}); },
  ring: (w) => { const W = OF.W; W.ringT = 4; W.ringFk = w.fk; },
  monolith: () => {  // it hums; the cats go and sit with it
    const W = OF.W; W.monoT = 9;
    [...W.agents.values()].filter(a => a.role === "cat").forEach((a, k) => { a.asleep = false; a.idleT = 9; ofGo(a, "roof", 3.6 + k * 0.7, 1.5 + k * 0.3, [{wait: 5}]); });
  },
  "robot-arm": () => { OF.W.boltT = 2.2; },
};
const OF_FX_TEXT = {
  "street-clock": ["The old clock", "Right on the second. Something's coming through from another time."],
  "traffic-light": ["The lights", "Two cars at the line, engines up. Green means go."],
  busstop: ["The bus stop", "Here it comes. It isn't stopping. It can't slow down."],
  "proton-pack": ["The pack", "Something got loose. The cleanup crew is pulling up out front."],
  puzzlebox: ["The puzzle box", "You solved it. Something on the other side noticed."],
  searchlight: ["Searchlight", "Switched on for a bit."],
  hoverboard: ["Hoverboard", "Off for a lap of the block. It'll be back."],
  "balloon-drain": ["The drain", "Another red balloon drifts up out of it."],
  ring: ["The ring", "It glows, and the room goes dim for a moment."],
  monolith: ["The monolith", "It hums. The cats go up to sit with it."],
  "robot-arm": ["The arm in the case", "Something just arrived out front in a ball of lightning."],
};
const ofFxHit = (x, y, n, extra) => { if (OF_FX[n]) OF.W.hits.push({x0: x - 7, x1: x + 7, y0: y - 22, y1: y + 1, what: {fx: n, ...extra}}); };
function ofCarsDraw(c, items) {
  const W = OF.W, n = W.night;
  for (const f of W.trails) items.push({d: f.j - 0.5 + f.i * 0.01, draw: () => {
    const a = Math.min(1, f.t), [x1, y1] = G(f.i, f.j - 0.35), [x2, y2] = G(f.i, f.j + 0.35);
    if (f.smoke) {  // tyre smoke
      c.fillStyle = `rgba(210,210,220,${0.35 * a})`; const r = Math.round(3 - a * 2);
      c.fillRect(Math.round(x1) - r, Math.round(y1) - r - 1, r * 2 + 1, r + 1); c.fillRect(Math.round(x2) - r, Math.round(y2) - r - 1, r * 2 + 1, r + 1);
      return;
    }
    c.fillStyle = `rgba(255,${120 + Math.round(100 * a)},40,${0.85 * a})`; c.fillRect(Math.round(x1), Math.round(y1), 2, 1); c.fillRect(Math.round(x2), Math.round(y2), 2, 1);
    if (a > 0.6) ofGlow(c, x1, y1, 4, "255,160,60", 0.3 * a, 1);
  }});
  for (const f of W.flashes) items.push({d: f.j + 1 + f.i * 0.01, draw: () => {  // a crack of light and a few sparks
    const [x, y] = G(f.i, f.j), a = Math.min(1, f.t / 0.5);
    ofGlow(c, x, y - 8, 34 * (1.2 - a * 0.4), "190,220,255", 0.9 * a);
    c.fillStyle = `rgba(230,245,255,${a})`;
    for (let k = 0; k < 5; k++) { const ang = k * 1.3 + f.t * 9, L = 6 + (k % 3) * 4; for (let s = 0; s < L; s += 2) c.fillRect(Math.round(x + Math.cos(ang) * s), Math.round(y - 8 + Math.sin(ang) * s * 0.6), 1, 1); }
  }});
  for (const car of W.cars) { const j = ofLane(car); items.push({d: j + car.i * 0.01, draw: () => {
    const o = OF_CARS[car.k], [x, y] = G(car.i, j), img = car.face && car.face !== "se" && ofPropImg(`ghostcar-${car.face}`) ? `ghostcar-${car.face}` : o.img;
    const lift = o.jump && car.i > 9 && car.i < 15 ? Math.round(Math.sin((car.i - 9) / 6 * Math.PI) * 10) : 0;  // airborne over the crossing
    if (lift) { c.fillStyle = "rgba(0,0,0,.25)"; c.fillRect(Math.round(x) - 14, Math.round(y) + 2, 28, 2); }
    if (ofPropImg(img)) ofPropDraw(c, x, y + 4 - lift + (o.jump && !lift ? Math.round(Math.random()) : 0), img, img === o.img && o.flip);
    else { const L = W.floors.length - 1; ofBox(c, L, car.i - 1.6, j - 0.5, 3.2, 1.0, 11, [236, 236, 242], -ISO.SLAB); ofBox(c, L, car.i - 1.6, j - 0.5, 3.2, 0.06, 2, [224, 48, 58], -ISO.SLAB + 5); }
    if (o.siren || car.siren) { const r = Math.floor(W.t * 8) % 2; ofGlow(c, x + (r ? -3 : 3), y - 18, 10, r ? "255,40,60" : "60,110,255", 0.7, 1); }
    if (n > 0.3) ofGlow(c, x + 16, y + 6, 14, "255,240,200", 0.35 * n);
    W.hits.push({x0: x - 16, x1: x + 16, y0: y - 20, y1: y + 4, what: {car: car.k}});
  }}); }
  { const hv = W.hover, i = hv ? hv.i : OF_HOVER[0], j = hv ? ISO.GJ + 2.3 : OF_HOVER[1]; items.push({d: j + i * 0.01, draw: () => {
    const [x, y0] = G(i, j), bob = Math.round(Math.sin(W.t * 3) * 1.2) - (hv ? 3 : 0);
    ofGlow(c, x, y0, 7, "160,255,210", 0.3, 1);
    if (ofPropImg("hoverboard-float")) ofPropDraw(c, x, y0 + bob, "hoverboard-float", true);  // (the picture lies across the road; mirrored it lies along it)
    if (!hv) ofFxHit(x, y0, "hoverboard");
  }}); }
  for (const bl of W.balloons || []) { const j = 8.85, i = 3.1; items.push({d: 99, draw: () => {  // up and away
    const [x, y] = G(i, j), a = Math.min(1, (9 - bl.t) / 2);
    c.save(); c.globalAlpha = a; ofPropDraw(c, x + Math.sin(bl.t * 1.3 + bl.s) * 4 + bl.t * 2, y - 8 - bl.t * 34, "red-balloon"); c.restore();
  }}); }
  if (W.boltT > 0) { const j = ISO.GJ + 2.2, i = 6.5; items.push({d: j + i * 0.01, draw: () => {  // a ball of lightning on the pavement
    const [x, y] = G(i, j), a = Math.min(1, W.boltT / 1.2), r = 10 + Math.sin(W.t * 30) * 2;
    ofGlow(c, x, y - 9, r * 2.4, "140,190,255", 0.8 * a);
    c.fillStyle = `rgba(235,245,255,${a})`;
    for (let k = 0; k < 7; k++) { const ang = Math.random() * 6.3, L = r * (0.6 + Math.random() * 0.6); for (let s = 0; s < L; s += 1.5) c.fillRect(Math.round(x + Math.cos(ang) * s + (Math.random() - 0.5) * 2), Math.round(y - 9 + Math.sin(ang) * s), 1, 1); }
  }}); }
}
function ofFxDraw(c) {  // effects over the building: the ghost getting away over the roof, the traffic light's countdown
  const W = OF.W;
  if (W.ghostFx && ofPropImg("ghost")) {
    const g = W.ghostFx, [x, y] = P(W.floors.length - 1, 1.2 + Math.sin(g.t * 2) * 0.8, 5.2);
    c.save(); c.globalAlpha = Math.max(0, Math.min(1, 2.5 - g.t * 0.5)); ofPropDraw(c, x + g.t * 8, y - g.t * 60, "ghost"); c.restore();
  }
  if (W.light) {
    const [i, j] = OF_LIGHT, [x, y] = G(i, j), s = W.light.go ? 2 : W.light.t > 1 ? 1 : 0, col = ["255,60,60", "255,200,60", "80,255,120"][s];
    ofGlow(c, x, y - 21 + s * 2.5, 6, col, 0.9, 1);
  }
}
function ofTruckUnload(T) {  // a porter takes the box off the truck, in through the dock and up to the Delivered shelf
  const W = OF.W, p = ofAgent("port:" + T.key + Date.now(), {fk: "dock", i: 6.2, j: 5.6, role: "porter", carry: "box", hue: 32, fade: true});
  ofGo(p, "mail", 7.8, 1.3, [{wait: 0.5}, {fn: b => { b.carry = null; W.fx.push({fk: "mail", i: 7.8, j: 0.3, t: 1.4, kind: "spark"}); ofExit(b, "mail"); }}]);
}
function ofTruckDraw(c, T) {
  const W = OF.W, n = W.night, j = OF_LANE.near, L = W.floors.length - 1, Z = -ISO.SLAB;
  const cab = T.i, t1 = cab - 1.7, t0 = t1 - OF_TRUCK.len, j0 = j - 0.6, j1 = j + 0.6;
  // trailer: outlined like the pixel art, ribbed, wrapped in the movie's poster
  const ink = [24, 20, 34], body = ofMix([226, 228, 234], [92, 92, 112], n * 0.6), H = 15, z0 = Z + 4;
  ofBox(c, L, t0 - 0.12, j0 - 0.12, OF_TRUCK.len + 0.24, j1 - j0 + 0.24, H + 1.5, ink, z0 - 0.75, rgb(ink));
  ofBox(c, L, t0, j0, OF_TRUCK.len, j1 - j0, H, body, z0);
  for (let u = t0 + 0.5; u < t1 - 0.2; u += 0.5) ofBox(c, L, u, j0, 0.06, j1 - j0, 0.6, [170, 172, 184], z0 + H);  // roof ribs
  for (const u of [t0 + 0.4, t0 + 1.1, t1 - 0.7]) {  // wheels, under-run bar
    ofBox(c, L, u, j1 - 0.12, 0.55, 0.12, 4.5, ink, Z); ofBox(c, L, u + 0.18, j1 - 0.01, 0.2, 0.02, 1.4, [150, 150, 160], Z + 1.5);
  }
  ofBox(c, L, t1 - 2.6, j1 - 0.1, 0.1, 0.1, 4, [70, 70, 80], Z);  // landing leg
  const im = ofImg(T.poster), Lw = (u0, u1, z0_, z1_, f) => ofWall(c, L, "r", u0, u1, z0_ + Z, z1_ + Z, f, 1, null, j1);
  Lw(t0 + 0.1, t1 - 0.1, 5, 4 + H - 1, rgb(ofMix([30, 24, 52], [14, 12, 28], n)));
  const pw = 1.2, cnt = Math.floor((OF_TRUCK.len - 0.3) / pw), pad = (OF_TRUCK.len - cnt * pw) / 2;
  for (let k = 0; k < cnt; k++) { const u = t0 + pad + k * pw; Lw(u + 0.08, u + pw - 0.08, 6, 4 + H - 2, im || ["#e0303a", "#ffd34d"][k % 2]); }
  Lw(t0, t0 + 0.08, 4, 4 + H, rgb(ink)); Lw(t1 - 0.08, t1, 4, 4 + H, rgb(ink));
  if (n > 0.3) for (let k = 0; k < cnt; k++) { const [x, y] = P(L, t0 + pad + (k + 0.5) * pw, j1); ofGlow(c, x, y + Z - 12, 7, "255,240,210", 0.12 * n, 1); }
  // the cab
  const [x, y] = G(cab, j), e = ofPropImg("truck-se");
  if (e) ofPropDraw(c, x, y + 3, "truck-se", OF_TRUCK.flip);
  else { ofBox(c, L, cab - 1.6, j0, 2.4, j1 - j0, 16, [200, 48, 58], Z + 3); ofBox(c, L, cab + 0.2, j0 + 0.1, 0.6, j1 - j0 - 0.2, 4, [160, 200, 230], Z + 13); }
  if (n > 0.3) ofGlow(c, x + 14, y + 6, 16, "255,240,200", 0.4 * n);
  W.hits.push({x0: P(L, t0, j1)[0] - 4, x1: x + 18, y0: y - 34, y1: y + 6, what: {truck: 1}});
}
function ofStreet(c) {  // depth order out here is mostly by row (j), then along the street (i)
  const W = OF.W, n = W.night, {GJ} = ISO, items = [], d = (i, j) => j + i * 0.01;
  for (const [nm, i, j, flip] of STREET_PROPS) items.push({d: d(i, j), draw: () => {
    const [x, y] = G(i, j);
    if (nm === "streetlamp" && !ofPropImg(nm)) {  // drawn by hand until the art is in
      c.fillStyle = "#3a3550"; c.fillRect(Math.round(x), Math.round(y) - 24, 1, 24); c.fillRect(Math.round(x) - 1, Math.round(y) - 1, 3, 1);
      c.fillStyle = n > 0.3 ? "#ffe6a8" : "#cfd6e0"; c.fillRect(Math.round(x) - 1, Math.round(y) - 27, 3, 3);
    } else ofPropDraw(c, x, y, nm, flip);
    ofFxHit(x, y, nm);
    if (nm === "streetlamp" && n > 0) ofGlow(c, x, y - (OF_LAMP_H || 25), 9, "255,226,160", 0.5 * n, 1);
  }});
  for (const [nm, i, j = GJ + 1.6] of OF_SEASON.street || []) items.push({d: d(i, j), draw: () => { const [x, y] = G(i, j); ofPropDraw(c, x, y, nm); }});
  ofCarsDraw(c, items);
  if (W.truck) { const T = W.truck; items.push({d: OF_LANE.near + T.i * 0.01, draw: () => ofTruckDraw(c, T)}); }
  items.sort((a, b) => a.d - b.d).forEach(o => o.draw());
  ofFxDraw(c);
}
// between floors: the room below's walls carry on up to the slab overhead (it's all inside), with the outer walls'
// cut ends in brick at each corner, so the building reads as one block with its front taken off
const ofBrick = n => ofMix([150, 92, 78], [54, 42, 60], n);
function ofShell(c, fi) {
  const {GI, GJ, WALL, BAND, SLAB} = ISO, W = OF.W, n = W.night, dn = BAND - WALL, type = ofType(W.floors[fi + 1] || "mail");
  const pal = PAL[type] || PAL.mail, dim = ({watch: 0.34, dock: 0.3, search: 0.26, mail: 0.16}[type] || 0.2) * n;
  const sh = col => ofMix(col.map(v => v * 0.86), [10, 10, 34], dim);  // a little darker up here, and dimmed with the room at night
  ofWall(c, fi, "r", 0, GI, -dn, 0, rgb(sh(pal.r))); ofWall(c, fi, "l", 0, GJ, -dn, 0, rgb(sh(pal.l)));
  ofWall(c, fi, "r", 0, GI, -dn, -dn + 1, rgb(sh(pal.r), .18)); ofWall(c, fi, "l", 0, GJ, -dn, -dn + 1, rgb(sh(pal.l), .18));  // picture rail
  ofWall(c, fi, "r", 0, GI, -SLAB - 3, -SLAB, "rgba(0,0,0,.18)"); ofWall(c, fi, "l", 0, GJ, -SLAB - 3, -SLAB, "rgba(0,0,0,.18)");  // shadow under the ceiling
  const slab = rgb(ofMix([176, 168, 186], [61, 56, 87], n), -.15);
  ofWall(c, fi, "r", 0, GI, -SLAB, 0, slab); ofWall(c, fi, "l", 0, GJ, -SLAB, 0, slab);
  ofCorners(c, fi, -dn, 0);
}
function ofCorners(c, fi, h0, h1) {  // the outer walls, cut through at the building's two side corners
  const {GI, GJ} = ISO, br = ofBrick(OF.W.night);
  ofWall(c, fi, "r", GI - 0.4, GI, h0, h1, rgb(br, -.25)); ofWall(c, fi, "l", GJ - 0.4, GJ, h0, h1, rgb(br, -.1));
  for (let h = h0 + 2; h < h1; h += 3) { ofWall(c, fi, "r", GI - 0.4, GI, h, h + 0.5, rgb(br, -.45)); ofWall(c, fi, "l", GJ - 0.4, GJ, h, h + 0.5, rgb(br, -.3)); }
}
function ofFloor(c, k, fi) {
  const W = OF.W, type = ofType(k), {GI, GJ, WALL} = ISO, n = W.night, roof = type === "roof";
  const q = (i, j, h = 0) => { const [x, y] = P(fi, i, j); return [x, y - h]; };
  if (fi < W.floors.length - 1) ofShell(c, fi);  // the building's sides run down behind the floor to the room below
  const list = [], post = [];
  W.glows = [];
  if (roof) ofRoofDeck(c, k, fi, list, post);
  else {
    const pal = PAL[type];
    poly(c, [q(0, 0, WALL), q(GI, 0, WALL), q(GI, 0), q(0, 0)], rgb(pal.r));
    poly(c, [q(0, 0, WALL), q(0, 0), q(0, GJ), q(0, GJ, WALL)], rgb(pal.l));
    poly(c, [q(0, GJ, WALL), q(0, 0, WALL), q(GI, 0, WALL), q(GI, 0, WALL + 2), q(0, 0, WALL + 2), q(0, GJ, WALL + 2)], "#5a536f");
    ofSurfaces(c, fi, type, pal);
    ofCorners(c, fi, 0, WALL + 2);
  }
  // the floor's edge: a stone band, the ground floor's a little heavier
  const sl = ofMix([176, 168, 186], [61, 56, 87], n), sr = ofMix([140, 132, 152], [42, 38, 64], n);
  poly(c, [q(0, GJ), q(GI, GJ), q(GI, GJ, -ISO.SLAB), q(0, GJ, -ISO.SLAB)], rgb(sl));
  poly(c, [q(GI, 0), q(GI, GJ), q(GI, GJ, -ISO.SLAB), q(GI, 0, -ISO.SLAB)], rgb(sr));
  poly(c, [q(0, GJ), q(GI, GJ), q(GI, GJ, -1), q(0, GJ, -1)], rgb(sl, .2)); poly(c, [q(GI, 0), q(GI, GJ), q(GI, GJ, -1), q(GI, 0, -1)], rgb(sr, .2));
  if (fi === W.floors.length - 1) { poly(c, [q(0, GJ, -4), q(GI, GJ, -4), q(GI, GJ, -6), q(0, GJ, -6)], rgb(sl, -.25)); poly(c, [q(GI, 0, -4), q(GI, GJ, -4), q(GI, GJ, -6), q(GI, 0, -6)], rgb(sr, -.25)); }
  if (!roof) {  // the elevator, same spot on every floor
    const open = !!W.doors[k];
    ofWall(c, fi, "r", 10.55, 11.85, 0, 22, "#8a90a6");
    ofWall(c, fi, "r", 10.7, 11.7, 0, 20, open ? "#0d0b16" : "#b9bfd0");
    if (!open) ofWall(c, fi, "r", 11.17, 11.23, 0, 20, "#7c8296");
    ofWall(c, fi, "r", 10.95, 11.45, 23, 26, open ? "#ffd34d" : "#3a3550");
    ({watch: ofWatch, dock: ofDock, search: ofSearch, mail: ofMail})[type](c, k, fi, list, post);
  }
  ofProps(c, fi, type, list, k);
  for (const a of W.agents.values()) if (a.fk === k && !a.hidden)  // (someone sitting on a couch sorts just behind it, so its back always hides their legs)
    list.push({pt: true, i: a.i, j: a.role === "viewer" && a.pose === "sit" ? a.j - 0.6 : a.j, draw: () => ofPerson(c, fi, a)});
  for (const f of W.fx) if (f.fk === k) list.push({pt: true, i: f.i, j: f.j + 0.5, draw: () => ofFx(c, fi, f)});
  list.sort(ofCmp).forEach(o => o.draw());
  if (n > 0 && !roof) {  // after hours: the room lights go down, lamps and screens stay on
    const dim = {watch: 0.34, dock: 0.3, search: 0.26, mail: 0.16}[type] * n;
    poly(c, [q(0, GJ, WALL + 2), q(0, 0, WALL + 2), q(GI, 0, WALL + 2), q(GI, 0), q(GI, GJ), q(0, GJ)], `rgba(10,10,34,${dim})`);
    for (const g of W.glows) { const [x, y] = q(g.i, g.j, g.h || 0); ofGlow(c, x, y, g.r, g.col, g.a * n, g.flat ?? 0.5); }
  }
  if (W.ringT > 0 && W.ringFk === k) {
    const f = Math.min(1, W.ringT / 1, (4 - W.ringT) / 0.6);
    poly(c, [q(0, GJ, WALL + 2), q(0, 0, WALL + 2), q(GI, 0, WALL + 2), q(GI, 0), q(GI, GJ), q(0, GJ)], `rgba(4,2,12,${0.5 * f})`);
    const [rx, ry] = q(5.05, 4.6, 6); ofGlow(c, rx, ry, 22, "255,200,90", 0.8 * f);
  }
  if (W.monoT > 0 && roof) { const f = Math.min(1, W.monoT / 1.5), [mx, my] = q(3.0, 0.6, 14); ofGlow(c, mx, my, 30 + Math.sin(W.t * 6) * 4, "180,200,255", 0.45 * f); }
  if (W.flickT > 0 && W.flickFk === k && Math.random() < 0.7)  // the puzzle box was opened: the room flickers red
    poly(c, [q(0, GJ, WALL + 2), q(0, 0, WALL + 2), q(GI, 0, WALL + 2), q(GI, 0), q(GI, GJ), q(0, GJ)], `rgba(150,0,20,${0.15 + Math.random() * 0.25})`);
  if (W.flickT > 0 && W.flickFk === k) {  // ... and hooked chains come down from the ceiling, then pull back up
    const e = 3.5 - W.flickT, drop = Math.min(1, e / 0.6, W.flickT / 0.6);
    for (const [ci, cj, cl] of [[1.6, 2.2, 1], [3.9, 4.6, 0.8], [6.2, 2.0, 1.1], [8.4, 4.2, 0.9], [9.7, 1.4, 0.7]]) {
      const [x, y] = q(ci, cj, 0), top = y - ISO.WALL - 14, L = (ISO.WALL + 2) * cl * drop, sw = Math.round(Math.sin(W.t * 3 + ci) * 1.5);
      for (let s = 0; s < L; s += 2) { c.fillStyle = s % 4 ? "#5a5560" : "#8a8590"; c.fillRect(Math.round(x) + Math.round(sw * s / L), Math.round(top + s), 1, 2); }
      const hx = Math.round(x) + sw, hy = Math.round(top + L);
      c.fillStyle = "#b8b4c0"; c.fillRect(hx, hy, 1, 3); c.fillRect(hx - 2, hy + 3, 3, 1); c.fillRect(hx - 2, hy + 1, 1, 2);
    }
  }
  post.forEach(f => f());
  if (roof) ofRoofFront(c, fi);
}
// the roof: a tar-and-gravel deck behind a parapet, the sign, the lift housing, somewhere to sit
function ofRoofDeck(c, k, fi, list, post) {
  const W = OF.W, n = W.night, {GI, GJ} = ISO, top = ISO.RTOP, q = (i, j, h = 0) => { const [x, y] = P(fi, i, j); return [x, y - h]; };
  const deck = ofMix([132, 128, 138], [52, 50, 66], n), par = ofMix([176, 150, 140], [70, 58, 80], n);
  ofWall(c, fi, "r", 0, GI, 0, top, rgb(par)); ofWall(c, fi, "l", 0, GJ, 0, top, rgb(par, -.15));
  ofTilePoly(c, fi, 0, 0, GI, GJ, rgb(deck));
  for (let i = 2; i < GI; i += 2) ofTilePoly(c, fi, i - 0.03, 0, i + 0.03, GJ, rgb(deck, -.14));  // membrane seams
  for (let p = 0; p < 90; p++) { const h = ofHash("g" + p), [x, y] = P(fi, (h % 1200) / 100, ((h >> 11) % 600) / 100); c.fillStyle = rgb(deck, (h >> 5) % 2 ? .12 : -.12); c.fillRect(Math.round(x), Math.round(y), 1, 1); }
  poly(c, [q(0, GJ, top), q(0, 0, top), q(GI, 0, top), q(GI, 0, top + 1), q(0, 0, top + 1), q(0, GJ, top + 1)], rgb(par, .25));  // coping
  // the sign: posts and a dark board standing on the back parapet (its neon letters are HTML, see ofLabels)
  ofWall(c, fi, "r", 3.6, 3.75, top, top + 6, "#4a4466"); ofWall(c, fi, "r", 8.5, 8.65, top, top + 6, "#4a4466");
  ofWall(c, fi, "r", 2.6, 9.6, top + 5, top + 23, "#2a2440"); ofWall(c, fi, "r", 2.7, 9.5, top + 6, top + 22, "#0e0b19");
  if (n > 0) { const [x, y] = P(fi, 6.1, 0); ofGlow(c, x, y - top - 14, 40, "255,80,110", 0.16 * n, 0.6); }
  // the stair and lift housing, with the antenna on top
  const open = !!W.doors[k];
  list.push(ofBoxD(c, fi, 10.25, 0, 1.85, 0.5, 26, ofMix([170, 160, 170], [84, 78, 104], n), 0, null, () => {
    poly(c, [q(10.7, 0.5, 0), q(11.7, 0.5, 0), q(11.7, 0.5, 20), q(10.7, 0.5, 20)], open ? "#0d0b16" : "#9aa0b4");
    if (!open) poly(c, [q(11.17, 0.5, 0), q(11.23, 0.5, 0), q(11.23, 0.5, 20), q(11.17, 0.5, 20)], "#7c8296");
    const [ax, ay] = q(11.2, 0.25, 26); c.fillStyle = "#8890b0";
    c.fillRect(Math.round(ax), Math.round(ay) - 22, 1, 22); c.fillRect(Math.round(ax) - 2, Math.round(ay) - 15, 5, 1); c.fillRect(Math.round(ax) - 3, Math.round(ay) - 8, 7, 1);
    if (Math.floor(W.t * 1.2) % 2 === 0) { c.fillStyle = "rgba(255,59,59,.3)"; c.fillRect(Math.round(ax) - 3, Math.round(ay) - 27, 7, 7); c.fillStyle = "#ff3b3b"; c.fillRect(Math.round(ax) - 1, Math.round(ay) - 25, 3, 3); }
  }));
  if (!ofPropImg("water-tower")) {  // the old hand-drawn water tower, until the art is in
    list.push({pt: true, i: 2.1, j: 2.1, draw: () => {
      const [wx, wy] = q(1.2, 1.2, 0);
      c.fillStyle = "#3d3857"; c.fillRect(wx - 7, wy - 10, 1, 10); c.fillRect(wx + 6, wy - 10, 1, 10); c.fillRect(wx - 7, wy - 6, 14, 1);
      c.fillStyle = "#6b4a3a"; c.fillRect(wx - 8, wy - 24, 16, 14); c.fillStyle = "#57392c"; for (let s = 0; s < 4; s++) c.fillRect(wx - 8, wy - 21 + s * 3, 16, 1);
      c.fillStyle = "#4a3428"; c.fillRect(wx - 9, wy - 26, 18, 2); c.fillRect(wx - 6, wy - 28, 12, 2);
    }});
  }
  // string lights over the seats, on two poles
  const pa = [3.6, 5.2], pb = [10.0, 5.2], PH = 23;
  for (const [i, j] of [pa, pb]) list.push({pt: true, i, j, draw: () => { const [x, y] = q(i, j); c.fillStyle = "#4a4466"; c.fillRect(Math.round(x), Math.round(y) - PH, 1, PH); }});
  post.push(() => {
    const [x0, y0] = q(pa[0], pa[1], PH), [x1, y1] = q(pb[0], pb[1], PH), [x2, y2] = q(10.25, 0.5, 24);
    const string = (ax, ay, bx, by, sag, m) => {
      c.fillStyle = "#2a2440";
      for (let s = 0; s <= 40; s++) { const t = s / 40; c.fillRect(Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t + Math.sin(t * Math.PI) * sag), 1, 1); }
      for (let b = 1; b < m; b++) {
        const t = b / m, x = Math.round(ax + (bx - ax) * t), y = Math.round(ay + (by - ay) * t + Math.sin(t * Math.PI) * sag) + 1;
        const col = ["255,214,120", "255,120,140", "140,220,255", "170,255,150"][b % 4];
        c.fillStyle = n > 0.3 ? `rgb(${col})` : `rgba(${col},.55)`; c.fillRect(x, y, 1, 1);
        if (n > 0.3) ofGlow(c, x + 0.5, y + 0.5, 4, col, 0.35 * n, 1);
      }
    };
    string(x0, y0, x1, y1, 5, 12); string(x1, y1, x2, y2, 3, 6);
  });
}
function ofRoofFront(c, fi) {  // the low wall along the roof's front edges, in front of everything up there
  const n = OF.W.night, {GI, GJ} = ISO, h = 4, q = (i, j, z = 0) => { const [x, y] = P(fi, i, j); return [x, y - z]; };
  const par = ofMix([176, 150, 140], [70, 58, 80], n);
  poly(c, [q(0, GJ), q(GI, GJ), q(GI, GJ, h), q(0, GJ, h)], rgb(par, -.05)); poly(c, [q(GI, 0), q(GI, GJ), q(GI, GJ, h), q(GI, 0, h)], rgb(par, -.25));
  poly(c, [q(0, GJ, h), q(GI, GJ, h), q(GI, 0, h), q(GI, 0, h + 1), q(GI, GJ, h + 1), q(0, GJ, h + 1)], rgb(par, .25));
}
function ofFx(c, fi, f) {
  const [x, y] = P(fi, f.i, f.j), k = 1 - f.t;
  for (let n = 0; n < 6; n++) {
    const ang = n / 6 * Math.PI * 2 + k, r = 3 + k * 8;
    c.fillStyle = f.kind === "spark" ? (n % 2 ? "#ffd34d" : "#3ddc84") : "rgba(230,215,180,.8)";
    c.globalAlpha = Math.max(0, f.t); c.fillRect(Math.round(x + Math.cos(ang) * r), Math.round(y - 14 + Math.sin(ang) * r * 0.6), 1, 1);
  }
  c.globalAlpha = 1;
}

function ofWatch(c, k, fi, list, post) {
  const W = OF.W, n = +k.slice(1);
  // a window on the short wall: sky by day, the lit city by night
  ofWall(c, fi, "l", 1.2, 4.6, 9, 25, "#2a2440"); ofWall(c, fi, "l", 1.3, 4.5, 10, 24, ofSkyGlass());
  for (const [u, h] of [[1.6, 21], [2.2, 13], [3.4, 20], [4.0, 12], [3.9, 22]]) ofWall(c, fi, "l", u, u + 0.12, h, h + 1, `rgba(255,230,168,${W.night})`);
  ofWall(c, fi, "l", 2.85, 2.95, 10, 24, "#2a2440"); ofWall(c, fi, "l", 1.3, 4.5, 16.5, 17.3, "#2a2440");
  for (let pk = 0; pk < 3; pk++) {
    const b = 3.4 * pk, seatNo = n * 3 + pk;
    const v = [...W.agents.values()].find(a => a.role === "viewer" && a.seat === seatNo && a.fk === k && !a.leaving);
    const on = v && v.pose === "sit" || (v && v.paused);
    ofWall(c, fi, "r", b + 0.55, b + 2.85, 8, 23, "#0c0c10");
    if (on) {
      // the picture moves: a slow camera drift across the artwork, a cut to a new "shot" every few seconds
      const T = W.t + pk * 2.7, seg = Math.floor(T / 6.5), p = (T % 6.5) / 6.5, hh = m => (ofHash(seatNo * 977 + seg * 31 + m) % 1000) / 1000;
      const hue = Math.floor(hh(5) * 360), fl = 0.9 + 0.06 * Math.sin(W.t * 5 + pk) + 0.04 * Math.sin(W.t * 13 + pk);
      const img = ofImg(v.s?.art), pan = {z: 1.25 + hh(4) * 0.35, x: hh(0) + (hh(1) - hh(0)) * p, y: hh(2) + (hh(3) - hh(2)) * p};
      if (img) ofWall(c, fi, "r", b + 0.68, b + 2.72, 9.2, 21.8, img, v.paused ? 0.45 : fl, v.paused ? null : pan);
      else if (v.paused) ofWall(c, fi, "r", b + 0.68, b + 2.72, 9.2, 21.8, "#1f2b44");
      else {  // no artwork: something with a horizon and a figure crossing it
        ofWall(c, fi, "r", b + 0.68, b + 2.72, 9.2, 21.8, `hsl(${hue} 45% 34%)`);
        ofWall(c, fi, "r", b + 0.68, b + 2.72, 9.2, 13.5 + hh(6) * 3, `hsl(${(hue + 40) % 360} 35% 22%)`);
        const u = b + 0.8 + p * 1.7; ofWall(c, fi, "r", u, u + 0.22, 13, 18, `hsl(${(hue + 180) % 360} 50% 70%)`);
      }
      if (!v.paused) ofWall(c, fi, "r", b + 0.68, b + 2.72, 9.2, 21.8, `hsla(${hue},70%,55%,${p < 0.04 ? 0.45 : 0.1})`);  // the colour of the shot (and a flash on each cut)
      if (v.paused) {
        ofWall(c, fi, "r", b + 1.45, b + 1.62, 12.5, 18.5, "#fff"); ofWall(c, fi, "r", b + 1.82, b + 1.99, 12.5, 18.5, "#fff");
        if (v.s?.pct != null) { ofWall(c, fi, "r", b + 0.8, b + 2.6, 10.2, 10.8, "rgba(255,255,255,.3)"); ofWall(c, fi, "r", b + 0.8, b + 0.8 + 1.8 * Math.min(100, v.s.pct) / 100, 10.2, 10.8, "#e50914"); }
      } else {
        poly(c, [P(fi, b + 0.6, 0.1), P(fi, b + 2.8, 0.1), P(fi, b + 3.1, 2.8), P(fi, b + 0.3, 2.8)], `hsla(${hue},60%,75%,${0.08 + 0.04 * Math.sin(W.t * 7 + pk)})`);
        W.glows.push({i: b + 1.7, j: 1.4, r: 30, col: `${ofHex(ofHslHex(hue)).join(",")}`, a: 0.22});
      }
    } else {
      ofWall(c, fi, "r", b + 0.68, b + 2.72, 9.2, 21.8, "#15131f");
      ofWall(c, fi, "r", b + 2.5, b + 2.58, 8.4, 9.0, Math.floor(W.t * 0.7 + pk) % 3 ? "#ff3b3b" : "#7a1d1d");  // standby light
    }
    if (on) W.glows.push({i: b + 3.05, j: 0.3, h: 22, r: 12, col: "255,214,150", a: 0.4, flat: 1});  // the lamp
    ofTilePoly(c, fi, b + 0.8, 1.1, b + 2.6, 2.6, ["#6b3b4a", "#3b5a6b", "#5a6b3b"][seatNo % 3]);
    if (pk) list.push(ofBoxD(c, fi, b - 0.12, 0, 0.24, 2.3, 17, [70, 52, 80]));
    // the couch (PixelLab, seen from behind), a different colour in each pod
    list.push(ofFurnD(c, fi, "couch-ne", b + 0.6, 2.95, 2.2, 0.9, {hue: [0, 150, 250][seatNo % 3]}));
    list.push(ofBoxD(c, fi, b + 2.95, 0.2, 0.2, 0.2, 21, [190, 190, 200], 0, null, () => {
      ofBox(c, fi, b + 2.85, 0.1, 0.4, 0.4, 4, on ? [255, 214, 150] : [90, 84, 110], 20);
    }));
    if (!on) post.push(() => {
      const [x0, y0] = P(fi, b, 0), [x1, y1] = P(fi, b + 3.4, 0);
      poly(c, [[x0, y0 - ISO.WALL], [x1, y1 - ISO.WALL], [x1, y1], P(fi, b + 3.4, ISO.GJ - 1.2), P(fi, b, ISO.GJ - 1.2), [x0, y0]], "rgba(6,5,14,.55)");
    });
    const [cx, cy] = P(fi, b + 1.7, 1.6);
    W.hits.push({x0: cx - 16, x1: cx + 16, y0: cy - 26, y1: cy + 10, what: on ? {agent: v.id} : {pod: seatNo}});
  }
}

function ofDock(c, k, fi, list) {
  const W = OF.W, busy = [...W.crates.values()].some(x => x.d?.state === "downloading");
  // the roll-up door is the way in from the street: it goes up when someone comes or goes
  const up = W.doors.street ? 16 : 0;
  ofWall(c, fi, "l", 1.2, 4.8, 0, 23, "#4a5268");
  if (up) { ofWall(c, fi, "l", 1.25, 4.75, 0, up, ofSkyGlass()); ofWall(c, fi, "l", 1.25, 4.75, 0, 2, "rgba(120,116,128,.8)"); }
  for (let s = 0; s < 11; s++) if (1 + s * 2 >= up) ofWall(c, fi, "l", 1.25, 4.75, 1 + s * 2, 1.6 + s * 2, "#5d6680");
  ofWall(c, fi, "r", 0.6, 6.0, 26, 28, "#3a4152");
  for (let u = 0.6; u < 6.0; u += 0.5) ofTilePoly(c, fi, u, 2.75, u + 0.5, 2.95, (Math.round(u * 2) % 2) ? "#e8c13a" : "#1d1d24");
  // the belt: three PixelLab sections end to end (nobody walks behind it, so it's drawn before everyone)
  for (const i0 of [0.6, 3.3]) ofFurnD(c, fi, "belt-se", i0, 1.6, 2.7, 0.9).draw();
  for (const i of [1.9, 4.7]) W.glows.push({i, j: 2.1, r: 28, col: "255,206,140", a: busy ? 0.3 : 0.14});  // work lamps over the belt
  if (busy) {  // rollers turning: a few glints sliding along the belt top
    c.fillStyle = "rgba(255,255,255,.35)";
    for (let m = 0; m < 9; m++) { const u = 0.8 + ((m + W.t * 0.45) % 9) * 0.57, [x, y] = P(fi, u, 2.05); c.fillRect(Math.round(x), Math.round(y) - BELT_Z, 1, 1); }
  }
  for (const cr of W.crates.values()) {
    if (cr.hold) continue;
    const st = cr.d.state, i0 = cr.x, red = st === "stuck" && Math.floor(W.t * 3) % 2 === 0;
    const hop = st === "importing" ? Math.abs(Math.sin(W.t * 6)) * 2 : 0;
    list.push(ofBoxD(c, fi, i0, 1.7, 0.75, 0.7, 7, st === "queued" || st === "paused" ? [140, 110, 80] : [184, 138, 82], BELT_Z + hop, null, () => {
      ofBox(c, fi, i0 + 0.3, 1.7, 0.15, 0.7, 0.4, [232, 210, 160], BELT_Z + 7 + hop);
      if (red) { const [x, y] = P(fi, i0 + 0.4, 2.0); c.fillStyle = "#ff4057"; c.fillRect(Math.round(x) - 1, Math.round(y) - 21, 3, 3); }
      if (st === "importing") { const [x, y] = P(fi, i0 + 0.4, 2.0); c.fillStyle = "#3ddc84"; c.fillRect(Math.round(x) + (Math.floor(W.t * 5) % 3) - 1, Math.round(y) - 22, 1, 1); }
      const [x, y] = P(fi, i0 + 0.4, 2.0);
      W.hits.push({x0: x - 7, x1: x + 7, y0: y - 20, y1: y - 2, what: {crate: cr.key}});
    }));
  }
}

function ofSearch(c, k, fi, list) {
  const W = OF.W, desks = new Map([...W.agents.values()].filter(a => a.role === "desk" && !a.leaving).map(a => [a.desk, a]));
  ofWall(c, fi, "l", 1.0, 4.4, 9, 25, "#24324a"); ofWall(c, fi, "l", 1.1, 4.3, 10, 24, ofSkyGlass());
  for (const [u, h] of [[1.5, 20], [2.0, 14], [3.2, 21], [3.8, 13]]) ofWall(c, fi, "l", u, u + 0.12, h, h + 1, `rgba(255,230,168,${W.night})`);
  ofWall(c, fi, "l", 2.65, 2.75, 10, 24, "#24324a");
  ofWall(c, fi, "r", 0.8, 3.5, 11, 24, "#7d8aa0"); ofWall(c, fi, "r", 0.9, 3.4, 12, 23, "#e6ebf2");
  ofWall(c, fi, "r", 1.1, 2.7, 19.5, 20.3, "#2f5fd0"); ofWall(c, fi, "r", 1.1, 3.1, 16.5, 17.3, "#e0303a"); ofWall(c, fi, "r", 1.3, 2.3, 13.5, 14.3, "#2a9a5a");
  ofWall(c, fi, "r", 5.0, 5.7, 17, 23, "#f2f2f2"); ofWall(c, fi, "r", 5.32, 5.38, 19.5, 22, "#222"); ofWall(c, fi, "r", 5.32, 5.6, 19.5, 20.1, "#222");
  for (let d = 0; d < 6; d++) {
    const s = ofDesk(d), a = desks.get(d), here = a && a.pose === "sit";
    const now = a?.x?.now, flash = now && Math.floor(W.t * 4) % 2 === 0;
    const screen = !here ? "#14161f" : a.asleep ? "#1d2a44" : now ? (flash ? "#fff2a8" : "#ffd34d") : ["#4ad0c6", "#58b0f0"][d % 2];
    if (here) W.glows.push({i: s.i0 + 1.1, j: s.j0 + 0.6, r: 16, col: now ? "255,220,120" : a.asleep ? "90,120,200" : "120,210,240", a: a.asleep ? 0.12 : 0.3});
    list.push({pt: true, i: s.i, j: s.j + 0.06, draw: () => { const [x, y] = P(fi, s.i + 0.05, s.j + 0.2); ofPropDraw(c, x, y, "office-chair"); }});
    list.push(ofFurnD(c, fi, "desk-sw", s.i0, s.j0, 2.2, 0.75, {after: () => {
      // a status lamp on the desk: off when empty, dim when asleep, flashing yellow while searching
      const [lx, ly] = P(fi, s.i0 + 1.9, s.j0 + 0.3);
      c.fillStyle = "#0d0b16"; c.fillRect(Math.round(lx) - 1, Math.round(ly) - 16, 3, 3);
      c.fillStyle = screen; c.fillRect(Math.round(lx), Math.round(ly) - 15, 1, 1);
      if (now && here) {  // the magnifying glass going over the screen
        const [x, y] = P(fi, s.i0 + 1.1 + Math.sin(W.t * 3) * 0.3, s.j0 + 0.5);
        c.fillStyle = "#e8e8e8"; c.fillRect(Math.round(x) - 1, Math.round(y) - 15, 3, 1); c.fillRect(Math.round(x) - 2, Math.round(y) - 14, 1, 2);
        c.fillRect(Math.round(x) + 2, Math.round(y) - 14, 1, 2); c.fillRect(Math.round(x) - 1, Math.round(y) - 12, 3, 1);
        c.fillStyle = "#c9a24a"; c.fillRect(Math.round(x) + 2, Math.round(y) - 11, 1, 2);
      }
      const [x, y] = P(fi, s.i0 + 1.1, s.j0 + 0.4);
      W.hits.push({x0: x - 12, x1: x + 12, y0: y - 16, y1: y + 6, what: a ? {agent: a.id} : {desk: d}});
    }}));
  }
}

function ofMail(c, k, fi, list) {
  const W = OF.W, d = W.data || {pending: [], delivered: []};
  ofWall(c, fi, "l", 2.45, 3.75, 7, 25, "#4a2e22");  // a window onto the side street (the way in is downstairs now)
  ofWall(c, fi, "l", 2.6, 3.6, 8.5, 23.5, ofSkyGlass()); ofWall(c, fi, "l", 3.07, 3.13, 8.5, 23.5, "#4a2e22");
  W.glows.push({i: 4.6, j: 3.5, h: 20, r: 26, col: "255,214,150", a: 0.3}, {i: 7.9, j: 0.6, r: 20, col: "160,255,190", a: 0.12});
  ofWall(c, fi, "l", 4.3, 5.7, 6, 20, "#8a6a3a");
  for (let r = 0; r < 4; r++) for (let s = 0; s < 3; s++) ofWall(c, fi, "l", 4.4 + s * 0.45, 4.75 + s * 0.45, 7 + r * 3.4, 9.6 + r * 3.4, "#c9a35a");
  // the Delivered shelf: the posters themselves, leaning on the wall
  ofBox(c, fi, 5.8, 0, 4.2, 0.45, 2, [122, 85, 54], 10);
  d.delivered.slice(0, 4).forEach((x, m) => {
    const u = 6.05 + m * 0.98, img = ofImg(x.poster);
    ofWall(c, fi, "r", u, u + 0.8, 12, 24, img || ["#6b3b4a", "#3b5a6b", "#5a6b3b", "#6b5a3b"][m]);
    ofWall(c, fi, "r", u + 0.62, u + 0.82, 22.5, 25, "#3ddc84");
  });
  const [sx, sy] = P(fi, 7.9, 0);
  W.hits.push({x0: sx - 18, x1: sx + 18, y0: sy - 28, y1: sy - 8, what: {shelf: 1}});
  // the front desk, with today's mail on it
  list.push(ofFurnD(c, fi, "counter-sw", 3.5, 3.15, 2.2, 0.85, {after: () => {
    for (let e = 0; e < Math.min(6, d.pending.length); e++) ofBox(c, fi, 3.75, 3.35, 0.6, 0.4, 1, [247, 243, 234], COUNTER_Z + e * 1.3);  // today's mail
    { const [wx, wy] = P(fi, 5.45, 3.75); ofPropDraw(c, wx, wy - COUNTER_Z, "volleyball"); }  // and Wilson
    const [x, y] = P(fi, 4.6, 3.6);
    W.hits.push({x0: x - 16, x1: x + 16, y0: y - 14, y1: y + 6, what: {inbox: 1}});
  }}));
}

// crisp HTML text over the canvas: the neon sign, floor names, people's names
function ofLabels(s) {
  const W = OF.W, box = $("#ofTags"), key = W.floors.join(",") + "|" + s.toFixed(3);
  if (box.dataset.k !== key) {
    box.dataset.k = key;
    const top = ISO.RTOP, [sx, sy] = P(0, 2.7, 0), skew = "skewY(26.565deg)";
    const names = {search: "3F · Search desk<i> · searching</i>", mail: "2F · Mailroom<i> · requests in/out</i>", dock: "1F · Loading dock<i> · downloads</i>"};
    box.innerHTML = `<div class="of-signt" style="left:${sx * s}px;top:${(sy - top - 22) * s}px;width:${6.8 * ISO.T * s}px;height:${16 * s}px;font-size:${10 * s}px;transform:${skew}">
        <span>${esc(BRAND)}</span><span class="f">Flix</span></div>` +
      W.floors.map((k, fi) => { const [x, y] = P(fi, 0.35, 0); if (k === "roof") return "";
        return `<div class="of-flab" style="left:${x * s}px;top:${(y - 29) * s}px;font-size:${4.2 * s}px;transform:${skew}">${k[0] === "w" ? `${+k.slice(1) + 4}F · Screening rooms<i> · watching</i>` : names[k]}</div>`; }).join("") +
      `<div id="ofNames"></div>`;
  }
  const nb = $("#ofNames", box), seen = new Set();
  for (const a of W.agents.values()) {
    if (a.role !== "viewer" || a.hidden || !a.tag) continue;
    const fi = ofFi(a.fk); if (fi < 0) continue;
    seen.add(a.id);
    let el = nb.querySelector(`[data-a="${CSS.escape(a.id)}"]`);
    if (!el) { el = document.createElement("span"); el.className = "of-tag"; el.dataset.a = a.id; nb.append(el); }
    if (el.textContent !== a.tag) el.textContent = a.tag;
    el.classList.toggle("me", !!a.me); el.style.setProperty("--c", ofHue(a.hue));
    const [x, y] = P(fi, a.i, a.j);
    el.style.transform = `translate(${x * s}px,${(y + (a.headY != null ? a.headY - 2 : a.pose === "sit" ? -14 : -17)) * s}px) translate(-50%,-100%)`;
    el.style.opacity = Math.max(0, a.alpha);
  }
  [...nb.children].forEach(el => { if (!seen.has(el.dataset.a)) el.remove(); });
}

function ofLabelsData() {  // the same labels as ofLabels, in world px, as JSON: the Apple TV draws them itself
  const W = OF.W, [sx, sy] = P(0, 2.7, 0), H = ISO.ROOF + W.floors.length * ISO.BAND + ISO.STREET;
  const names = {search: "3F · Search desk", mail: "2F · Mailroom", dock: "1F · Loading dock"};
  const out = {W: ISO.W, H, roof: ISO.ROOF, band: ISO.BAND, brand: BRAND,
    sign: {x: sx, y: sy - ISO.RTOP - 22, w: 6.8 * ISO.T, h: 16}, floors: [], tags: []};
  W.floors.forEach((k, fi) => {
    const [x, y] = P(fi, 0.35, 0);
    out.floors.push({k, fi, x, y: y - 29, text: k === "roof" ? "Roof" : k[0] === "w" ? `${+k.slice(1) + 4}F · Screening rooms` : names[k]});
  });
  for (const a of W.agents.values()) {
    if (a.role !== "viewer" || a.hidden || !a.tag) continue;
    const fi = ofFi(a.fk); if (fi < 0) continue;
    const [x, y] = P(fi, a.i, a.j);
    out.tags.push({id: a.id, text: a.tag, me: !!a.me, hue: a.hue, x, y: y + (a.headY != null ? a.headY - 2 : a.pose === "sit" ? -14 : -17), alpha: Math.max(0, a.alpha)});
  }
  return JSON.stringify(out);
}

// ---- tap anything to see what it is
function ofTap(e) {
  const W = OF.W, cv = $("#ofCanvas"), r = cv.getBoundingClientRect(), s = r.width / ISO.W;
  const x = (e.clientX - r.left) / s, y = (e.clientY - r.top) / s;
  const hit = W.hits.filter(h => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1)
    .sort((a, b) => (a.what.agent ? 0 : 1) - (b.what.agent ? 0 : 1) || (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0))[0];
  const el = $("#ofInfo");
  if (!hit) { el.hidden = true; return; }
  const h = ofInfo(hit.what);
  if (!h) { el.hidden = true; return; }
  el.innerHTML = `<button class="x" aria-label="Close">✕</button>${h}`; el.hidden = false;
  $(".x", el).onclick = () => { el.hidden = true; };
}
function ofInfo(w) {
  const W = OF.W, d = W.data;
  const bar = p => `<div class="of-bar"><i style="width:${p || 0}%"></i></div>`;
  if (w.agent) {
    const a = W.agents.get(w.agent); if (!a) return "";
    switch (a.role) {
      case "viewer": { const s = a.s; return `<div class="k">Screening room</div>${ofWho(s)}<div class="t">${s.title ? esc(s.title) : "Watching something"}</div>
        <div class="s">${[s.sub, s.device, s.src === "plex" ? "Plex" : "Jellyfin"].filter(Boolean).map(esc).join(" · ")}${s.state === "paused" ? " · Paused" : ""}${s.transcode ? " · Transcoding" : ""}</div>${s.pct != null ? bar(s.pct) : ""}`; }
      case "desk": { const x = a.x || {}; return `<div class="k">Search desk</div><div class="t">${esc(x.title || "")}</div><div class="s">${esc(x.why || "")}</div>${x.who ? `<div class="s">For ${ofWho(x)}</div>` : ""}`; }
      case "clerk": return `<div class="k">Front desk</div><div class="t">${d.pending.length ? `${d.pending.length} waiting for approval` : "Inbox zero"}</div>${ofList(d.pending, x => `from ${ofWho(x)} · ${ofAgo(x.created)}`)}`;
      case "dock": return `<div class="k">Dock crew</div><div class="t">${d.downloads.length ? `${d.downloads.length} on the belt` : "Quiet on the dock"}</div>`;
      case "courier": return `<div class="k">Mail carrier</div><div class="t">Bringing in a new request</div>`;
      case "runner": return `<div class="k">Front desk runner</div><div class="t">Taking an approved request up to the search desk</div>`;
      case "porter": return `<div class="k">Porter</div><div class="t">Carrying a finished download down to the Delivered shelf</div>`;
      case "cat": return a.look ? `<div class="k">The other building cat</div><div class="t">${a.asleep ? "Asleep on the job" : "Supervising the mail"}</div><div class="s">Formal wear at all times. Also hasn't paid rent.</div>`
        : `<div class="k">The building cat</div><div class="t">${a.asleep ? "Fast asleep" : "Doing the rounds"}</div><div class="s">Has never once paid rent.</div>`;
      case "guard": return `<div class="k">Night security</div><div class="t">${a.leaving ? "Clocking off" : "Doing the rounds"}</div><div class="s">On from dusk till dawn. Every floor, then the roof, then the vending machine.</div>`;
    }
    return "";
  }
  if (w.crate) {
    const c = W.crates.get(w.crate); if (!c) return "";
    const x = c.d, word = {importing: "Unpacking into the library", stuck: "Stuck · needs a look", paused: "Paused", queued: "Waiting in line"}[x.state];
    return `<div class="k">Loading dock</div><div class="t">${esc(x.title)}</div><div class="s">${x.sub ? esc(x.sub) + " · " : ""}${word || `${Math.round(x.pct)}%${x.left ? " · " + ofLeft(x.left) : ""}`}</div>${bar(x.pct)}`;
  }
  if (w.pod != null) return `<div class="k">Screening room</div><div class="t">Vacant</div><div class="s">Lights go on when someone starts watching.</div>`;
  if (w.desk != null) return `<div class="k">Search desk</div><div class="t">An empty desk</div><div class="s">Waiting for the next request.</div>`;
  if (w.inbox) return ofInfo({agent: "clerk"});
  if (w.fx) { OF_FX[w.fx](w); const [k, t] = OF_FX_TEXT[w.fx]; return `<div class="k">${k}</div><div class="t">${t}</div>`; }
  if (w.truck) { const T = OF.W.truck || {}; return `<div class="k">Delivery truck</div><div class="t">${esc(T.title || "A delivery")}</div><div class="s">Just finished downloading. It's being unloaded at the dock and taken up to the Delivered shelf.</div>`; }
  if (w.car) return `<div class="k">Out on the street</div><div class="t">${({van: "The delivery van", cop: "A police cruiser", time: "A stainless steel sports car", ghost: "An old ambulance with gadgets on the roof", mystery: "A flower-power van"})[w.car] || "A car"}</div><div class="s">${({cop: "Lights on. Somebody's in a hurry.", time: "Leaves two lines of fire behind it.", ghost: "Who you gonna call?", mystery: "Probably off to solve something."})[w.car] || "Just passing through."}</div>`;
  if (w.shelf) return `<div class="k">Delivered</div><div class="t">${d.delivered.length ? "In the last two days" : "Nothing in the last two days"}</div>${ofList(d.delivered, x => `${x.who ? `for ${ofWho(x)} · ` : ""}${ofAgo(x.at)}`)}`;
  return "";
}
const ofList = (rows, sub) => rows.length ? `<div class="of-list">${rows.slice(0, 6).map(x => `<div>${x.poster ? `<img src="${esc(x.poster)}" alt="">` : ""}<span><b>${esc(x.title)}</b><br>${sub(x)}</span></div>`).join("")}</div>` : "";

// ---- the made-up busy afternoon keeps changing, so the demo shows people moving around
function ofDemoStep(d) {
  const now = Date.now() / 1000, n = OF.demoN++, ev = e => d.events.unshift({at: now, ...e});
  d.now = now;
  d.downloads.forEach(x => { if (x.state === "downloading") { x.pct = Math.min(100, x.pct + 8 + Math.random() * 12); x.left = Math.max(30, (x.left || 900) - 150); } });
  d.downloads.filter(x => x.state === "importing").forEach(x => { x.pct = 100; x.state = "downloading"; });
  const done = d.downloads.find(x => x.pct >= 100);
  if (done) { d.downloads = d.downloads.filter(x => x !== done); d.delivered.unshift({title: done.title, poster: done.poster, at: now, who: "You", me: true, hue: 20}); ev({kind: "dl_done", title: done.title}); }
  switch (n % 5) {
    case 0: { const s = d.streams.shift(); if (s) { OF.demoBench = s; ev({kind: "stop", who: s.who, hue: s.hue, title: s.title}); } break; }
    case 1: { const x = d.searching.shift(); if (x) { d.downloads.push({key: "dx" + n, title: x.title, poster: x.poster, kind: x.kind, state: "downloading", pct: 3, left: 1500, sub: ""}); ev({kind: "dl", title: x.title}); } break; }
    case 2: { const s = OF.demoBench; if (s) { OF.demoBench = null; d.streams.push({...s, key: "d" + n, state: "playing"}); ev({kind: "watch", who: s.who, hue: s.hue, title: s.title}); } break; }
    case 3: { const p = d.pending.shift(); if (p) d.searching.push({key: "sx" + n, title: p.title, poster: p.poster, now: true, why: "Searching right now", asleep: false, who: p.who, hue: p.hue, me: p.me}); break; }
    case 4: {
      const pool = d.delivered.slice(2);
      const x = pool[n % Math.max(1, pool.length)];
      if (x) { d.pending.push({title: x.title, poster: x.poster, created: now, who: "Lena", hue: 290}); ev({kind: "req", who: "Lena", hue: 290, title: x.title}); }
      const s = d.streams[0]; if (s) s.state = s.state === "paused" ? "playing" : "paused";
      break;
    }
  }
  d.delivered = d.delivered.slice(0, 6);
  return d;
}

async function openOffice() {
  const el = $("#office");
  if (!el.hidden) return;
  el.hidden = false; document.body.style.overflow = "hidden";
  OF.seen = null; OF.W = ofNewWorld(); OF.demoData = null;
  el.innerHTML = `<div class="of-top"><button class="sw-close" aria-label="Close">✕</button><b>${esc(APP())} HQ</b>
      ${ME.admin ? `<button class="of-demo${OF.demo ? " on" : ""}" title="Fill the building with made-up activity">Demo</button>` : `<span style="width:34px"></span>`}</div>
    <p class="of-sum" id="ofSum">&nbsp;</p>
    <div class="of-stage"><canvas id="ofCanvas" aria-label="The building, live"></canvas><div class="of-tags" id="ofTags"></div></div>
    <p class="of-hint">Tap anyone or anything to see what it is. Some of the movie props do something.</p>
    <div class="of-guide" id="ofGuide"></div>
    <section class="of-log"><h3>Building log</h3><div id="ofLog"></div></section>
    <div class="of-info" id="ofInfo" hidden></div>`;
  $(".sw-close", el).onclick = back;
  $("#ofCanvas").onclick = ofTap;
  const demo = $(".of-demo", el);
  if (demo) demo.onclick = () => { OF.demo = !OF.demo; demo.classList.toggle("on", OF.demo); OF.W = ofNewWorld(); OF.demoData = null; OF.seen = null; $("#ofInfo").hidden = true; ofTick(true); };
  await ofTick(true);
  cancelAnimationFrame(OF.raf); OF.raf = requestAnimationFrame(ofLoop);
  OF.timer = setInterval(() => { if (!document.hidden) ofTick(); }, 8000);  // the server rebuilds its picture every 8s while someone looks
}
function closeOffice() {
  const el = $("#office");
  if (el.hidden) return;
  clearInterval(OF.timer); OF.timer = null; cancelAnimationFrame(OF.raf); OF.W = null;
  el.hidden = true; el.innerHTML = ""; document.body.style.overflow = "";
}
async function ofTick(first) {
  let d;
  try {
    if (OF.demo) { OF.demoData = OF.demoData ? ofDemoStep(structuredClone(OF.demoData)) : await api("/office?demo=1", {quiet: true}); d = OF.demoData; }
    else d = await api("/office", {quiet: true});
  } catch (e) { if (first && $("#ofLog")) $("#ofLog").innerHTML = `<p class="of-none">${esc(e.message)}</p>`; return; }
  if ($("#office").hidden || !OF.W) return;
  ofSyncWorld(d);
  const bits = [[d.streams.length, "watching"], [d.downloads.length, "downloading"], [d.searching.length, "being looked for"], [d.pending.length, "waiting for approval"]]
    .filter(b => b[0]).map(b => `<b>${b[0]}</b> ${b[1]}`);
  $("#ofSum").innerHTML = bits.length ? bits.join(" · ") : "All quiet right now";
  const top = OF.W.floors.filter(k => k[0] === "w").length + 3, cats = [...OF.W.agents.values()].filter(a => a.role === "cat" && a.fk === "roof").length;
  $("#ofGuide").innerHTML = [
    ["R", "Roof", `The sign, the water tower and a few deck chairs. The cats come up here to nap${OF.W.agents.has("guard") ? ", and the night guard ends each round here" : ""}.`, cats],
    [`${top > 4 ? "4–" + top : 4}F`, "Screening rooms", "Everyone watching on Plex or Jellyfin right now, one couch each.", d.streams.length],
    ["3F", "Search desk", "Approved requests that aren't here yet. Desks flash while it's searching.", d.searching.length],
    ["2F", "Mailroom", "New requests waiting for approval, and the shelf of what arrived lately.", d.pending.length + (d.delivered || []).length],
    ["1F", "Loading dock", "Downloads in progress, a box on the belt each. When one's done, a truck pulls up out front with it.", d.downloads.length],
  ].map(([no, t, tx, n]) => `<div class="of-fl"><span class="no">${no}</span><span class="tx"><b>${t}</b>${tx}</span><span class="n${n ? "" : " z"}">${n}</span></div>`).join("");
  $("#ofLog").innerHTML = d.events.length ? d.events.slice(0, 14).map(e => { const [i, t] = ofEvent(e);
    return `<div class="ev"><span class="i">${i}</span><span class="tx">${t}</span><span class="at">${ofAgo(e.at)}</span></div>`; }).join("")
    : `<p class="of-none">All quiet so far. Things show up here as they happen.</p>`;
}

/* the Home card: a little lit-up building and what's going on right now */
async function fillOfficeCard() {
  const el = $("#ofCard");
  if (!el) return;
  try {
    const d = await api("/office", {quiet: true});
    const bits = [[d.streams.length, "watching"], [d.downloads.length, "downloading"], [d.searching.length, "being looked for"],
                  [d.pending.length, "waiting for approval"]].filter(b => b[0]).map(b => `<b>${b[0]}</b> ${b[1]}`);
    $(".ofc-sum", el).innerHTML = bits.length ? bits.join(" · ") : "All quiet. Peek inside.";
    $$(".ofc-win i", el).forEach((w, i) => w.classList.toggle("lit", i < Math.min(9, 2 + d.streams.length * 2 + d.downloads.length + d.searching.length)));
  } catch { el.remove(); }
}

