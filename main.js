'use strict';

/*
 * Cyber Brain — a holographic brain view of the vault.
 * Each course folder lives in a brain region; real links are drawn as
 * neural wiring and fire signals when you open or edit notes.
 */

const obsidian = require('obsidian');
const { Plugin, ItemView, PluginSettingTab, Setting, TFolder, setIcon } = obsidian;

const VIEW_TYPE = 'cyber-brain-view';
const FONT = '"JetBrains Mono", Consolas, "Courier New", monospace';
const CYAN = '#00e5ff';

const REGIONS = [
  { key: 'frontal', col: '#ff2e97' },
  { key: 'parietal', col: '#00e5ff' },
  { key: 'temporal', col: '#39ff8a' },
  { key: 'occipital', col: '#b14cff' },
  { key: 'cerebellum', col: '#ffb800' },
];
const CORE_INDEX = 5;
const CORE_COLOR = '#9fb3c8';

const DEFAULT_SETTINGS = {
  regions: {
    frontal: 'CS2001 Data Structures',
    parietal: 'MT1004 Linear Algebra',
    temporal: 'Pak Studies',
    occipital: 'ISE1003 Intro to SE',
    cerebellum: 'EE2003 COAL',
  },
  labels: {
    frontal: 'DS',
    parietal: 'LA',
    temporal: 'PAK STD',
    occipital: 'ISE',
    cerebellum: 'COAL',
  },
  homeNote: 'Home.md',
  rotationSpeed: 0.14,
  ambientSignals: true,
  signalsOnOpen: true,
  glitch: true,
  scanlines: true,
  folderWiring: true,
  showUnmapped: true,
};

/* ---------- brain geometry ---------- */

const BX = 118, BY = 92, BZ = 162;
const eMain = (x, y, z) => { const yy = y > 0 ? y / (BY * 0.75) : y / BY; return (x / BX) ** 2 + yy * yy + (z / BZ) ** 2; };
const eCb = (x, y, z) => (x / 82) ** 2 + ((y - 62) / 34) ** 2 + ((z - 112) / 48) ** 2;
const eCore = (x, y, z) => (x / 22) ** 2 + ((y - 6) / 16) ** 2 + ((z - 14) / 26) ** 2;

function lobeAt(x, y, z) {
  if (eCb(x, y, z) < 1 && eMain(x, y, z) >= 1) return 4;
  if (eMain(x, y, z) >= 1 || Math.abs(x) < 7) return -1;
  if (z < -55) return 0;
  if (z > 100) return 3;
  return y < 8 ? 1 : 2;
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function rng(seed) {
  let a = seed || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function courseLabel(folder) {
  const parts = folder.trim().split(/\s+/);
  if (/^[A-Z]{2,}\d{3,}$/.test(parts[0])) return { code: parts[0], name: parts.slice(1).join(' ') || parts[0] };
  return { code: parts[0].slice(0, 3).toUpperCase(), name: folder };
}

function baseName(path) {
  const n = path.split('/').pop();
  return n.replace(/\.md$/i, '');
}

/* ---------- model: notes + links → 3D brain ---------- */

function buildModel(app, s) {
  const files = app.vault.getMarkdownFiles().slice().sort((a, b) => a.path.localeCompare(b.path));
  const regionOf = new Map();
  REGIONS.forEach((r, i) => {
    const f = (s.regions[r.key] || '').trim().replace(/\/+$/, '');
    if (f) regionOf.set(f, i);
  });
  const homePath = (s.homeNote || '').trim();

  const groups = REGIONS.map(() => []);
  const core = [];
  let homeFile = null;
  for (const f of files) {
    if (homePath && f.path === homePath) { homeFile = f; continue; }
    const top = f.path.includes('/') ? f.path.split('/')[0] : null;
    if (top !== null && regionOf.has(top)) groups[regionOf.get(top)].push(f);
    else if (s.showUnmapped) core.push(f);
  }

  const rl = app.metadataCache.resolvedLinks || {};
  const deg = new Map();
  for (const src in rl) {
    for (const dst in rl[src]) {
      if (src === dst) continue;
      deg.set(src, (deg.get(src) || 0) + 1);
      deg.set(dst, (deg.get(dst) || 0) + 1);
    }
  }

  const nodes = [];
  const byPath = new Map();
  const hubs = REGIONS.map(() => -1);
  const courses = REGIONS.map((r, i) => {
    const folder = (s.regions[r.key] || '').trim();
    const c = Object.assign({ key: r.key, col: r.col, folder }, folder ? courseLabel(folder) : { code: '—', name: 'unassigned' });
    c.short = ((s.labels && s.labels[r.key]) || '').trim() || c.code;
    return c;
  });

  const pickHub = (g, folder) => {
    if (!g.length) return null;
    const lower = folder.toLowerCase();
    const root = g.filter(f => f.path.split('/').length === 2);
    const exact = root.find(f => baseName(f.path).toLowerCase() === lower);
    if (exact) return exact;
    const pool = root.length ? root : g;
    return pool.reduce((best, f) => ((deg.get(f.path) || 0) > (deg.get(best.path) || 0) ? f : best), pool[0]);
  };

  const placed = [];
  const place = (path, test, minD) => {
    const r = rng(hashStr(path));
    let d2 = minD * minD;
    for (let round = 0; round < 6; round++) {
      for (let t = 0; t < 400; t++) {
        const x = (r() - 0.5) * 2 * BX, y = -BY + r() * (BY + 100), z = (r() - 0.5) * 2 * (BZ + 10);
        if (!test(x, y, z)) continue;
        if (placed.some(p => (p.x - x) ** 2 + (p.y - y) ** 2 + (p.z - z) ** 2 < d2)) continue;
        return { x, y, z };
      }
      d2 *= 0.6;
    }
    for (let t = 0; t < 20000; t++) {
      const x = (r() - 0.5) * 2 * BX, y = -BY + r() * (BY + 100), z = (r() - 0.5) * 2 * (BZ + 10);
      if (test(x, y, z)) return { x, y, z };
    }
    return { x: 0, y: 0, z: 0 };
  };

  const radius = p => 2.2 + Math.min(2.2, Math.log2(1 + (deg.get(p) || 0)) * 0.45);

  groups.forEach((g, li) => {
    const hubFile = pickHub(g, courses[li].folder);
    const kids = g.filter(f => f !== hubFile);
    const minD = 23 * Math.min(1, Math.cbrt(13 / Math.max(1, kids.length)));
    const test = li === 4
      ? (x, y, z) => lobeAt(x, y, z) === 4 && eCb(x, y, z) >= 0.4 && eCb(x, y, z) <= 0.92
      : (x, y, z) => { const e = eMain(x, y, z); return lobeAt(x, y, z) === li && e >= 0.4 && e <= 0.92; };
    const kidIdx = [];
    for (const f of kids) {
      const p = place(f.path, test, minD);
      placed.push(p);
      const n = { x: p.x, y: p.y, z: p.z, r: radius(f.path), li, label: baseName(f.path), path: f.path, f: 0 };
      byPath.set(f.path, nodes.length); kidIdx.push(nodes.length); nodes.push(n);
    }
    if (hubFile || kidIdx.length) {
      let hx = 0, hy = 0, hz = 0;
      if (kidIdx.length) {
        kidIdx.forEach(i => { hx += nodes[i].x; hy += nodes[i].y; hz += nodes[i].z; });
        hx = (hx / kidIdx.length) * 0.2; hy /= kidIdx.length; hz /= kidIdx.length;
      } else { const p = place('hub:' + li, test, 10); hx = p.x; hy = p.y; hz = p.z; }
      const hub = { x: hx, y: hy, z: hz, r: 7, li, hub: true, label: courses[li].short, path: hubFile ? hubFile.path : null, f: 0 };
      if (hubFile) byPath.set(hubFile.path, nodes.length);
      hubs[li] = nodes.length; nodes.push(hub);
    }
  });

  core.forEach(f => {
    const p = place(f.path, (x, y, z) => eCore(x, y, z) < 1, 9);
    placed.push(p);
    byPath.set(f.path, nodes.length);
    nodes.push({ x: p.x, y: p.y, z: p.z, r: radius(f.path), li: CORE_INDEX, label: baseName(f.path), path: f.path, f: 0 });
  });

  const homeIdx = nodes.length;
  nodes.push({ x: 0, y: 150, z: 62, r: 5, li: -1, hub: true, home: true, label: homeFile ? baseName(homeFile.path) : 'Home', path: homeFile ? homeFile.path : null, f: 0 });
  if (homeFile) byPath.set(homeFile.path, homeIdx);

  const edges = [];
  const seen = new Set();
  const addEdge = (a, b, real) => {
    if (a === b || a < 0 || b < 0) return;
    const k = a < b ? a + '|' + b : b + '|' + a;
    if (seen.has(k)) return;
    seen.add(k);
    const A = nodes[a], B = nodes[b];
    edges.push({ a, b, w: A.li !== B.li ? 1 : 0, v: real ? 0 : 1 });
  };
  for (const src in rl) {
    const ai = byPath.get(src);
    if (ai === undefined) continue;
    for (const dst in rl[src]) {
      const bi = byPath.get(dst);
      if (bi !== undefined) addEdge(ai, bi, true);
    }
  }
  if (s.folderWiring) {
    nodes.forEach((n, i) => {
      if (n.hub || n.li < 0 || n.li >= REGIONS.length) return;
      if (hubs[n.li] >= 0) addEdge(hubs[n.li], i, false);
    });
    hubs.forEach(h => { if (h >= 0) addEdge(homeIdx, h, false); });
  }

  const adj = nodes.map(() => []);
  const links = nodes.map(() => 0);
  edges.forEach((e, i) => {
    adj[e.a].push(i); adj[e.b].push(i);
    if (!e.v) { links[e.a]++; links[e.b]++; }
  });

  return { nodes, edges, adj, links, byPath, courses, homeIdx, noteCount: files.length };
}

function buildDust() {
  const r = rng(1234);
  const dust = [];
  for (let k = 0; k < 700; k++) {
    const u = r() * 2 - 1, t = r() * 6.283, s = Math.sqrt(1 - u * u);
    const dx = s * Math.cos(t), dy = u, dz = s * Math.sin(t);
    const g = 1 - 0.05 * Math.abs(Math.sin(dz * 9 + dy * 4) * Math.sin(dy * 7 - dx * 3));
    const x = dx * BX * g, y = (dy > 0 ? dy * BY * 0.75 : dy * BY) * g, z = dz * BZ * g;
    if (Math.abs(x) < 6 || (eCb(x, y, z) < 1 && y > 30 && z > 70)) continue;
    dust.push({ x, y, z, c: 0 });
  }
  for (let k = 0; k < 170; k++) {
    const u = r() * 2 - 1, t = r() * 6.283, s = Math.sqrt(1 - u * u);
    const fy = Math.round(u * 5) / 5;
    const x = s * Math.cos(t) * 82, y = 62 + fy * 34, z = 112 + s * Math.sin(t) * 48;
    if (eMain(x, y, z) < 1) continue;
    dust.push({ x, y, z, c: 1 });
  }
  for (let k = 0; k < 30; k++) {
    const t = k / 29;
    dust.push({ x: (r() - 0.5) * 14, y: 70 + t * 95, z: 58 + t * 8 + (r() - 0.5) * 8, c: 2 });
  }
  return dust;
}

/* ---------- renderer ---------- */

const EEG_H = 114;

class BrainRenderer {
  constructor(view, canvas) {
    this.view = view;
    this.plugin = view.plugin;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this.W = 0; this.H = 0;
    this.dust = buildDust();
    this.model = null;
    this.reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.spin = !this.reduce;
    this.rot = 1.35; this.tilt = 0.32; this.zoom = 1;
    this.bootT = this.reduce ? 20 : 0;
    this.hover = -1; this.lock = 0;
    this.pulses = []; this.fireT = 0; this.glitch = 0;
    this.act = [0, 0, 0, 0, 0];
    this.hist = REGIONS.map(() => []);
    this.rand = rng(777);
    this.last = performance.now();
    this.running = false;
    this.drag = null;
    this.mx = -1; this.my = -1;
    this.bindEvents();
  }

  get settings() { return this.plugin.settings; }

  setModel(model) {
    this.model = model;
    this.hover = -1; this.lock = 0; this.pulses = [];
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.W = Math.max(1, Math.round(r.width));
    this.H = Math.max(1, Math.round(r.height));
    this.canvas.width = this.W * this.dpr;
    this.canvas.height = this.H * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const len = Math.max(600, this.W);
    this.hist = this.hist.map(h => { const a = h.slice(-len); while (a.length < len) a.unshift(0); return a; });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.schedule();
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.timer) clearTimeout(this.timer);
    this.raf = null; this.timer = null;
  }

  schedule() {
    if (!this.running) return;
    this.raf = requestAnimationFrame(t => this.frame(t));
  }

  replayBoot() { this.bootT = this.reduce ? 20 : 0; this.pulses = []; }

  get areaH() { return Math.max(160, this.H - EEG_H); }
  get scale() { return Math.min(this.W / 400, this.areaH / 370) * this.zoom; }
  get dotScale() { return Math.min(1.25, Math.sqrt(this.scale)); }
  get cy() { return this.areaH * 0.466; }

  P(p) {
    const c = Math.cos(this.rot), s = Math.sin(this.rot);
    const x1 = p.x * c - p.z * s, z1 = p.x * s + p.z * c;
    const ct = Math.cos(this.tilt), st = Math.sin(this.tilt);
    const y2 = p.y * ct - z1 * st, z2 = p.y * st + z1 * ct;
    const f = 620 / (620 + z2), S = this.scale;
    return [this.W / 2 + x1 * f * S, this.cy + y2 * f * S, f, z2];
  }

  pt3(e, t) {
    const N = this.model.nodes, A = N[e.a], B = N[e.b];
    if (e.w) {
      const u = 1 - t;
      return { x: u * u * A.x + t * t * B.x, y: u * u * A.y + 2 * u * t * 10 + t * t * B.y, z: u * u * A.z + 2 * u * t * 20 + t * t * B.z };
    }
    return { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, z: A.z + (B.z - A.z) * t };
  }

  regionIndex(n) { return n.li >= 0 && n.li < REGIONS.length ? n.li : -1; }

  fire(i, d) {
    const m = this.model;
    if (!m || i < 0 || i >= m.nodes.length) return;
    const n = m.nodes[i];
    n.f = 1;
    const ri = this.regionIndex(n);
    if (ri >= 0) this.act[ri] = Math.min(1.6, this.act[ri] + 0.5);
    if (d <= 0 || this.pulses.length > 110) return;
    m.adj[i].forEach(ei => {
      if (this.rand() < 0.55) {
        const e = m.edges[ei];
        this.pulses.push({ e, rev: e.b === i, t: 0, d: d - 1, v: 1 + this.rand() * 0.8 });
      }
    });
  }

  firePath(path, depth) {
    if (!this.model) return;
    const i = this.model.byPath.get(path);
    if (i !== undefined) this.fire(i, depth);
  }

  visible(n) {
    if (n.li === -1) return this.bootT > 1.9;
    if (n.li === CORE_INDEX) return this.bootT > 2.0;
    return this.bootT > 2.2 + n.li * 0.35;
  }

  nodeColor(n) {
    if (n.li >= 0 && n.li < REGIONS.length) return REGIONS[n.li].col;
    if (n.li === CORE_INDEX) return CORE_COLOR;
    return '#ffffff';
  }

  aberrate(text, x, y, col) {
    const X = this.ctx;
    X.fillStyle = 'rgba(255,40,90,0.55)'; X.fillText(text, x - 1.2, y);
    X.fillStyle = 'rgba(0,229,255,0.55)'; X.fillText(text, x + 1.2, y);
    X.fillStyle = col; X.fillText(text, x, y);
  }

  frame(now) {
    this.raf = null;
    if (!this.running) return;
    const shown = typeof this.canvas.isShown === 'function' ? this.canvas.isShown() : true;
    if (!shown || !this.model || this.W < 2) {
      this.last = now;
      this.timer = setTimeout(() => { this.timer = null; this.schedule(); }, 400);
      return;
    }
    try { this.draw(now); } catch (err) { console.error('[cyber-brain]', err); }
    this.schedule();
  }

  draw(now) {
    const X = this.ctx, W = this.W, H = this.H, areaH = this.areaH, s = this.settings, m = this.model;
    const N = m.nodes, E = m.edges, reduce = this.reduce;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.bootT += dt;
    if (this.spin && !this.drag) this.rot += dt * s.rotationSpeed;
    const p = now / 1000, done = this.bootT > 4;

    X.fillStyle = '#04050b'; X.fillRect(0, 0, W, H);
    X.fillStyle = 'rgba(0,229,255,0.05)';
    for (let x = 12; x < W; x += 24) for (let y = 12; y < areaH; y += 24) X.fillRect(x, y, 1.2, 1.2);

    const scan = reduce ? 0.45 : (p * 0.18) % 1;
    const ys = -BY - 10 + scan * (BY * 0.75 + BY + 90);
    const da = Math.max(0, Math.min(1, (this.bootT - 1.1) / 1.4));
    const S = this.scale;

    for (const d of this.dust) {
      const [x, y, f] = this.P(d), near = Math.abs(d.y - ys) < 7;
      X.globalAlpha = da * (near ? 0.95 : Math.max(0.05, 0.12 + 0.35 * (f - 0.75)));
      X.fillStyle = near ? '#e8fbff' : (d.c === 1 ? '#ffb800' : CYAN);
      const sz = (near ? 2 : 1.4) * Math.max(0.8, S);
      X.fillRect(x - sz / 2, y - sz / 2, sz, sz);
    }
    X.globalAlpha = 1;

    if (done || reduce) {
      const yy = ys > 0 ? ys / (BY * 0.75) : ys / BY, k = 1 - yy * yy;
      if (k > 0) {
        X.strokeStyle = 'rgba(0,229,255,0.55)'; X.shadowColor = CYAN; X.shadowBlur = 10; X.lineWidth = 1;
        X.beginPath();
        for (let a = 0; a <= 6.3; a += 0.1) {
          const [x, y] = this.P({ x: BX * Math.sqrt(k) * Math.cos(a) * 1.04, y: ys, z: BZ * Math.sqrt(k) * Math.sin(a) * 1.04 });
          a ? X.lineTo(x, y) : X.moveTo(x, y);
        }
        X.stroke(); X.shadowBlur = 0;
      }
    }

    const Pn = N.map(n => this.P(n));
    const hover = this.hover;
    let hs = null;
    if (hover >= 0 && hover < N.length) {
      hs = new Set([hover]);
      m.adj[hover].forEach(ei => { const e = E[ei]; hs.add(e.a === hover ? e.b : e.a); });
    }

    const edgeK = Math.min(1, Math.sqrt(180 / Math.max(1, E.length)));
    X.lineWidth = 0.8;
    for (const e of E) {
      const A = N[e.a], B = N[e.b];
      if (!this.visible(A) || !this.visible(B)) continue;
      const on = hs && (e.a === hover || e.b === hover);
      const col = this.nodeColor(A.li === -1 ? B : A);
      let alpha;
      if (on) alpha = 0.95;
      else if (hs) alpha = 0.04;
      else if (e.w) alpha = (e.v ? 0.1 : 0.16) * Math.max(0.5, edgeK);
      else alpha = (e.v ? 0.16 : 0.28) * Pn[e.a][2] * Math.max(0.55, edgeK);
      X.globalAlpha = alpha;
      X.strokeStyle = on ? '#e8fbff' : (e.w ? '#ffffff' : col);
      X.beginPath();
      if (e.w) {
        for (let t = 0; t <= 1.001; t += 0.1) {
          const [x, y] = this.P(this.pt3(e, t));
          t ? X.lineTo(x, y) : X.moveTo(x, y);
        }
      } else {
        X.moveTo(Pn[e.a][0], Pn[e.a][1]); X.lineTo(Pn[e.b][0], Pn[e.b][1]);
      }
      X.stroke();
    }
    X.globalAlpha = 1;

    if (done) {
      if (!reduce && s.ambientSignals) {
        this.fireT -= dt;
        if (this.fireT < 0) { this.fireT = 0.3 + this.rand() * 0.3; this.fire(Math.floor(this.rand() * N.length), 2); }
      }
      this.pulses = this.pulses.filter(q => {
        q.t += dt * q.v;
        if (q.t >= 1) { this.fire(q.rev ? q.e.a : q.e.b, q.d); return false; }
        return true;
      });
      for (const q of this.pulses) {
        const [x, y] = this.P(this.pt3(q.e, q.rev ? 1 - q.t : q.t));
        X.fillStyle = '#fff'; X.shadowColor = '#fff'; X.shadowBlur = 9;
        X.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
        X.shadowBlur = 0;
      }
    }

    const order = N.map((n, i) => i).sort((a, b) => Pn[b][3] - Pn[a][3]);
    for (const i of order) {
      const n = N[i];
      if (!this.visible(n)) continue;
      const [x, y, f] = Pn[i], col = this.nodeColor(n), dim = hs && !hs.has(i), sc = Math.abs(n.y - ys) < 9;
      n.f = Math.max(0, n.f - dt * 2.2);
      X.globalAlpha = dim ? 0.15 : Math.min(1, 0.35 + 0.7 * f);
      X.shadowColor = col;
      X.shadowBlur = dim ? 0 : (8 + n.f * 18 + (sc ? 10 : 0)) * f;
      X.fillStyle = n.f > 0.4 || sc ? '#ffffff' : col;
      X.beginPath(); X.arc(x, y, Math.max(0.8, (n.r + n.f * 2) * f * this.dotScale), 0, 7); X.fill();
      X.shadowBlur = 0; X.globalAlpha = 1;
    }

    X.textAlign = 'center';
    const boxes = [];
    const fits = (x, y, w) => {
      const b = [x - w / 2 - 3, y - 11, x + w / 2 + 3, y + 3];
      if (boxes.some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1])) return false;
      boxes.push(b); return true;
    };
    const ds = this.dotScale;
    const labelOrder = N.map((n, i) => i).filter(i => this.visible(N[i]) && (N[i].hub || (hs && hs.has(i))))
      .sort((a, b) => (a === hover ? -1 : b === hover ? 1 : 0) || (N[b].hub ? 1 : 0) - (N[a].hub ? 1 : 0) || m.links[b] - m.links[a]);
    for (const i of labelOrder) {
      const n = N[i], [x, y, f] = Pn[i], dim = hs && !hs.has(i), col = this.nodeColor(n);
      if (n.hub) {
        X.font = '500 12px ' + FONT;
        const ly = y - n.r * f * ds - 9;
        fits(x, ly, X.measureText(n.label).width);
        X.globalAlpha = dim ? 0.15 : Math.min(1, 0.45 + f * 0.6);
        this.aberrate(n.label, x, ly, col);
      } else {
        X.font = '11px ' + FONT;
        const ly = y + n.r * f * ds + 13;
        if (!fits(x, ly, X.measureText(n.label).width)) continue;
        X.globalAlpha = Math.min(1, 0.3 + f * 0.7);
        X.fillStyle = 'rgba(4,8,16,0.6)';
        const w = X.measureText(n.label).width;
        X.fillRect(x - w / 2 - 2, ly - 10, w + 4, 13);
        X.fillStyle = 'rgba(200,245,255,0.9)'; X.fillText(n.label, x, ly);
      }
      X.globalAlpha = 1;
    }

    if (hover >= 0 && hover < N.length && done) {
      this.lock = Math.min(1, this.lock + dt * 4);
      const n = N[hover], [x, y, f] = Pn[hover], col = this.nodeColor(n);
      const sz = (n.r * f * this.dotScale + 10) + (1 - this.lock) * 30;
      X.strokeStyle = col; X.lineWidth = 1.4;
      [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([dx, dy]) => {
        X.beginPath();
        X.moveTo(x + dx * sz, y + dy * (sz - 7)); X.lineTo(x + dx * sz, y + dy * sz); X.lineTo(x + dx * (sz - 7), y + dy * sz);
        X.stroke();
      });
      if (this.lock > 0.9) {
        const ri = this.regionIndex(n), c = ri >= 0 ? m.courses[ri] : null;
        const title = n.hub && c ? (c.code + ' ' + c.name) : n.label;
        X.font = '500 12px ' + FONT;
        const pw = Math.min(W - 16, Math.max(180, Math.min(320, X.measureText(title).width + 28)));
        let px = x + sz + 14 > W - pw - 20 ? x - sz - pw - 14 : x + sz + 14;
        let py = Math.max(14, Math.min(areaH - 90, y - 40));
        if (px < 8) {
          // no room beside the node (narrow screens): put the panel below it, or above if it would overflow
          px = Math.max(8, Math.min(W - pw - 8, x - pw / 2));
          py = y + sz + 12 + 82 < areaH ? y + sz + 12 : Math.max(8, y - sz - 12 - 82);
        }
        X.fillStyle = 'rgba(4,8,16,0.88)'; X.fillRect(px, py, pw, 82);
        X.strokeStyle = 'rgba(0,229,255,0.5)'; X.lineWidth = 1; X.strokeRect(px + 0.5, py + 0.5, pw, 82);
        X.fillStyle = col; X.fillRect(px, py, 3, 82);
        X.textAlign = 'left';
        X.fillStyle = '#e8fbff'; X.fillText(title, px + 12, py + 20);
        X.font = '11px ' + FONT; X.fillStyle = 'rgba(160,230,245,0.85)';
        const region = c ? c.key : (n.li === CORE_INDEX ? 'core' : 'brainstem');
        const course = c ? c.code : (n.li === CORE_INDEX ? 'unfiled' : 'vault root');
        X.fillText('region  ' + region, px + 12, py + 40);
        X.fillText('course  ' + course, px + 12, py + 56);
        X.fillText('links   ' + m.links[hover], px + 12, py + 72);
      }
    } else this.lock = 0;

    const visCount = N.filter(n => this.visible(n)).length;
    X.textAlign = 'left'; X.font = '11px ' + FONT; X.fillStyle = 'rgba(0,229,255,0.75)';
    X.fillText('NEURAL MAP  ' + this.view.app.vault.getName().toUpperCase(), 18, 28);
    X.fillText('SYNAPSES  ' + visCount, 18, 44);
    X.fillText('SIGNALS   ' + String(this.pulses.length).padStart(2, '0'), 18, 60);
    X.textAlign = 'right';
    const deg = ((Math.round(this.rot * 57.2958) % 360) + 360) % 360;
    X.fillText('ROT  ' + String(deg).padStart(3, '0') + '°', W - 18, 28);
    X.fillText('SCAN ' + String(Math.round(scan * 100)).padStart(3, '0') + '%', W - 18, 44);
    X.fillText(new Date().toTimeString().slice(0, 8), W - 18, 60);
    X.textAlign = 'left';

    X.strokeStyle = 'rgba(0,229,255,0.5)'; X.lineWidth = 1.2;
    const by = areaH - 2;
    [[10, 10, 1, 1], [W - 10, 10, -1, 1], [10, by, 1, -1], [W - 10, by, -1, -1]].forEach(([x, y, dx, dy]) => {
      X.beginPath(); X.moveTo(x + dx * 18, y); X.lineTo(x, y); X.lineTo(x, y + dy * 18); X.stroke();
    });

    const top = areaH + 16;
    X.fillStyle = 'rgba(0,229,255,0.04)'; X.fillRect(0, top - 10, W, H - top + 10);
    X.strokeStyle = 'rgba(0,229,255,0.25)'; X.beginPath(); X.moveTo(0, top - 10); X.lineTo(W, top - 10); X.stroke();
    REGIONS.forEach((r, li) => {
      this.act[li] = Math.max(0, this.act[li] - dt * 0.9);
      const h = this.hist[li];
      const on = this.bootT > 2.2 + li * 0.35 ? 1 : 0;
      h.shift();
      h.push((Math.sin(p * (9 + li * 3)) * 0.5 + Math.sin(p * (23 + li * 5)) * 0.3 + (this.rand() - 0.5) * 0.6) * (0.12 + this.act[li] * 0.7) * on);
      const y0 = top + 6 + li * 19;
      X.fillStyle = r.col; X.font = '11px ' + FONT;
      X.fillText(m.courses[li].short, 14, y0 + 4);
      X.strokeStyle = r.col; X.lineWidth = 1;
      X.beginPath();
      const n0 = Math.max(0, h.length - (W - 100));
      for (let k = n0; k < h.length; k++) {
        const x = 84 + k - n0, y = y0 + h[k] * 9;
        k === n0 ? X.moveTo(x, y) : X.lineTo(x, y);
      }
      X.stroke();
    });

    if (this.bootT < 4.6) {
      X.font = '12px ' + FONT;
      X.fillStyle = 'rgba(0,229,255,' + Math.max(0, Math.min(1, 4.6 - this.bootT)) + ')';
      const lines = [
        '> mount vault ' + this.view.vaultPath(),
        '> map ' + m.courses.filter(c => c.folder).length + ' courses to cortex ... ok',
        '> wire ' + E.length + ' synapses ... ok',
        '> neural link online',
      ];
      lines.forEach((l, k) => {
        const ch = Math.floor(Math.max(0, this.bootT - k * 0.5) * 42);
        if (ch > 0) X.fillText(l.slice(0, ch) + (ch < l.length && Math.floor(now / 250) % 2 ? '_' : ''), 18, areaH - 90 + k * 18);
      });
    }

    if (s.scanlines) {
      X.fillStyle = 'rgba(0,0,0,0.16)';
      for (let y = 0; y < H; y += 3) X.fillRect(0, y, W, 1);
    }

    if (!reduce && done && s.glitch) {
      this.glitch -= dt;
      if (this.glitch < -7) this.glitch = 0.12;
      if (this.glitch > 0) {
        const y = Math.floor(this.rand() * (areaH - 10)), h = 6 + this.rand() * 18;
        X.drawImage(this.canvas, 0, y * this.dpr, W * this.dpr, h * this.dpr, (this.rand() - 0.5) * 14, y, W, h);
      }
    }
  }

  pick(mx, my) {
    if (!this.model) return -1;
    let best = -1, bd = 200;
    this.model.nodes.forEach((n, i) => {
      if (!this.visible(n)) return;
      const [x, y] = this.P(n), d = (x - mx) ** 2 + (y - my) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  bindEvents() {
    const c = this.canvas;
    const pos = e => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    this.view.registerDomEvent(c, 'pointerdown', e => {
      if (e.button !== 0) return;
      const [x, y] = pos(e);
      this.drag = { x, y, sx: x, sy: y, moved: false, rot: this.rot, tilt: this.tilt };
      // touch screens have no hover, so a tap must pick the node itself
      const h = this.pick(x, y);
      if (h !== this.hover) this.lock = 0;
      this.hover = h;
      c.setPointerCapture(e.pointerId);
    });
    this.view.registerDomEvent(c, 'pointermove', e => {
      const [x, y] = pos(e);
      this.mx = x; this.my = y;
      if (this.drag) {
        const dx = x - this.drag.sx, dy = y - this.drag.sy;
        if (Math.abs(dx) + Math.abs(dy) > 4) { this.drag.moved = true; c.addClass('is-dragging'); }
        if (this.drag.moved) {
          this.rot = this.drag.rot + dx * 0.008;
          this.tilt = Math.max(-0.4, Math.min(1.0, this.drag.tilt + dy * 0.005));
          return;
        }
      }
      const h = this.pick(x, y);
      if (h !== this.hover) this.lock = 0;
      this.hover = h;
      c.toggleClass('is-over-node', h >= 0 && !!this.model.nodes[h].path);
    });
    this.view.registerDomEvent(c, 'pointerup', e => {
      const d = this.drag;
      this.drag = null;
      c.removeClass('is-dragging');
      try { c.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      if (d && !d.moved && this.hover >= 0) {
        const n = this.model.nodes[this.hover];
        if (n.path) this.view.openNote(n.path, e.ctrlKey || e.metaKey);
      }
    });
    this.view.registerDomEvent(c, 'pointerleave', e => {
      // a lifted finger also "leaves"; keep the tapped node locked on touch screens
      if (!this.drag && e.pointerType !== 'touch') { this.hover = -1; c.removeClass('is-over-node'); }
    });
    this.view.registerDomEvent(c, 'wheel', e => {
      e.preventDefault();
      this.zoom = Math.max(0.6, Math.min(2.6, this.zoom * Math.exp(-e.deltaY * 0.001)));
    }, { passive: false });
    this.view.registerDomEvent(c, 'dblclick', () => { this.zoom = 1; this.tilt = 0.32; });
  }
}

/* ---------- view ---------- */

class CyberBrainView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.renderer = null;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Cyber brain'; }
  getIcon() { return 'brain-circuit'; }

  vaultPath() {
    const a = this.app.vault.adapter;
    const p = a && typeof a.getBasePath === 'function' ? a.getBasePath() : this.app.vault.getName();
    return String(p).replace(/\\/g, '/');
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();

    const bar = root.createDiv({ cls: 'cyber-brain-toolbar' });
    const replay = bar.createEl('button', { attr: { 'aria-label': 'Replay boot sequence' } });
    setIcon(replay.createSpan(), 'refresh-cw');
    replay.createSpan({ text: 'Replay boot' });
    const pause = bar.createEl('button', { attr: { 'aria-label': 'Pause or resume rotation' } });
    const pauseIcon = pause.createSpan();
    const pauseText = pause.createSpan();

    const stage = root.createDiv({ cls: 'cyber-brain-stage' });
    const canvas = stage.createEl('canvas', { cls: 'cyber-brain-canvas' });
    this.renderer = new BrainRenderer(this, canvas);

    const syncPause = () => {
      setIcon(pauseIcon, this.renderer.spin ? 'pause' : 'play');
      pauseText.setText(this.renderer.spin ? 'Pause rotation' : 'Resume rotation');
    };
    syncPause();
    this.registerDomEvent(replay, 'click', () => this.renderer.replayBoot());
    this.registerDomEvent(pause, 'click', () => { this.renderer.spin = !this.renderer.spin; syncPause(); });

    this.refresh();
    this.ro = new ResizeObserver(() => this.renderer && this.renderer.resize());
    this.ro.observe(stage);
    this.renderer.resize();
    this.renderer.start();
  }

  refresh() {
    if (this.renderer) this.renderer.setModel(buildModel(this.app, this.plugin.settings));
  }

  openNote(path, split) {
    this.app.workspace.openLinkText(path, '', split ? 'split' : 'tab').catch(() => {});
  }

  async onClose() {
    if (this.ro) this.ro.disconnect();
    if (this.renderer) this.renderer.stop();
    this.renderer = null;
  }
}

/* ---------- settings ---------- */

class CyberBrainSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const el = this.containerEl;
    el.empty();
    const folders = this.app.vault.getRoot().children.filter(f => f instanceof TFolder).map(f => f.path).sort();

    new Setting(el).setName('Brain regions').setHeading();
    const notes = {
      frontal: 'Planning and logic',
      parietal: 'Maths and spatial reasoning',
      temporal: 'Memory and language',
      occipital: 'Vision and design',
      cerebellum: 'Low-level control',
    };
    REGIONS.forEach(r => {
      new Setting(el)
        .setName(r.key.charAt(0).toUpperCase() + r.key.slice(1))
        .setDesc(notes[r.key])
        .addText(t => t.setPlaceholder('Label').setValue(this.plugin.settings.labels[r.key] || '')
          .onChange(async v => { this.plugin.settings.labels[r.key] = v; await this.plugin.saveAndRefresh(); }))
        .addDropdown(d => {
          d.addOption('', '— none —');
          folders.forEach(f => d.addOption(f, f));
          d.setValue(this.plugin.settings.regions[r.key] || '');
          d.onChange(async v => { this.plugin.settings.regions[r.key] = v; await this.plugin.saveAndRefresh(); });
        });
    });

    new Setting(el)
      .setName('Brainstem note')
      .setDesc('The note that sits at the brainstem and connects every region.')
      .addText(t => t.setPlaceholder('Home.md').setValue(this.plugin.settings.homeNote)
        .onChange(async v => { this.plugin.settings.homeNote = v.trim(); await this.plugin.saveAndRefresh(); }));

    new Setting(el).setName('Wiring').setHeading();
    this.toggle(el, 'folderWiring', 'Folder wiring', 'Draw faint links from each note to its course hub, and from the brainstem to every hub.', true);
    this.toggle(el, 'showUnmapped', 'Notes outside courses', 'Show notes from other folders in the brain core.', true);

    new Setting(el).setName('Effects').setHeading();
    this.toggle(el, 'ambientSignals', 'Ambient signals', 'Fire random signals between notes while idle.');
    this.toggle(el, 'signalsOnOpen', 'Signals on open', 'Fire a signal from a note whenever you open or edit it.');
    this.toggle(el, 'glitch', 'Glitch', 'A brief horizontal tear every few seconds.');
    this.toggle(el, 'scanlines', 'Scanlines', 'CRT-style horizontal lines over the view.');
    new Setting(el)
      .setName('Rotation speed')
      .addSlider(sl => sl.setLimits(0, 0.6, 0.02).setValue(this.plugin.settings.rotationSpeed).setDynamicTooltip()
        .onChange(async v => { this.plugin.settings.rotationSpeed = v; await this.plugin.saveSettings(); }));
  }

  toggle(el, key, name, desc, rebuild) {
    new Setting(el).setName(name).setDesc(desc).addToggle(t => t.setValue(!!this.plugin.settings[key])
      .onChange(async v => {
        this.plugin.settings[key] = v;
        if (rebuild) await this.plugin.saveAndRefresh(); else await this.plugin.saveSettings();
      }));
  }
}

/* ---------- plugin ---------- */

class CyberBrainPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.registerView(VIEW_TYPE, leaf => new CyberBrainView(leaf, this));
    this.addRibbonIcon('brain-circuit', 'Open cyber brain', () => this.activateView());
    this.addCommand({ id: 'open-cyber-brain', name: 'Open cyber brain', callback: () => this.activateView() });
    this.addCommand({
      id: 'replay-boot', name: 'Replay boot sequence',
      callback: () => this.views().forEach(v => v.renderer && v.renderer.replayBoot()),
    });
    this.addSettingTab(new CyberBrainSettingTab(this.app, this));

    this.refreshSoon = obsidian.debounce(() => this.refreshViews(), 1500, true);
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.refreshSoon()));
    this.registerEvent(this.app.vault.on('create', () => this.refreshSoon()));
    this.registerEvent(this.app.vault.on('delete', () => this.refreshSoon()));
    this.registerEvent(this.app.vault.on('rename', () => this.refreshSoon()));
    this.registerEvent(this.app.workspace.on('file-open', file => {
      if (file && this.settings.signalsOnOpen) this.views().forEach(v => v.renderer && v.renderer.firePath(file.path, 3));
    }));
    this.registerEvent(this.app.vault.on('modify', file => {
      if (file && this.settings.signalsOnOpen) this.views().forEach(v => v.renderer && v.renderer.firePath(file.path, 1));
    }));
  }

  onunload() {}

  views() {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).map(l => l.view).filter(v => v instanceof CyberBrainView);
  }

  refreshViews() { this.views().forEach(v => v.refresh()); }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    this.settings.regions = Object.assign({}, DEFAULT_SETTINGS.regions, data.regions || {});
    this.settings.labels = Object.assign({}, DEFAULT_SETTINGS.labels, data.labels || {});
  }

  async saveSettings() { await this.saveData(this.settings); }

  async saveAndRefresh() { await this.saveSettings(); this.refreshViews(); }
}

module.exports = CyberBrainPlugin;
module.exports._internals = { buildModel, buildDust, BrainRenderer, lobeAt, DEFAULT_SETTINGS };
