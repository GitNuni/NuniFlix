/* Seasonal background: a few slow particles behind the page (they only show between cards, never over them), and now
   and then a small horror cameo walking along the bottom. Picked by date:
     October       leaves + bats; eyes in the dark          November     leaves + a turkey with an axe
     Dec 1 – Jan 6 snow + Krampus (chains, birch switch);   Jan – Feb    light snow
                   red eyes in the dark                     Spring       petals      Summer  fireflies   September leaves
   Off when the person turns it off (Settings), when the system asks for reduced motion, and paused in a hidden tab.
   Preview any season with ?season=halloween|fall|christmas|winter|spring|summer|autumn (&cameo=now to see one at once). */
(() => {
  const qs = new URLSearchParams(location.search);
  const forced = qs.get("season");
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  let cv, ctx, W = 0, H = 0, DPR = 1, parts = [], raf = 0, on = false, season = null, cameo = null, nextCameo = 0, eyes = null, nextEyes = 0, last = 0;
  let light = false, lightAt = 0;  // a light page background: snow is drawn blue-grey instead of white
  const rnd = (a, b) => a + Math.random() * (b - a);
  // Horror Hours, 10pm–4am: cameos about twice as often, and eyes in the dark whatever the season (?late=1 previews)
  const late = () => qs.has("late") || (h => h >= 22 || h < 4)(new Date().getHours());
  function checkLight(now) {
    if (now - lightAt < 2000) return;
    lightAt = now;
    const m = getComputedStyle(document.body).backgroundColor.match(/\d+(\.\d+)?/g);
    if (m) light = (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) > 150;
    SIL = light ? "rgba(8,6,6,.78)" : "rgba(64,58,58,.88)";
  }
  const pick = a => a[Math.floor(Math.random() * a.length)];

  function seasonFor(d) {
    const m = d.getMonth() + 1, day = d.getDate();
    if (m === 10) return "halloween";
    if (m === 11) return "fall";
    if (m === 12 || (m === 1 && day <= 6)) return "christmas";
    if (m <= 2) return "winter";
    if (m <= 5) return "spring";
    if (m <= 8) return "summer";
    return "autumn";
  }

  const KIND = {  // particle type, density (px² per particle), cap, cameo
    halloween: {p: "leaf", per: 70000, max: 16, cameo: "bats", eyes: true},
    fall: {p: "leaf", per: 50000, max: 24, cameo: "turkey"},
    autumn: {p: "leaf", per: 80000, max: 14},
    christmas: {p: "snow", per: 16000, max: 80, cameo: "krampus", eyes: true},
    winter: {p: "snow", per: 40000, max: 32},
    spring: {p: "petal", per: 90000, max: 12},
    summer: {p: "fly", per: 90000, max: 14},
  };
  // PixelLab pixel art (web/season/<season>/), drawn crisp. Seasons without art use the drawn shapes below.
  // sprites: the falling particles; walker: the cameo's walk cycle; flyer: a flock's flap cycle. [file, frames, size]
  const ART = {
    fall: {dir: "/season/fall/", scene: "scene.png", moon: "moon.png", sprites: ["leaves.png", 5, 32], walker: ["turkey.png", 8, 64]},
    autumn: {dir: "/season/fall/", scene: "scene.png", moon: "moon.png", sprites: ["leaves.png", 5, 32]},
    halloween: {dir: "/season/halloween/", scene: "scene.png", moon: "moon.png", sprites: ["leaves.png", 5, 32], flyer: ["bat.png", 6, 48]},
    christmas: {dir: "/season/christmas/", scene: "scene.png", moon: "moon.png", sprites: ["flakes.png", 2, 32], walker: ["krampus.png", 8, 64]},
    winter: {dir: "/season/winter/", scene: "scene.png", sprites: ["flakes.png", 2, 32]},
    spring: {dir: "/season/spring/", scene: "scene.png", sprites: ["petals.png", 2, 32]},
    summer: {dir: "/season/summer/", scene: "scene.png"},
  };
  const art = {};  // loaded images for the current season
  function loadArt() {
    const a = ART[season];
    for (const k of Object.keys(art)) delete art[k];
    if (!a) return;
    const img = (key, file) => { const i = new Image(); i.onload = () => { art[key] = i; sceneLayer = null; }; i.src = a.dir + file; };
    if (a.scene) img("scene", a.scene);
    if (a.moon) img("moon", a.moon);
    if (a.sprites) img("sprites", a.sprites[0]);
    if (a.flyer) img("flyer", a.flyer[0]);
    if (a.walker) img("walker", a.walker[0]);
  }
  let sceneLayer = null, sceneFor = "";  // the scene strip, tiled across the width and faded at the top, built once per size
  function buildScene() {
    const a = ART[season], im = art.scene;
    const k = Math.max(2, Math.round(H * 0.17 / im.height)), w = im.width * k, h = im.height * k;
    const c = document.createElement("canvas"); c.width = W; c.height = h;
    const g = c.getContext("2d"); g.imageSmoothingEnabled = false;
    for (let x = 0, i = 0; x < W; x += w, i++) {  // every other tile mirrored, so the seams match up
      g.save(); if (i % 2) { g.translate(x + w, 0); g.scale(-1, 1); g.drawImage(im, 0, 0, w, h); } else g.drawImage(im, x, 0, w, h); g.restore();
    }
    g.globalCompositeOperation = "destination-in";  // misty top: fades in from nothing
    const fade = g.createLinearGradient(0, 0, 0, h); fade.addColorStop(0, "rgba(0,0,0,0)"); fade.addColorStop(0.55, "rgba(0,0,0,1)");
    g.fillStyle = fade; g.fillRect(0, 0, W, h);
    sceneLayer = c; sceneFor = `${W}x${H}`;
  }
  function drawBackdrop() {
    if (art.moon) {
      const k = W < 600 ? 1.5 : W < 1400 ? 2 : 3, sz = art.moon.width * k;
      ctx.globalAlpha = light ? 0.35 : 0.55; ctx.imageSmoothingEnabled = false;
      ctx.drawImage(art.moon, W - sz - W * 0.06, H * 0.07, sz, sz);
    }
    if (art.scene) {
      if (!sceneLayer || sceneFor !== `${W}x${H}`) buildScene();
      ctx.globalAlpha = light ? 0.3 : 0.6;
      ctx.drawImage(sceneLayer, 0, ground() - sceneLayer.height + 2);
    }
    ctx.globalAlpha = 1;
  }
  const LEAF = ["#b8461b", "#a5541a", "#8a3a14", "#c2741c", "#7a2e12", "#9c6a17"];

  function particle(kind, anywhere) {
    const p = {x: rnd(0, W), y: anywhere ? rnd(0, H) : rnd(-40, -10), t: rnd(0, 6.28)};
    if (kind === "snow") Object.assign(p, {k: Math.floor(rnd(0, 4)), r: rnd(0.8, 2.6), vy: rnd(0.25, 0.8), sway: rnd(0.2, 0.7), a: rnd(0.3, 0.75)});
    if (kind === "leaf") Object.assign(p, {k: Math.floor(rnd(0, 5)), r: rnd(6, 12), vy: rnd(0.35, 0.8), sway: rnd(0.6, 1.4), a: rnd(0.45, 0.7), rot: rnd(0, 6.28), vr: rnd(-0.02, 0.02), c: pick(LEAF)});
    if (kind === "petal") Object.assign(p, {k: Math.floor(rnd(0, 4)), r: rnd(3, 5), vy: rnd(0.25, 0.55), sway: rnd(0.5, 1), a: rnd(0.35, 0.6), rot: rnd(0, 6.28), vr: rnd(-0.02, 0.02)});
    if (kind === "fly") Object.assign(p, {y: rnd(H * 0.3, H), r: rnd(1.2, 2.2), vx: rnd(-0.25, 0.25), vy: rnd(-0.15, 0.15), a: 0});
    return p;
  }

  function resize() {
    DPR = Math.min(devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cv.width = W * DPR; cv.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const k = KIND[season], n = Math.min(k.max, Math.round(W * H / k.per));
    while (parts.length < n) parts.push(particle(k.p, true));
    parts.length = n;
  }

  // ---------- particles ----------
  function drawLeaf(p) {
    if (art.sprites) {  // pixel-art leaf
      const [, cnt, n] = ART[season].sprites, sz = p.r * 2.4; p.k %= cnt;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = Math.min(0.85, p.a + 0.15); ctx.imageSmoothingEnabled = false;
      ctx.drawImage(art.sprites, p.k * n, 0, n, n, -sz / 2, -sz / 2, sz, sz); ctx.restore();
      return;
    }
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = p.a; ctx.fillStyle = p.c;
    ctx.beginPath(); ctx.moveTo(0, -p.r); ctx.quadraticCurveTo(p.r * 0.9, 0, 0, p.r); ctx.quadraticCurveTo(-p.r * 0.9, 0, 0, -p.r); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,.25)"; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(0, -p.r); ctx.lineTo(0, p.r * 1.3); ctx.stroke();
    ctx.restore();
  }
  function step(p, kind, dt) {
    p.t += 0.02 * dt;
    if (kind === "fly") {
      p.x += (p.vx + Math.sin(p.t) * 0.15) * dt; p.y += (p.vy + Math.cos(p.t * 0.7) * 0.12) * dt;
      p.a = Math.max(0, Math.sin(p.t * 1.3)) * 0.8;
      if (p.x < -10 || p.x > W + 10 || p.y < H * 0.2 || p.y > H + 10) Object.assign(p, particle("fly", true));
      ctx.globalAlpha = p.a; ctx.fillStyle = "#d9f99d"; ctx.shadowColor = "#bef264"; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.28); ctx.fill(); ctx.shadowBlur = 0;
      return;
    }
    p.y += p.vy * dt; p.x += Math.sin(p.t) * p.sway * 0.5 * dt;
    if (p.rot !== undefined) p.rot += p.vr * dt;
    if (p.y > H + 20) Object.assign(p, particle(kind, false));
    if (kind === "snow" && art.sprites && p.r > 1.7 && !light) {  // the bigger flakes are pixel-art flakes, the small ones dots
      const [, cnt, n] = ART[season].sprites, sz = p.r * 5;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.t * 0.3); ctx.globalAlpha = p.a; ctx.imageSmoothingEnabled = false;
      ctx.drawImage(art.sprites, ((p.k || 0) % cnt) * n, 0, n, n, -sz / 2, -sz / 2, sz, sz); ctx.restore();
    }
    else if (kind === "snow") { ctx.globalAlpha = p.a; ctx.fillStyle = light ? "#9fb0c6" : "#fff"; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.28); ctx.fill(); }
    else if (kind === "leaf") drawLeaf(p);
    else if (art.sprites) {  // pixel-art petal
      const [, cnt, n] = ART[season].sprites, sz = p.r * 4.5;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = Math.min(0.85, p.a + 0.2); ctx.imageSmoothingEnabled = false;
      ctx.drawImage(art.sprites, ((p.k || 0) % cnt) * n, 0, n, n, -sz / 2, -sz / 2, sz, sz); ctx.restore();
    }
    else { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = p.a; ctx.fillStyle = "#f9c6d3";
      ctx.beginPath(); ctx.ellipse(0, 0, p.r, p.r * 0.6, 0, 0, 6.28); ctx.fill(); ctx.restore(); }
  }

  // ---------- cameos: little silhouettes along the bottom, above the tab bar ----------
  const ground = () => H - (document.querySelector(".tabs")?.offsetHeight || 0) - 8;
  let SIL = "rgba(8,6,6,.78)";  // black on light pages, charcoal on dark ones (see checkLight)
  function eyesAt(x, y, r = 1.6) {
    ctx.fillStyle = "#ff2a2a"; ctx.shadowColor = "#ff0000"; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.arc(x - r * 1.8, y, r, 0, 6.28); ctx.arc(x + r * 1.8, y, r, 0, 6.28); ctx.fill(); ctx.shadowBlur = 0;
  }
  function walker(x, g, ph) {  // a PixelLab walk cycle (the turkey, Krampus); true if there was one to draw
    if (!art.walker) return false;
    const [, frames, n] = ART[season].walker, k = W < 600 ? 1.5 : W < 1400 ? 2.2 : 3, f = Math.floor(ph * 1.45) % frames;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(art.walker, f * n, 0, n, n, x - n * k / 2, g - (n - 3) * k, n * k, n * k);
    return true;
  }
  function krampus(x, g, s, ph) {
    if (!walker(x, g, ph)) krampusDrawn(x, g, s, ph);
  }
  function krampusDrawn(x, g, s, ph) {  // hunched, horned, chains and a birch switch; walks right
    ctx.save(); ctx.translate(x, g); ctx.scale(s, s); ctx.fillStyle = SIL; ctx.strokeStyle = SIL; ctx.lineCap = "round";
    const sw = Math.sin(ph) * 6;
    ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(-6, -34); ctx.lineTo(-8 + sw, -16); ctx.lineTo(-12 + sw, 0); ctx.moveTo(4, -34); ctx.lineTo(6 - sw, -16); ctx.lineTo(2 - sw, 0); ctx.stroke();  // goat legs
    ctx.beginPath(); ctx.ellipse(0, -48, 14, 18, -0.35, 0, 6.28); ctx.fill();  // shaggy body
    for (let i = -12; i <= 10; i += 4) { ctx.beginPath(); ctx.moveTo(i, -36); ctx.lineTo(i + 2, -28); ctx.lineTo(i + 4, -36); ctx.fill(); }  // fur fringe
    ctx.beginPath(); ctx.arc(9, -66, 8, 0, 6.28); ctx.fill();  // head, pushed forward
    ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(6, -72); ctx.quadraticCurveTo(-4, -86, 2, -94); ctx.moveTo(12, -72); ctx.quadraticCurveTo(22, -86, 16, -94); ctx.stroke();  // horns
    ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(15, -62); ctx.quadraticCurveTo(20, -56, 17, -50); ctx.stroke();  // tongue
    ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(10, -52); ctx.lineTo(22, -40 - sw * 0.3); ctx.stroke();  // arm
    ctx.lineWidth = 1.2; for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.moveTo(22, -40); ctx.lineTo(30 + i * 2, -60 + i * 3); ctx.stroke(); }  // birch switch
    ctx.lineWidth = 1.5; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(-10, -44); ctx.quadraticCurveTo(-20, -24 + sw * 0.5, -26, -6); ctx.stroke(); ctx.setLineDash([]);  // dragging chain
    ctx.restore();
    eyesAt(x + 11 * s, g - 67 * s, 1.3 * s);
  }
  function turkey(x, g, s, ph) {  // the PixelLab turkey's walk cycle when it's loaded, else the drawn one
    if (!walker(x, g, ph)) turkeyDrawn(x, g, s, ph);
  }
  function turkeyDrawn(x, g, s, ph) {  // round body, fanned tail, an axe over the shoulder; struts right
    ctx.save(); ctx.translate(x, g); ctx.scale(s, s); ctx.fillStyle = SIL; ctx.strokeStyle = SIL; ctx.lineCap = "round";
    const sw = Math.sin(ph) * 5, bob = Math.abs(Math.sin(ph)) * 2;
    for (let i = -3; i <= 3; i++) { ctx.save(); ctx.translate(-8, -30 - bob); ctx.rotate(i * 0.32 - 0.5); ctx.beginPath(); ctx.ellipse(0, -18, 5, 16, 0, 0, 6.28); ctx.fill(); ctx.restore(); }  // tail fan
    ctx.beginPath(); ctx.ellipse(0, -24 - bob, 14, 12, 0, 0, 6.28); ctx.fill();  // body
    ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(8, -32 - bob); ctx.quadraticCurveTo(14, -44, 12, -50 - bob); ctx.stroke();  // neck
    ctx.beginPath(); ctx.arc(12, -52 - bob, 5, 0, 6.28); ctx.fill();  // head
    ctx.beginPath(); ctx.moveTo(16, -52 - bob); ctx.lineTo(22, -50 - bob); ctx.lineTo(16, -49 - bob); ctx.fill();  // beak
    ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-3, -13); ctx.lineTo(-4 + sw, 0); ctx.moveTo(4, -13); ctx.lineTo(5 - sw, 0); ctx.stroke();  // legs
    ctx.restore();
    // the axe, held up in front so it reads against the tail: wooden handle, pale blade
    ctx.save(); ctx.translate(x, g); ctx.scale(s, s); ctx.lineCap = "round";
    const lift = Math.sin(ph * 0.5) * 3;
    ctx.strokeStyle = "rgba(70,40,20,.9)"; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(12, -26 - bob); ctx.lineTo(26, -60 - bob - lift); ctx.stroke();
    ctx.fillStyle = "rgba(190,195,200,.95)";
    ctx.beginPath(); ctx.moveTo(24, -56 - bob - lift); ctx.quadraticCurveTo(40, -58, 38, -74 - bob - lift); ctx.lineTo(27, -66 - bob - lift); ctx.fill();
    ctx.fillStyle = "rgba(150,10,10,.8)"; ctx.beginPath(); ctx.arc(37, -62 - bob - lift, 1.4, 0, 6.28); ctx.fill();  // a drop on the blade
    ctx.restore();
    eyesAt(x + 13 * s, g - 53 * s, 1.1 * s);
  }
  function bats(x, g, s, ph) {
    if (art.flyer) {  // a loose flock of PixelLab bats, each a little out of step
      const [, frames, n] = ART[season].flyer, k = W < 600 ? 1 : 1.6;
      ctx.imageSmoothingEnabled = false;
      for (let i = 0; i < 5; i++) {
        const bx = x - i * 46 * k, by = g * 0.32 + Math.sin(ph * 0.6 + i * 1.7) * 22 + i * 14, f = Math.floor(ph * 2 + i * 2) % frames;
        ctx.drawImage(art.flyer, f * n, 0, n, n, bx - n * k / 2, by - n * k / 2, n * k, n * k);
      }
      return;
    }
    ctx.fillStyle = SIL;
    for (let i = 0; i < 6; i++) {
      const bx = x - i * 26 * s, by = g * 0.35 + Math.sin(ph * 0.6 + i) * 18 + i * 9, f = Math.sin(ph * 3 + i) * 5 * s;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.quadraticCurveTo(bx - 8 * s, by - 6 * s - f, bx - 16 * s, by - f);
      ctx.quadraticCurveTo(bx - 8 * s, by - 1 * s, bx, by + 3 * s); ctx.quadraticCurveTo(bx + 8 * s, by - 1 * s, bx + 16 * s, by - f);
      ctx.quadraticCurveTo(bx + 8 * s, by - 6 * s - f, bx, by); ctx.fill();
    }
  }
  const CAMEO = {krampus, turkey, bats};

  function drawCameo(now) {
    const k = KIND[season];
    if (!k.cameo) return;
    if (!cameo && now > nextCameo) {
      const s = Math.max(0.7, Math.min(1.3, W / 900));
      cameo = {start: now, dur: k.cameo === "bats" ? 9000 : 16000, s, dir: Math.random() < 0.5 ? 1 : -1};
    }
    if (!cameo) return;
    const q = (now - cameo.start) / cameo.dur;
    if (q >= 1) { cameo = null; nextCameo = now + (late() ? rnd(30000, 60000) : rnd(60000, 120000)); return; }
    const x = cameo.dir > 0 ? -120 + q * (W + 240) : W + 120 - q * (W + 240);
    ctx.save(); ctx.globalAlpha = Math.min(1, q * 8, (1 - q) * 8) * 0.85;
    if (cameo.dir < 0) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    CAMEO[k.cameo](cameo.dir < 0 ? W - x : x, ground(), cameo.s, (now - cameo.start) / 160);
    ctx.restore();
  }

  function drawEyes(now) {
    if (!KIND[season].eyes && !late()) return;
    if (!eyes && now > nextEyes) eyes = {start: now, x: rnd(30, W - 30), y: rnd(60, H * 0.45)};
    if (!eyes) return;
    const q = (now - eyes.start) / 4500;
    if (q >= 1) { eyes = null; nextEyes = now + (late() ? rnd(20000, 45000) : rnd(40000, 90000)); return; }
    const blink = q > 0.45 && q < 0.5;  // one blink
    ctx.globalAlpha = blink ? 0 : Math.sin(q * Math.PI) * 0.7;
    eyesAt(eyes.x, eyes.y, 1.8);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(3, (now - (last || now)) / 16.7); last = now;
    ctx.clearRect(0, 0, W, H);
    checkLight(now);
    drawBackdrop();
    const kind = KIND[season].p;
    for (const p of parts) step(p, kind, dt);
    ctx.globalAlpha = 1;
    drawEyes(now);
    drawCameo(now);
    ctx.globalAlpha = 1;
  }

  function start() {
    if (on) return;
    on = true; season = forced && KIND[forced] ? forced : seasonFor(new Date());
    if (!cv) {
      cv = document.createElement("canvas");
      cv.id = "season"; cv.setAttribute("aria-hidden", "true");
      document.body.prepend(cv);
      ctx = cv.getContext("2d");
      addEventListener("resize", () => on && resize());
    }
    cv.hidden = false; parts = []; resize(); loadArt();
    const now = performance.now();
    nextCameo = now + (qs.get("cameo") === "now" ? 800 : rnd(20000, 40000)); nextEyes = now + rnd(15000, 30000);
    last = 0; raf = requestAnimationFrame(frame);
  }
  function stop() {
    on = false; cancelAnimationFrame(raf);
    if (cv) { ctx.clearRect(0, 0, W, H); cv.hidden = true; }
  }

  let want = true;
  const apply = () => (want && !reduce.matches && !document.hidden ? start() : stop());
  document.addEventListener("visibilitychange", apply);
  reduce.addEventListener?.("change", apply);
  window.NFSeason = {set(v) { want = v !== false; apply(); }, name: () => forced && KIND[forced] ? forced : seasonFor(new Date())};
})();
