// Experimental: procedurally generates the page background as a real PCB —
// copper traces, vias and chip pads drawn as live SVG <path>/<circle>/<rect>
// elements (NOT a flat background image), so anything on the page can be lit
// up.
//
// Page elements tagged [data-chip] (the profile photo, the project cards, the
// heading panels) are treated as ICs sitting on the board. Routing is simple
// by design: each chip finds its nearest neighbour off each of its four
// edges, and the two facing edges get an evenly-spaced row of pins, pin i on
// one lining up 1:1 with pin i on the other. Most of those runs come out
// dead straight; the rest take exactly one 90° turn to bridge the offset —
// never more. A second, brighter copy of the whole board is masked to the
// cursor for the "engraved lines catch the light" effect.
//
// Because every trace is an addressable DOM node with a normalised
// pathLength of 1, moving light along one is just a dash animation. Public
// API:
//
//   CircuitBoard.pulse({ id?, kind?, color?, duration?, reverse?, trail? })
//                       send a light pulse along a trace (random if no id/kind)
//   CircuitBoard.pulsePath(id, opts)      pulse a specific trace by id
//   CircuitBoard.paths()                  -> [{ id, kind }] for every trace
//   CircuitBoard.element(id)              -> the underlying <path> node
//   CircuitBoard.regenerate()             re-route the whole board
(() => {
  'use strict';

  const SVGNS = 'http://www.w3.org/2000/svg';
  const SEED = 0x9e3779b9;   // fixed: layout stays stable across regenerations
  const mm = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ---- deterministic PRNG (mulberry32) -------------------------------------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };

  // ---- board geometry -----------------------------------------------------
  let geometry = null;

  function chipRects() {
    const sx = window.scrollX, sy = window.scrollY;
    const out = [];
    document.querySelectorAll('[data-chip]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 16) return;
      const kind = el.getAttribute('data-chip');
      out.push({
        el,
        pinned: kind !== 'label',
        shape: kind === 'round' ? 'circle' : 'rect',
        // text blocks: wider keep-out, and pads sit further off the raw text
        // bounding box (which hugs the glyphs) so marks never touch the copy.
        // boxes (cards) get a slim keep-out so a channel stays open between
        // tightly stacked ones for pin-to-pin wiring to thread through.
        keepout: kind === 'text' || kind === 'label' ? 28 : 10,
        padOut: kind === 'text' || kind === 'label' ? 14 : 0,
        x: r.left + sx, y: r.top + sy, w: r.width, h: r.height,
      });
    });
    return out;
  }

  function dedupe(pts) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i], q = out[out.length - 1];
      if (Math.abs(p.x - q.x) > 0.5 || Math.abs(p.y - q.y) > 0.5) out.push(p);
    }
    return out;
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // Build the path string. Right-angle corners get a 45-degree cut so a
  // single-bend route reads as a proper PCB mitre instead of a bare corner.
  function chamferPath(pts, r) {
    if (pts.length < 3)
      return 'M ' + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L ');
    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
      const v1x = p1.x - p0.x, v1y = p1.y - p0.y, v2x = p2.x - p1.x, v2y = p2.y - p1.y;
      const turn = Math.abs(Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y));
      if (Math.abs(turn - Math.PI / 2) > 0.3) {         // not ~90° → leave it sharp
        d += ` L ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
        continue;
      }
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

  // ====================================================================
  //  Simple edge-to-edge router. Each chip looks off its four sides for
  //  the nearest other chip; that pair of facing edges gets an evenly
  //  spaced row of pins, pin i on one matched straight to pin i on the
  //  other. A run is dead straight when the edges line up, and takes
  //  exactly one 90° turn otherwise — never more.
  // ====================================================================
  const OPP_DIR = { r: 'l', l: 'r', t: 'b', b: 't' };
  const STANDOFF = 7;    // pins sit this far outside the chip body
  const PITCH = 11;      // ~px between pins along an edge

  // the box routing sees for a chip — circles use their bounding square
  const chipBox = (ch) => ch.shape === 'circle'
    ? { x: ch.cx - ch.rad, y: ch.cy - ch.rad, w: ch.rad * 2, h: ch.rad * 2 }
    : ch;

  // the line segment pins sit along, just outside one edge of the box
  function edgeSeg(box, key, padOut) {
    const o = STANDOFF + (padOut || 0);
    switch (key) {
      case 't': return { a: { x: box.x, y: box.y - o }, b: { x: box.x + box.w, y: box.y - o } };
      case 'b': return { a: { x: box.x, y: box.y + box.h + o }, b: { x: box.x + box.w, y: box.y + box.h + o } };
      case 'l': return { a: { x: box.x - o, y: box.y }, b: { x: box.x - o, y: box.y + box.h } };
      default:  return { a: { x: box.x + box.w + o, y: box.y }, b: { x: box.x + box.w + o, y: box.y + box.h } };
    }
  }
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

  function generate() {
    const w = document.documentElement.clientWidth;
    const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const rng = mulberry32(SEED);

    const chips = chipRects();
    chips.forEach((c) => {
      c.cx = c.x + c.w / 2;
      c.cy = c.y + c.h / 2;
      if (c.shape === 'circle') c.rad = Math.min(c.w, c.h) / 2;
    });

    // scatter a few decorative surface-mount ICs among the real elements
    const synthChips = [];
    const synthTarget = Math.round((w * h) / 90000) + 6;
    for (let n = 0, tries = 0; n < synthTarget && tries < synthTarget * 22; tries++) {
      const shp = rng();
      let cw, chh;
      if (shp < 0.4) { cw = 34 + rng() * 48; chh = 13 + rng() * 7; }
      else if (shp < 0.78) { cw = 13 + rng() * 7; chh = 34 + rng() * 48; }
      else { const s = 24 + rng() * 20; cw = s; chh = s * (0.9 + rng() * 0.2); }
      const rc = {
        x: 34 + rng() * Math.max(1, w - 68 - cw),
        y: 40 + rng() * Math.max(1, h - 80 - chh),
        w: cw, h: chh,
      };
      const clash = chips.some((c) => !(
        rc.x > c.x + c.w + 24 || rc.x + rc.w < c.x - 24 ||
        rc.y > c.y + c.h + 24 || rc.y + rc.h < c.y - 24));
      if (clash) continue;
      rc.cx = rc.x + rc.w / 2; rc.cy = rc.y + rc.h / 2;
      rc.shape = 'rect'; rc.pinned = true; rc.synthetic = true; rc.keepout = 9;
      rc.el = null; rc.padOut = 0;
      chips.push(rc); synthChips.push(rc); n++;
    }

    // chips that get wires: pinned, and not a text/label keep-out zone
    const routable = [];
    chips.forEach((c, i) => {
      if (!c.pinned) return;
      if (!c.synthetic && (c.keepout || 0) >= 20) return;
      routable.push({ i, box: chipBox(c) });
    });
    // text/label blocks stay pure keep-outs: a route never crosses one
    const textBoxes = chips.filter((c) => !c.synthetic && (c.keepout || 0) >= 20);

    // does a text block sit in the straight corridor between two facing edges?
    function corridorBlocked(from, to, dir) {
      let lo, hi, axis;
      if (dir === 'r') { lo = from.x + from.w; hi = to.x; axis = 'x'; }
      else if (dir === 'l') { lo = to.x + to.w; hi = from.x; axis = 'x'; }
      else if (dir === 'b') { lo = from.y + from.h; hi = to.y; axis = 'y'; }
      else { lo = to.y + to.h; hi = from.y; axis = 'y'; }
      const y0 = Math.min(from.y, to.y), y1 = Math.max(from.y + from.h, to.y + to.h);
      const x0 = Math.min(from.x, to.x), x1 = Math.max(from.x + from.w, to.x + to.w);
      return textBoxes.some((t) => axis === 'x'
        ? (t.x < hi && t.x + t.w > lo && t.y < y1 && t.y + t.h > y0)
        : (t.y < hi && t.y + t.h > lo && t.x < x1 && t.x + t.w > x0));
    }

    // nearest routable neighbour from `box` in direction `dir`, sharing at
    // least a sliver of the perpendicular edge
    function nearest(box, dir) {
      let best = -1, bestGap = Infinity;
      routable.forEach(({ i, box: o }) => {
        if (o === box) return;
        let gap;
        if (dir === 'r') { gap = o.x - (box.x + box.w); if (gap <= 0 || o.y + o.h < box.y || o.y > box.y + box.h) return; }
        else if (dir === 'l') { gap = box.x - (o.x + o.w); if (gap <= 0 || o.y + o.h < box.y || o.y > box.y + box.h) return; }
        else if (dir === 'b') { gap = o.y - (box.y + box.h); if (gap <= 0 || o.x + o.w < box.x || o.x > box.x + box.w) return; }
        else { gap = box.y - (o.y + o.h); if (gap <= 0 || o.x + o.w < box.x || o.x > box.x + box.w) return; }
        if (gap < bestGap) { bestGap = gap; best = i; }
      });
      return best;
    }

    // one link per unordered pair; `dir` records a's side facing b
    const links = new Map();
    routable.forEach(({ i, box }) => {
      ['r', 'b', 'l', 't'].forEach((dir) => {
        const j = nearest(box, dir);
        if (j < 0 || j === i) return;
        const jbox = routable.find((r) => r.i === j).box;
        if (corridorBlocked(box, jbox, dir)) return;
        const a = Math.min(i, j), b = Math.max(i, j);
        const key = a + '_' + b;
        if (links.has(key)) return;
        links.set(key, { a, b, dir: i === a ? dir : OPP_DIR[dir] });
      });
    });

    const traces = [];
    const vias = [];
    const chipNets = chips.map(() => []);
    let uid = 0;
    const addTrace = (poly, hot) => {
      poly = dedupe(poly);
      if (poly.length < 2) return null;
      const id = 'cbt-' + uid++;
      traces.push({
        id,
        d: chamferPath(poly, 2.5 + rng() * 2.5),
        width: hot ? 1.1 + rng() * 0.5 : 0.6 + rng() * 0.4,
        hot: !!hot,
      });
      return id;
    };

    // every pin on one chip's facing edge connects straight to the pin
    // lined up with it on the other — a single bend bridges any offset
    links.forEach(({ a, b, dir }) => {
      const boxA = chipBox(chips[a]), boxB = chipBox(chips[b]);
      const segA = edgeSeg(boxA, dir, chips[a].padOut);
      const segB = edgeSeg(boxB, OPP_DIR[dir], chips[b].padOut);
      const lenA = dist(segA.a, segA.b), lenB = dist(segB.a, segB.b);
      const n = Math.max(2, Math.min(24, Math.round(Math.min(lenA, lenB) / PITCH)));
      const horiz = dir === 'r' || dir === 'l';
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const pinA = lerp(segA.a, segA.b, t);
        const pinB = lerp(segB.a, segB.b, t);
        const elbow = horiz ? { x: pinB.x, y: pinA.y } : { x: pinA.x, y: pinB.y };
        const hot = rng() < 0.13;
        const id = addTrace([pinA, elbow, pinB], hot);
        if (id != null) {
          chipNets[a].push(id); chipNets[b].push(id);
          const bent = Math.abs(elbow.x - pinA.x) > 1 || Math.abs(elbow.y - pinA.y) > 1;
          if (bent && rng() < 0.5) vias.push({ x: elbow.x, y: elbow.y, r: 0.8 + rng() * 0.6, hot });
        }
      }
    });

    geometry = { w, h, traces, vias, chips, chipNets, synthChips };
    return geometry;
  }

  // ---- rendering: cyan glowing traces on a deep-blue board -------------
  function render(svg, isGlow) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const NS = SVGNS;
    const w = geometry.w, h = geometry.h;
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const reg = [];

    if (!isGlow) {
      const defs = document.createElementNS(NS, 'defs');
      defs.innerHTML =
        '<radialGradient id="cb-vig" cx="0.5" cy="0.4" r="0.72">' +
          '<stop offset="0" stop-color="#020610" stop-opacity="0"/>' +
          '<stop offset="0.62" stop-color="#020610" stop-opacity="0.22"/>' +
          '<stop offset="1" stop-color="#01030a" stop-opacity="0.82"/>' +
        '</radialGradient>' +
        '<linearGradient id="cb-body" x1="0" y1="0" x2="0.12" y2="1">' +
          '<stop offset="0" stop-color="#22323f"/><stop offset="0.5" stop-color="#0b141d"/>' +
          '<stop offset="1" stop-color="#111e28"/></linearGradient>';
      svg.appendChild(defs);

      const base = document.createElementNS(NS, 'rect');
      base.setAttribute('width', w); base.setAttribute('height', h);
      base.setAttribute('fill', '#050c18');
      svg.appendChild(base);

      // synthetic IC bodies
      const gC = document.createElementNS(NS, 'g');
      gC.setAttribute('class', 'cb-chips');
      geometry.synthChips.forEach((ch) => {
        const r = document.createElementNS(NS, 'rect');
        r.setAttribute('x', ch.x.toFixed(1)); r.setAttribute('y', ch.y.toFixed(1));
        r.setAttribute('width', ch.w.toFixed(1)); r.setAttribute('height', ch.h.toFixed(1));
        r.setAttribute('rx', '1.5');
        r.setAttribute('fill', 'url(#cb-body)');
        r.setAttribute('stroke', 'rgba(90,160,215,0.28)');
        r.setAttribute('stroke-width', '0.6');
        gC.appendChild(r);
      });
      svg.appendChild(gC);

      // wide soft halo behind every trace (overlapping halos bloom → dense glow)
      const gH = document.createElementNS(NS, 'g');
      gH.setAttribute('class', 'cb-halo');
      geometry.traces.forEach((t) => {
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', t.d);
        p.setAttribute('data-kind', t.hot ? 'hot' : 'net');
        p.style.strokeWidth = (t.hot ? t.width * 4.5 + 2 : t.width * 2.4 + 1).toFixed(1);
        gH.appendChild(p);
      });
      svg.appendChild(gH);
    }

    // crisp bright core
    const gT = document.createElementNS(NS, 'g');
    gT.setAttribute('class', 'cb-traces');
    geometry.traces.forEach((t) => {
      if (isGlow && !t.hot) return;              // cursor-glow layer: hot traces only
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', t.d);
      p.setAttribute('pathLength', '1');
      p.setAttribute('data-cb-id', t.id);
      p.setAttribute('data-kind', t.hot ? 'hot' : 'net');
      p.style.strokeWidth = (isGlow ? t.width + 0.5 : t.width).toFixed(2);
      gT.appendChild(p);
      reg.push({ id: t.id, el: p, kind: t.hot ? 'hot' : 'net', width: t.width });
    });
    svg.appendChild(gT);

    if (!isGlow) {
      const gV = document.createElementNS(NS, 'g');
      gV.setAttribute('class', 'cb-vias');
      geometry.vias.forEach((v) => {
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', v.x.toFixed(1)); c.setAttribute('cy', v.y.toFixed(1));
        c.setAttribute('r', v.r.toFixed(1));
        c.setAttribute('data-kind', v.hot ? 'hot' : 'net');
        gV.appendChild(c);
      });
      svg.appendChild(gV);

      const vig = document.createElementNS(NS, 'rect');
      vig.setAttribute('width', w); vig.setAttribute('height', h);
      vig.setAttribute('fill', 'url(#cb-vig)');
      svg.appendChild(vig);
    }

    return reg;
  }

  // ---- lifecycle -------------------------------------------------------
  let baseSvg, glowSvg, sparkLayer;
  let registry = [];
  let byId = new Map();
  const chipNetsByEl = new Map();

  function mount() {
    baseSvg = document.createElementNS(SVGNS, 'svg');
    baseSvg.id = 'circuit-board';
    baseSvg.setAttribute('aria-hidden', 'true');
    glowSvg = document.createElementNS(SVGNS, 'svg');
    glowSvg.id = 'circuit-board-glow';
    glowSvg.setAttribute('aria-hidden', 'true');
    document.body.prepend(glowSvg);
    document.body.prepend(baseSvg);
  }

  function paint() {
    if (!document.body) return;
    generate();
    registry = render(baseSvg, false);
    const glowReg = render(glowSvg, true);
    sparkLayer = document.createElementNS(SVGNS, 'g');
    sparkLayer.setAttribute('class', 'cb-sparks');
    baseSvg.appendChild(sparkLayer);

    byId = new Map(registry.map((r) => [r.id, r]));
    glowReg.forEach((g) => { const b = byId.get(g.id); if (b) b.glowEl = g.el; });

    chipNetsByEl.clear();
    geometry.chips.forEach((c, i) => {
      if (!c.el) return;                          // synthetic scatter chip, no DOM node
      chipNetsByEl.set(c.el, geometry.chipNets[i] || []);
      if (c.el.__cbBound) return;
      c.el.__cbBound = true;
      c.el.addEventListener('mouseenter', () => {
        if (mm.matches) return;
        const ids = shuffle((chipNetsByEl.get(c.el) || []).slice()).slice(0, 3);
        ids.forEach((id, k) => setTimeout(() => pulse({ id, color: '#40e0d0', duration: 950 }), k * 90));
      });
    });
  }

  // ---- light API ------------------------------------------------------
  function pulse(opts) {
    opts = opts || {};
    let entry;
    if (opts.id) entry = byId.get(opts.id);
    else {
      const pool = opts.kind ? registry.filter((r) => r.kind === opts.kind) : registry;
      entry = pool[(Math.random() * pool.length) | 0];
    }
    if (!entry || !sparkLayer) return null;

    const color = opts.color || '#8fd0ff';
    const duration = opts.duration || 1200 + Math.random() * 700;
    const trail = opts.trail || 0.1;
    const reverse = !!opts.reverse;

    const spark = document.createElementNS(SVGNS, 'path');
    spark.setAttribute('d', entry.el.getAttribute('d'));
    spark.setAttribute('pathLength', '1');
    spark.setAttribute('class', 'cb-spark');
    spark.style.stroke = color;
    spark.style.color = color;                 // for the drop-shadow currentColor
    spark.style.strokeWidth = entry.width + 1.1;
    spark.style.strokeDasharray = `${trail} 2`;
    sparkLayer.appendChild(spark);

    // pathLength is normalised to 1; dash pattern period is trail + 2, so only
    // one dash is ever in the visible [0,1] range as the offset sweeps it.
    const a = trail + 1, b = -1;
    const anim = spark.animate(
      [{ strokeDashoffset: reverse ? b : a }, { strokeDashoffset: reverse ? a : b }],
      { duration, easing: 'cubic-bezier(.45,.05,.35,1)', fill: 'forwards' }
    );
    const done = () => spark.remove();
    anim.onfinish = done;
    anim.oncancel = done;
    return anim;
  }

  // ---- resize / relayout ------------------------------------------
  let resizeTimer = null;
  let last = { w: 0, h: 0 };
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const w = document.documentElement.clientWidth;
      const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      if (Math.abs(w - last.w) < 2 && Math.abs(h - last.h) < 40) return;
      last = { w, h };
      paint();
    }, 220);
  }

  function init() {
    mount();
    paint();
    last = { w: geometry.w, h: geometry.h };
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('load', onResize);
    if ('ResizeObserver' in window) new ResizeObserver(onResize).observe(document.body);
    document.querySelectorAll('img').forEach((im) => {
      if (!im.complete) im.addEventListener('load', onResize, { once: true });
    });
  }

  function tagChips() {
    // General rule: every substantial content element becomes a chip with
    // connection points. Kind is auto-detected — 'round' (circular), 'text'
    // (a text block: wider keep-out + pads held off the glyphs), or '' (a box).
    // Nested elements are skipped, so a card counts once, not once per child.
    const claimed = [];
    const nested = (r) => claimed.some((s) => {
      const ix = Math.max(0, Math.min(r.right, s.right) - Math.max(r.left, s.left));
      const iy = Math.max(0, Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top));
      return ix * iy > r.width * r.height * 0.55;
    });

    const list = [...document.querySelectorAll(
      'h1, h2, h3, h4, p, li, img, figure, blockquote, .project-card, .text-panel'
    )]
      .filter((el) => !(/^H[1-3]$/.test(el.tagName) && el.querySelector('.text-panel')))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width >= 36 && r.height >= 18)
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);

    for (const { el, r } of list) {
      if (nested(r)) continue;
      claimed.push(r);
      const cs = getComputedStyle(el);
      const squareish = Math.abs(r.width - r.height) < Math.max(r.width, r.height) * 0.3;
      const round = squareish && (cs.borderRadius.includes('50%')
        || parseFloat(cs.borderRadius) >= Math.min(r.width, r.height) * 0.45);
      const container = !!el.querySelector(':scope > *')
        && ['A', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'NAV', 'UL', 'OL'].includes(el.tagName);
      const text = !round && !container
        && (/^(H[1-5]|P|SPAN|LI|BLOCKQUOTE|FIGCAPTION)$/.test(el.tagName)
          || (el.textContent || '').trim().length > 0);
      el.setAttribute('data-chip', round ? 'round' : text ? 'text' : '');
    }
  }

  function start() { tagChips(); init(); }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', start);
  else start();

  window.CircuitBoard = {
    pulse,
    pulsePath: (id, opts) => pulse(Object.assign({}, opts, { id })),
    paths: () => registry.map((r) => ({ id: r.id, kind: r.kind })),
    element: (id) => { const e = byId.get(id); return e ? e.el : null; },
    regenerate: paint,
  };
})();
