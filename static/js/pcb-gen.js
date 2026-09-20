/* Standalone procedural PCB texture generator — no DOM knowledge.
   PCB.generate(w, h, opts) -> { w, h, traces, vias, comps }
   PCB.render(geometry) -> <svg>

   Simple by design: scatter components across the board, then find every
   pair that directly faces each other (their edges overlap on the cross
   axis). Sort those candidate links furthest-apart first and add them one
   at a time, skipping any that would cross a connector already placed —
   so the biggest spanning buses stake their claim on the empty board first,
   and everything shorter just fills in around them. Each accepted link's
   two facing edges get pins lined up 1:1, and every route is at most one
   90° turn — dead straight when the edges already line up, one elbow
   bridging it when they don't. No occupancy grid, no lane-following, no
   via field. */
(() => {
  'use strict';
  const SVGNS = 'http://www.w3.org/2000/svg';

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const OPP_DIR = { r: 'l', l: 'r', t: 'b', b: 't' };

  function dedupe(pts) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i], q = out[out.length - 1];
      if (Math.abs(p.x - q.x) > 0.5 || Math.abs(p.y - q.y) > 0.5) out.push(p);
    }
    return out;
  }

  // rounds a ~90° corner to a short 45° mitre; anything else stays sharp
  function chamferPath(pts, r) {
    if (pts.length < 3)
      return 'M ' + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ');
    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
      const v1x = p1.x - p0.x, v1y = p1.y - p0.y, v2x = p2.x - p1.x, v2y = p2.y - p1.y;
      const turn = Math.abs(Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y));
      if (Math.abs(turn - Math.PI / 2) > 0.3) { d += ` L ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`; continue; }
      const d1 = dist(p1, p0) || 1, d2 = dist(p1, p2) || 1;
      const rr = Math.min(r, d1 / 2, d2 / 2);
      const A = { x: p1.x + ((p0.x - p1.x) / d1) * rr, y: p1.y + ((p0.y - p1.y) / d1) * rr };
      const B = { x: p1.x + ((p2.x - p1.x) / d2) * rr, y: p1.y + ((p2.y - p1.y) / d2) * rr };
      d += ` L ${A.x.toFixed(1)} ${A.y.toFixed(1)} L ${B.x.toFixed(1)} ${B.y.toFixed(1)}`;
    }
    const last = pts[pts.length - 1];
    d += ` L ${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
    return d;
  }

  // the line segment pins sit along, just outside one edge of a component
  function edgeSeg(box, key, standoff) {
    const o = standoff;
    switch (key) {
      case 't': return { a: { x: box.x, y: box.y - o }, b: { x: box.x + box.w, y: box.y - o } };
      case 'b': return { a: { x: box.x, y: box.y + box.h + o }, b: { x: box.x + box.w, y: box.y + box.h + o } };
      case 'l': return { a: { x: box.x - o, y: box.y }, b: { x: box.x - o, y: box.y + box.h } };
      default:  return { a: { x: box.x + box.w + o, y: box.y }, b: { x: box.x + box.w + o, y: box.y + box.h } };
    }
  }

  function generate(W, H, opts) {
    opts = opts || {};
    const rng = mulberry32(opts.seed || 1);
    const PITCH = opts.pitch || 11;         // ~px between pins along an edge
    const STANDOFF = opts.standoff || 7;    // pins sit this far outside the body

    // ---- scatter components ---------------------------------------------
    const comps = [];
    const compN = opts.components != null ? opts.components : Math.round((W * H) / 26000);
    for (let i = 0, tries = 0; i < compN && tries < compN * 30; tries++) {
      const s = rng();
      let cw, ch;
      if (s < 0.4) { cw = 34 + rng() * 70; ch = 14 + rng() * 10; }
      else if (s < 0.75) { cw = 14 + rng() * 10; ch = 34 + rng() * 70; }
      else { const q = 30 + rng() * 70; cw = q; ch = q * (0.8 + rng() * 0.4); }
      const x = 24 + rng() * Math.max(1, W - 48 - cw);
      const y = 24 + rng() * Math.max(1, H - 48 - ch);
      const clash = comps.some((k) => !(
        x > k.x + k.w + 18 || x + cw < k.x - 18 || y > k.y + k.h + 18 || y + ch < k.y - 18));
      if (clash) continue;
      comps.push({ x, y, w: cw, h: ch });
      i++;
    }

    // is some third component sitting in the straight corridor between
    // i and j's facing edges — i.e. does it actually block line of sight?
    function corridorBlocked(i, j, dir) {
      const a = comps[i], b = comps[j];
      let lo, hi, axis;
      if (dir === 'r') { lo = a.x + a.w; hi = b.x; axis = 'x'; }
      else if (dir === 'l') { lo = b.x + b.w; hi = a.x; axis = 'x'; }
      else if (dir === 'b') { lo = a.y + a.h; hi = b.y; axis = 'y'; }
      else { lo = b.y + b.h; hi = a.y; axis = 'y'; }
      const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y + a.h, b.y + b.h);
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x + a.w, b.x + b.w);
      return comps.some((c, k) => {
        if (k === i || k === j) return false;
        return axis === 'x'
          ? (c.x < hi && c.x + c.w > lo && c.y < y1 && c.y + c.h > y0)
          : (c.y < hi && c.y + c.h > lo && c.x < x1 && c.x + c.w > x0);
      });
    }

    // ---- every pair of components that directly face each other, with a
    // clear line of sight (their edges overlap on the cross axis, nothing
    // else sits between them) is a candidate link; `gap` is the separation
    // between the two facing edges.
    const candidates = [];
    for (let i = 0; i < comps.length; i++) {
      for (let j = i + 1; j < comps.length; j++) {
        const a = comps[i], b = comps[j];
        const yOverlap = a.y < b.y + b.h && b.y < a.y + a.h;
        const xOverlap = a.x < b.x + b.w && b.x < a.x + a.w;
        let dir = null, gap = 0;
        if (yOverlap && !xOverlap) {
          dir = b.x > a.x ? 'r' : 'l';
          gap = dir === 'r' ? b.x - (a.x + a.w) : a.x - (b.x + b.w);
        } else if (xOverlap && !yOverlap) {
          dir = b.y > a.y ? 'b' : 't';
          gap = dir === 'b' ? b.y - (a.y + a.h) : a.y - (b.y + b.h);
        }
        if (dir && gap > 0 && !corridorBlocked(i, j, dir)) candidates.push({ i, j, dir, gap });
      }
    }
    // furthest-apart pair first: big spanning buses claim the empty board
    // before anything short has a chance to block their path
    candidates.sort((p, q) => q.gap - p.gap);

    // the wire bundle a candidate link would draw, before committing to it
    function buildWires(i, j, dir) {
      const segA = edgeSeg(comps[i], dir, STANDOFF);
      const segB = edgeSeg(comps[j], OPP_DIR[dir], STANDOFF);
      const lenA = dist(segA.a, segA.b), lenB = dist(segB.a, segB.b);
      const n = Math.max(2, Math.min(24, Math.round(Math.min(lenA, lenB) / PITCH)));
      const horiz = dir === 'r' || dir === 'l';
      const wires = [];
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const pinA = lerp(segA.a, segA.b, t);
        const pinB = lerp(segB.a, segB.b, t);
        // one turn at most: straight out from `i`, a single bend the rest
        // of the way in — dead straight when the two pins already line up
        const elbow = horiz ? { x: pinB.x, y: pinA.y } : { x: pinA.x, y: pinB.y };
        const poly = dedupe([pinA, elbow, pinB]);
        if (poly.length < 2) continue;
        const segs = [];
        for (let s = 0; s < poly.length - 1; s++) segs.push({ a: poly[s], b: poly[s + 1] });
        wires.push({ poly, segs });
      }
      return wires;
    }

    // do two axis-aligned segments overlap or cross? every segment here is
    // purely horizontal or purely vertical (that's all a single-elbow route
    // is ever made of), so each pairing is handled on its own terms rather
    // than as a generic shrunk-bbox test — that generic version quietly
    // never matched anything, since shrinking a zero-thickness segment's own
    // thin axis by EPS flips its min past its max.
    const EPS = 0.6;
    const isH = (s) => Math.abs(s.a.y - s.b.y) < 0.01;
    function segOverlap(s1, s2) {
      const h1 = isH(s1), h2 = isH(s2);
      if (h1 && h2) {                                    // both horizontal
        if (Math.abs(s1.a.y - s2.a.y) > EPS) return false;
        const a0 = Math.min(s1.a.x, s1.b.x) + EPS, a1 = Math.max(s1.a.x, s1.b.x) - EPS;
        const b0 = Math.min(s2.a.x, s2.b.x) + EPS, b1 = Math.max(s2.a.x, s2.b.x) - EPS;
        return a0 <= b1 && a1 >= b0;
      }
      if (!h1 && !h2) {                                  // both vertical
        if (Math.abs(s1.a.x - s2.a.x) > EPS) return false;
        const a0 = Math.min(s1.a.y, s1.b.y) + EPS, a1 = Math.max(s1.a.y, s1.b.y) - EPS;
        const b0 = Math.min(s2.a.y, s2.b.y) + EPS, b1 = Math.max(s2.a.y, s2.b.y) - EPS;
        return a0 <= b1 && a1 >= b0;
      }
      // one of each: do they actually cross in the middle? (touching at a
      // shared endpoint, e.g. one route's elbow sitting on another's pin,
      // doesn't count)
      const h = h1 ? s1 : s2, v = h1 ? s2 : s1;
      const hx0 = Math.min(h.a.x, h.b.x), hx1 = Math.max(h.a.x, h.b.x);
      const vy0 = Math.min(v.a.y, v.b.y), vy1 = Math.max(v.a.y, v.b.y);
      return v.a.x > hx0 + EPS && v.a.x < hx1 - EPS && h.a.y > vy0 + EPS && h.a.y < vy1 - EPS;
    }

    // ---- accept candidates furthest-first, skipping any that would cross
    // a connector already placed; wire up every pin on the ones that make it
    const acceptedSegs = [];
    const traces = [];
    const vias = [];
    let uid = 0;
    candidates.forEach(({ i, j, dir }) => {
      const wires = buildWires(i, j, dir);
      const allSegs = wires.flatMap((w) => w.segs);
      const clashes = allSegs.some((s) => acceptedSegs.some((o) => segOverlap(s, o)));
      if (clashes) return;
      acceptedSegs.push(...allSegs);
      wires.forEach(({ poly }) => {
        const elbow = poly.length > 2 ? poly[1] : null;
        const hot = rng() < 0.12;
        traces.push({ id: 't' + uid++, d: chamferPath(poly, 2.5 + rng() * 2.5), hot });
        if (elbow && rng() < 0.5) vias.push({ x: elbow.x, y: elbow.y, r: 0.8 + rng() * 0.6, hot });
      });
    });

    return { w: W, h: H, traces, vias, comps };
  }

  // ---- renderer ----------------------------------------------------
  function render(g) {
    const NS = SVGNS;
    const el = (t, a) => { const x = document.createElementNS(NS, t); for (const k in (a || {})) x.setAttribute(k, a[k]); return x; };
    const svg = el('svg', { width: g.w, height: g.h, viewBox: `0 0 ${g.w} ${g.h}` });
    const defs = el('defs');
    defs.innerHTML =
      '<radialGradient id="pcb-vig" cx="0.5" cy="0.44" r="0.78">' +
        '<stop offset="0" stop-color="#020610" stop-opacity="0"/>' +
        '<stop offset="0.66" stop-color="#020610" stop-opacity="0.16"/>' +
        '<stop offset="1" stop-color="#01030a" stop-opacity="0.72"/></radialGradient>';
    svg.appendChild(defs);
    svg.appendChild(el('rect', { width: g.w, height: g.h, fill: '#050d1a' }));

    // components
    const gc = el('g');
    g.comps.forEach((k) => gc.appendChild(el('rect', {
      x: k.x.toFixed(1), y: k.y.toFixed(1), width: k.w.toFixed(1), height: k.h.toFixed(1),
      rx: 1.5, fill: '#0c1721', stroke: 'rgba(92,162,216,0.3)', 'stroke-width': 0.6,
    })));
    svg.appendChild(gc);

    const line = (dd, stroke, wdt) => el('path', {
      d: dd, fill: 'none', stroke, 'stroke-width': wdt, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    });

    const gh = el('g');
    g.traces.forEach((t) => gh.appendChild(line(t.d, t.hot ? 'rgba(150,235,255,0.2)' : 'rgba(52,175,255,0.05)', t.hot ? 4 : 2)));
    svg.appendChild(gh);
    const gt = el('g');
    g.traces.forEach((t) => gt.appendChild(line(t.d, t.hot ? 'rgba(190,244,255,1)' : 'rgba(88,205,255,0.6)', t.hot ? 1.2 : 0.7)));
    svg.appendChild(gt);

    // vias at the bend points
    const gv = el('g');
    g.vias.forEach((v) => {
      gv.appendChild(el('circle', { cx: v.x.toFixed(1), cy: v.y.toFixed(1), r: v.r,
        fill: 'none', stroke: v.hot ? 'rgba(190,244,255,0.85)' : 'rgba(120,225,255,0.5)', 'stroke-width': 1 }));
      gv.appendChild(el('circle', { cx: v.x.toFixed(1), cy: v.y.toFixed(1), r: v.r * 0.45, fill: '#040a14' }));
    });
    svg.appendChild(gv);

    svg.appendChild(el('rect', { width: g.w, height: g.h, fill: 'url(#pcb-vig)' }));
    return svg;
  }

  window.PCB = { generate, render };
})();
