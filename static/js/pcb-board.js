// Generative PCB page background, part 2 of 3: the runtime. Builds the board for the page (with pcb-gen.js), keeps it
// in step with the page's size, and draws everything that moves on a canvas over it: pulses spreading along the wires,
// and a power field (a cellular automaton) lighting wires near powered elements. The scroll-driven parts are pcb-scroll.js.
// Load order: pcb-gen.js, pcb-scroll.js, then this.
(() => {
  'use strict';
  const { CFG, generate, toSvg, mulberry32, laneMetrics, buildNet } = window.PCBGen;

  // ---- pulses: light spreading along the traces -----------------------------------------------------------
  // A pulse starts at one node (a component) and runs along every trace leaving it, at `speed` px/ms. When a
  // trace reaches a chip, that chip lights up and the traces leaving IT start too -- like current spreading
  // through the board -- up to `hops` chips deep.
  const PULSE = {
    speed: 0.6,        // px per ms (the STARTING speed: see duration)
    tail: 240,         // px of bright leading edge behind the head, easing down to the steady glow the rest of a lit trace holds
    duration: 2000,    // ms the light takes to reach its farthest wire: it accelerates as much as needed (0 = constant speed)
    fadeOut: 1500,     // ms everything takes to fade together once the last trace has arrived
    fadeRate: 3,       // how sharply it decays: brightness ~ e^(-fadeRate * progress) (3 = about 5% is left near the end; lower = gentler start, higher = sharper)
    hops: Infinity,    // how many chips deep it spreads: 1 = only the origin's own traces, 2 = and those leaving the
                       // chips they reach, ...; Infinity = it keeps going through every chip it reaches
    hopDelay: 40,      // ms a chip waits before passing the pulse on
    flash: 450,        // ms a chip glows after the pulse reaches it
    maxLanes: 40000,   // safety cap on how many traces one pulse may light (a 2px-grid page has ~7000)
    color: '#ffffff', width: 0.5, alpha: 0.9,   // width is in grid cells (x the cell size), so lit wires stay separate from their neighbours at any grid size
    reveal: 0.7,       // how brightly the rest of the board shows up near a lit trace (0 = off -- only the lit wires show; 1 = as bright as it gets)
    revealSize: 56,    // px across the area around a lit trace where that happens -- roughly how far the light reaches
    layerOpacity: 0.45,// how bright the whole layer is while a pulse runs (1 = full, dazzling white; lower = softer)
  };


  // Works out, ahead of time, when each trace starts lighting and when each chip is reached.
  function schedulePulse(g, originId, opts) {
    const o = Object.assign({}, PULSE, opts);
    const sc = g.cell / 2;               // the pulse's distances and speed are set for a 2px cell; scale them with the grid
    o.speed *= sc; o.tail *= sc; o.revealSize *= sc;
    if (!g._incoming) {               // which wires END at each component (built once): power runs back up them too
      g._incoming = [];
      for (const lane of g.stripLanes) if (lane.dst >= 0) (g._incoming[lane.dst] || (g._incoming[lane.dst] = [])).push(lane);
    }
    // The light ACCELERATES. Everything is first laid out in distance travelled by the head (S, px), then turned into times: the head has
    // covered v0*t + a*t^2/2 by time t. The acceleration a is chosen per pulse so the light reaches its very farthest wire at o.duration ms
    // (a short pulse just keeps its starting speed and finishes sooner), which keeps the whole effect from dragging on however far it spreads.
    const v0 = o.speed;
    const sched = [], flashes = [], reached = new Set([originId]), frontier = [{ id: originId, S: 0, hop: 0 }];
    for (let i = 0; i < frontier.length && sched.length < o.maxLanes; i++) {
      const { id, S, hop } = frontier[i];
      // the wires leaving this component run start -> end; the wires arriving at it run end -> start (rev)
      const legs = [];
      // A hand-written cable carries the pulse on when the pulse says so (o.cableNodes: both its ends in that set). Otherwise a cable
      // attached to the ORIGIN element still lights along its whole length, but the light stops at the far end: that element is not
      // lit and does not pass it on.
      const inSet = (lane) => o.cableNodes && o.cableNodes.has(lane.src) && o.cableNodes.has(lane.dst);
      const leg = (lane, rev, to) => (!lane.cable || inSet(lane) ? { lane, rev, to } : id === originId ? { lane, rev, to: -1 } : null);
      for (const lane of g.srcLanes[id] || []) { const l = leg(lane, false, lane.dst); if (l) legs.push(l); }
      for (const lane of g._incoming[id] || []) { const l = leg(lane, true, lane.src); if (l) legs.push(l); }
      for (const { lane, rev, to } of legs) {
        laneMetrics(lane);
        const arriveS = S + lane.len;
        sched.push({ lane, rev, S0: S, arriveS });
        if (to >= 0 && !reached.has(to)) {
          reached.add(to);                          // the first wire of a bundle to arrive lights the component
          flashes.push({ node: g.nodes[to], atS: arriveS });
          if (hop + 1 < o.hops) frontier.push({ id: to, S: arriveS + o.hopDelay * v0, hop: hop + 1 });
        }
      }
    }
    let Smax = 0;
    for (const e of sched) Smax = Math.max(Smax, e.arriveS);
    const T = o.duration;
    const a = T ? Math.max(0, (2 * (Smax - v0 * T)) / (T * T)) : 0;                             // px/ms^2
    const clock = (t) => v0 * t + 0.5 * a * t * t;                                            // distance the head has covered by time t
    const tOf = (S) => (a > 1e-9 ? (-v0 + Math.sqrt(v0 * v0 + 2 * a * S)) / a : S / v0);      // ...and the time it gets to distance S
    for (const fl of flashes) fl.at = tOf(fl.atS);
    const last = tOf(Smax);
    // everything holds until the last trace arrives (`done`), then fades over fadeOut
    return { sched, flashes, opts: o, done: last, end: last + o.fadeOut, clock };
  }

  // ---- power as a cellular automaton, solved instantly ------------------------------------------------------
  // Every trace is cut into cells FLOW.cellStep px apart; each chip is a cell too, linked to the ends of every
  // trace touching it. A cell holds a power 0..1: the strongest of (source level * gain^hops) over the sources,
  // gain = exp(-cellStep / decayLength), i.e. a little less at every hop. Nothing travels over time -- change a
  // source's level and the whole field follows at once; a stronger source reaches further because more cells stay
  // above the cutoff `eps`. Animation is just the source levels changing.
  const FLOW = {
    cellStep: 6,         // px between cells
    decayLength: 35,     // px over which power falls to 1/e along a trace
    eps: 0.0003,         // at or below this a cell counts as dark
    layer: 0.35,          // how bright the power field (the bar, the elements' charge) is, as a layer opacity; pulses use PULSE.layerOpacity. The layer itself stays at ONE opacity so nothing jumps when a pulse ends
    minShade: 0.01,       // brightness below which a wire is not drawn (it would be invisible anyway) -- keeps the cost down
    alpha: 1, width: 0.5, color: '#ffffff',   // width is in grid cells (x the cell size): a lit wire stays narrower than the pitch between wires
  };
  // how bright a cell of power v is drawn (0..1): a steep near part (boost, then ^gamma) plus a gentle long tail
  // Brightness IS the power: a cell holds level * exp(-distance / decayLength) (see solveNet), and that is what it is drawn with --
  // no boost, curve or tail. Only a tiny floor (minShade) is taken off, so the glow reaches exactly zero instead of ending in a step.
  const rawShade = (v) => Math.max(0, Math.min(1, (v - FLOW.eps) / (1 - FLOW.eps)));
  const shade = (v) => Math.max(0, rawShade(v) - FLOW.minShade) / (1 - FLOW.minShade);
  // the weakest power that still draws at least FLOW.minShade -- anything below is invisible, so it isn't worked out or drawn
  function visibleFloor() {
    let lo = FLOW.eps, hi = 1;
    for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (rawShade(m) < FLOW.minShade) lo = m; else hi = m; }
    return hi;
  }



  // The power field, instantly: every cell holds the strongest of (source level * gain^hops) over the sources, and
  // anything at or below `eps` is dark. No time is involved -- the field is whatever the source levels say right now,
  // so a stronger source simply reaches further. Cost is proportional to the number of lit cells (a label-correcting
  // walk out from the sources), not the size of the board.
  // Decay is a property of the SOURCE, not of the solve: `reach` is an optional array parallel to `src` giving each source's own
  // decayLength in px (falls back to FLOW.decayLength for any entry left undefined). Power
  // carries the decay rate of whichever source is currently winning a cell onward as it spreads, cell to cell, so two sources with
  // different reach fade at their own rates even where their fields meet.
  function solveNet(net, eps, src, val, closed, reach) {
    const { p, start, adj } = net;
    if (!net.touched) {
      net.touched = new Int32Array(net.n); net.nTouched = 0; net.queue = new Int32Array(net.n); net.inQ = new Uint8Array(net.n);
      net.seen = new Uint8Array(net.n); net.g = new Float32Array(net.n);
    }
    const { touched, queue, inQ, seen, g } = net, N = net.n;
    for (let k = 0; k < net.nTouched; k++) { p[touched[k]] = 0; seen[touched[k]] = 0; }
    net.nTouched = 0;
    let head = 0, size = 0, mx = 0;
    const put = (i, v, gi) => {
      p[i] = v; g[i] = gi;
      if (!seen[i]) { seen[i] = 1; touched[net.nTouched++] = i; }
      if (!inQ[i]) { inQ[i] = 1; queue[(head + size++) % N] = i; }
    };
    const defGain = Math.exp(-FLOW.cellStep / FLOW.decayLength);
    for (let k = 0; k < src.length; k++) if (val[k] > eps && val[k] > p[src[k]]) {
      const d = reach && reach[k] ? reach[k] : 0;
      put(src[k], val[k], d ? Math.exp(-FLOW.cellStep / d) : defGain);
    }
    while (size) {
      const i = queue[head]; head = (head + 1) % N; size--; inQ[i] = 0;
      const gi = g[i], v = p[i] * gi;
      if (v <= eps) continue;
      for (let k = start[i], e = start[i + 1]; k < e; k++) { const j = adj[k]; if (p[j] < v && !(closed && j < closed.length && closed[j])) put(j, v, gi); }
    }
    for (let k = 0; k < net.nTouched; k++) if (p[touched[k]] > mx) mx = p[touched[k]];
    net.max = mx;
  }

  // ---- the line: a band across the middle of the window that lights only the hand-written cables ----------------------
  // A page element stores power a bit like a capacitor. Its stored charge always relaxes (over about tau ms) towards the power it is being
  // fed. When the feed RISES it also gets a surge -- extra charge that lets it overshoot up to (gain x its input) -- and the surge decays
  // away over surgeTau ms, so the charge comes back down to exactly the power the bar is feeding it (0 when nothing is). max caps the charge.
  const CAP = { gain: 2, tau: 250, tauUp: 100, surgeTau: 900, max: 2 };   // tau: ms to drain / settle down; tauUp: ms to charge up (faster, so a fast-moving bar doesn't outrun it)
  // window.PCB_SHARE_CHARGE (set in the page; default true): false stops a charged element feeding the elements it shares a cable with,
  // so each one is powered only while the scroll light itself is in it.
  const SHARE_CHARGE = window.PCB_SHARE_CHARGE !== false;
  const LINE = {
    enabled: true,
    power: 2.5,         // the LINE's power: what it feeds a cable it crosses, and a page element it is over (which STORES it -- see CAP)
    decayLength: 6,     // px the line's own power falls to 1/e over -- a tight, bright pinpoint of light on the wires it crosses
    chainSteer: true,   // scroll drives progress ALONG THE CABLES (see buildChain in pcb-scroll.js), and the viewport is corrected to track it, rather than
                        // scroll position driving where the light is -- false goes back to plain, uncorrected scrolling
  };
  // A charged component radiates into its own wires at the SAME rate the bar itself decays on a wire -- so a component doesn't glow any
  // further out than the bar's own tight pinpoint does (undefined would fall back to the much gentler FLOW.decayLength instead).
  // window.PCB_CHARGE_DECAY (set in the page; px): how far a charged component's own glow reaches instead -- a longer one lights
  // the wires further out round a lit card (the line's own pinpoint stays LINE.decayLength)
  CAP.decayLength = +window.PCB_CHARGE_DECAY > 0 ? +window.PCB_CHARGE_DECAY : LINE.decayLength;


  // ===========================================================================
  // Browser side
  // ===========================================================================
  const api = { CFG, PULSE, FLOW, CAP, LINE };   // the settings, live: change one and the next frame (or rebuild) uses it

  const SVGNS = 'http://www.w3.org/2000/svg';
  const mm = window.matchMedia('(prefers-reduced-motion: reduce)');
  // Touch input never fires 'wheel', so it only ever reaches the corrective 'scroll' fallback below (onLineScroll),
  // which -- unlike the wheel path -- can't preventDefault the native scroll and instead corrects it after the fact
  // with an instant scrollTo. On iOS/Android that scrollTo cancels whatever touch-scroll or momentum gesture is
  // still live, so every swipe gets cut short by the page's own correction: scrolling a whole finger-width per tap
  // instead of gliding. coarsePointer skips that correction for touch, so native scrolling is left alone entirely.
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
  let svg = null, canvas = null, ctx = null, softBufs = [], boardCv = null, tmpCv = null, maskCv = null,
      boardKey = '', geoVersion = 0, dpr = 1, canvasW = 0, regionH = 0, regionTop = 0, raf = 0, geometry = null, lastKey = '', lastSig = '';
  const pulses = new Set();
  const MAX_PULSES = 8;
  const signature = (els) => els.map((e) => [e.x, e.y, e.w, e.h].map(Math.round).join(',')).join(';');

  // Every substantial content element is a component (plus anything marked data-pcb); nested ones count once (a card, not each child).
  function collectElements() {
    const sx = window.scrollX, sy = window.scrollY;
    const claimed = [];
    const nested = (r) => claimed.some((s) => {
      const ix = Math.max(0, Math.min(r.right, s.right) - Math.max(r.left, s.left));
      const iy = Math.max(0, Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top));
      return ix * iy > r.width * r.height * 0.55;
    });
    const list = [...document.querySelectorAll('h1, h2, h3, h4, p, li, img, figure, blockquote, .project-card, .text-panel, [data-pcb]')]
      .filter((el) => !(/^H[1-3]$/.test(el.tagName) && el.querySelector('.text-panel')))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width >= 36 && r.height >= 18)
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
    const out = [];
    for (const { el, r } of list) {
      if (nested(r)) continue;
      claimed.push(r);
      const container = !!el.querySelector(':scope > *')
        && ['A', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'NAV', 'UL', 'OL'].includes(el.tagName);
      const text = !container && (/^(H[1-5]|P|SPAN|LI|BLOCKQUOTE|FIGCAPTION)$/.test(el.tagName)
        || (el.textContent || '').trim().length > 0) && el.tagName !== 'IMG';
      out.push({ x: r.left + sx, y: r.top + sy, w: r.width, h: r.height, el,
        tag: (el.closest('h1, h2, h3, h4, h5, h6') || el).tagName,
        kind: text ? 'text' : el.classList.contains('project-card') ? 'card' : el.tagName === 'IMG' ? 'round' : 'box' });
    }
    // the social icons: small links the main selector doesn't pick up, blocked like the photo
    document.querySelectorAll('.social-icon').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) out.push({ x: r.left + sx, y: r.top + sy, w: r.width, h: r.height, tag: 'A', kind: 'round' });
    });
    return out;
  }

  function grainImage() {   // a small tiled noise texture, drawn once (an SVG noise filter stalls the page)
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(64, 64);
    const rnd = mulberry32(7);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.floor(rnd() * 40);
    }
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL();
  }

  // window.PCB_LINKS (set in the page): [[selectorA, selectorB, width?], ...] -- the cables to draw between page elements
  function resolveLinks() {
    const out = [];
    for (const [a, b, w] of window.PCB_LINKS || []) {
      const ea = document.querySelector(a), eb = document.querySelector(b);
      if (ea && eb) out.push([ea, eb, w]);
      else console.warn('PCB_LINKS: no element for', ea ? b : a);
    }
    return out;
  }

  // The grid cell is chosen so the board is a FIXED number of cells across on any screen or zoom level -- CFG.gridCols, or
  // CFG.gridColsNarrow on a board no wider than CFG.narrowWidth (phones: their pages are also the tallest, so the full count
  // would be far more cells than they can build quickly). It is given the WHOLE page width, so zooming out -- which widens the
  // page in CSS px -- grows the cells by the same factor: they stay the same size on screen and every screenful holds the same
  // number of cells. Height is free: a longer page just has more rows.
  // Cell sizes are multiples of 1/64 CSS px: exactly representable, so the grid arithmetic stays exact, and fine enough that the
  // count across lands within a fraction of a percent of the target. Never below 2 device pixels.
  function gridCols(width) { return width <= CFG.narrowWidth ? CFG.gridColsNarrow : CFG.gridCols; }
  function gridCell(width) {
    const dpr = window.devicePixelRatio || 1;
    return Math.max(Math.round(width / gridCols(width) * 64), Math.ceil(2 / dpr * 64)) / 64;
  }

  // The board is generated in a worker (pcb-worker.js), off the main thread: generate() is ~90% of a build -- 100s of ms here,
  // seconds on a slow machine -- and on the main thread it froze scrolling and input until it finished. If the worker can't be
  // started or fails, boards are built here instead, as before.
  const genSrc = (document.querySelector('script[src*="pcb-gen.js"]') || {}).src;
  const workerSrc = document.currentScript && document.currentScript.src.replace(/pcb-board\.js[^/]*$/, 'pcb-worker.js?gen=' + encodeURIComponent(genSrc || ''));
  let worker = null, jobId = 0, job = null;   // job: the latest build sent to the worker -- an older one's result is dropped
  function startWorker() {
    if (!genSrc || !workerSrc || typeof Worker === 'undefined') return;
    try { worker = new Worker(workerSrc); } catch (e) { worker = null; return; }
    worker.onmessage = ({ data }) => {
      if (!job || data.id !== job.id) return;
      const j = job; job = null;
      const g = data.g, lanes = g.stripLanes.concat(g.viaLanes);
      data.laneProps.forEach((p, i) => Object.assign(lanes[i], p));
      g.comps.forEach((c, i) => { c.el = j.comps[i]; });            // the page elements themselves can't be posted: put them back
      finishPaint(j, g, data.svg, data.net);
    };
    worker.onerror = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      worker.terminate(); worker = null;
      if (job) { const j = job; job = null; buildHere(j); }         // finish the build it was doing on the main thread instead
    };
  }
  let grain = null;   // the grain texture's data URL, made once

  function paint() {
    if (!document.body) return;
    const width = document.documentElement.clientWidth;
    const t0 = performance.now();
    const nav = document.querySelector('.site-nav');
    const seed = 0x9e3779b9 + Math.round(width / 40), insetTop = nav ? nav.offsetHeight : 0, cell = gridCell(width);
    const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const els = collectElements();
    // generate() makes a component of each element that isn't 'round', in order; cables name their two ends by that index
    const comps = els.filter((e) => e.kind !== 'round').map((e) => e.el);
    const compIndex = (x) => {
      const i = comps.indexOf(x);
      return i >= 0 ? i : comps.findIndex((c) => c && (x.contains(c) || c.contains(x)));
    };
    const links = resolveLinks().map(([a, b, w]) => [compIndex(a), compIndex(b), w].map((v) => (v === -1 ? null : v)));
    if (!grain) grain = grainImage();
    lastSig = signature(els);
    lastKey = `${width}x${height}`;   // set now, not when the build lands, so a relayout meanwhile doesn't start the same build again
    const j = { id: ++jobId, t0, width, height, comps, els: els.map(({ el, ...rest }) => rest), seed, opts: { insetTop, links, cell } };
    if (worker) { job = j; worker.postMessage({ id: j.id, els: j.els, width, height, seed, opts: j.opts, grain, cellStep: FLOW.cellStep }); }
    else buildHere(j);
  }
  function buildHere(j) {
    const g = generate(j.els, j.width, j.height, j.seed, j.opts);
    g.comps.forEach((c, i) => { c.el = j.comps[i]; });
    finishPaint(j, g, toSvg(g, grain), buildNet(g, FLOW.cellStep));
  }
  function finishPaint(j, g, svgMarkup, builtNet) {
    const { width, height, t0 } = j;
    geometry = g;
    geoVersion++;
    if (geoVersion === 1) warmStart = performance.now();   // the board has just appeared: its light builds up from nothing (see WARM_MS)
    net = builtNet;
    if (canvas) sizeCanvas();   // the page may have changed height since the canvas was last sized
    pulses.clear();   // a redraw builds new traces, so anything mid-flight refers to ones that no longer exist
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.innerHTML = svgMarkup;
    lineWas = new Set();   // new board: the line is over nothing until the next frame says otherwise
    scroll.rebuilt(geoVersion === 1);
    if (geoVersion === 1) scroll.startSections();   // the page's sections can only fire once there is a board to light
    if (canvas && !raf) raf = requestAnimationFrame(frame);   // draw the line for the new board
    const paintMs = Math.round(performance.now() - t0);   // from measuring the page to the board being on it (worker time included)
    svg.dataset.stats = `cell ${g.cell}px, ${g.cols} cols x ${g.rows} rows, ${g.chips.length} chips, ${g.stripLanes.length} strip wires, ${g.viaLanes.length} via wires, ${paintMs}ms`;
  }


  // ---- the pulse layer: a canvas over the viewport, only animating while a pulse is running ---------------
  function sizeCanvas() {
    // The pulse layer is a canvas positioned IN THE PAGE (absolute), covering the visible area plus a margin above
    // and below (two viewports tall in all). Because it is part of the page it scrolls with the text, exactly, on
    // the browser's own scrolling -- a window-fixed canvas redrawn on every scroll step lags behind the text.
    // It is only moved (and redrawn) when the visible area nears the edge of its margin: see ensureRegion().
    // Always 1 CSS px per canvas px, even on a high-DPI screen: the light is soft anyway, so a 2x canvas looked only a touch
    // crisper but had 4x the pixels to fill on every frame -- too much for slow machines.
    dpr = 1;
    canvasW = document.documentElement.clientWidth;
    regionH = Math.max(1, Math.min(window.innerHeight * 2, document.documentElement.scrollHeight));
    canvas.width = Math.round(canvasW * dpr);
    canvas.height = Math.round(regionH * dpr);
    canvas.style.width = canvasW + 'px';
    canvas.style.height = regionH + 'px';
    placeRegion();
    // The rest of the board is revealed near lit traces. That takes: a cached picture of the board (boardCv), a
    // soft stencil built from small blurred canvases the lit traces are drawn thick onto (softBufs, 1/4 and 1/8
    // size -- stretching a small image is a cheap blur), and a scratch canvas where the two are combined.
    if (!softBufs.length) {
      softBufs = [{ scale: 1 / 4 }, { scale: 1 / 8 }].map((b) => { b.c = document.createElement('canvas'); b.x = b.c.getContext('2d'); return b; });
      boardCv = document.createElement('canvas');
      tmpCv = document.createElement('canvas');
      maskCv = document.createElement('canvas');
    }
    for (const b of softBufs) {
      b.c.width = Math.max(1, Math.ceil(canvasW * b.scale));
      b.c.height = Math.max(1, Math.ceil(regionH * b.scale));
    }
    boardCv.width = tmpCv.width = canvas.width;
    boardCv.height = tmpCv.height = canvas.height;
    maskCv.width = softBufs[0].c.width;
    maskCv.height = softBufs[0].c.height;
    boardKey = '';
    // resizing a canvas wipes it: redraw straight away, or steady light (PCB_POWERED) would vanish until something else drew a frame
    if (geometry && !raf) raf = requestAnimationFrame(frame);
  }

  // where in the page the canvas sits: centred on what is in view, but never past the top or bottom of the page
  let lastRegionY = 0;   // scrollY the last time the region was actually recentred -- see ensureRegion's hysteresis
  function placeRegion() {
    const docH = document.documentElement.scrollHeight;
    const want = Math.round(window.scrollY - (regionH - window.innerHeight) / 2);
    regionTop = Math.max(0, Math.min(want, docH - regionH));
    canvas.style.top = regionTop + 'px';
    boardKey = '';   // the cached picture of the board is for one region
    lastRegionY = window.scrollY;
  }
  // Re-centre only when the visible area has come within a margin of the canvas edge -- AND has actually moved meaningfully
  // since the last re-centre. Every re-centre repaints the whole board (renderBoard), so without the second check scrolling
  // back and forth near a boundary would repaint on every reversal; a scroll that keeps going the same way is unaffected.
  function ensureRegion() {
    const vh = window.innerHeight, half = (regionH - vh) / 2, m = Math.min(vh * 0.2, half);
    const y = window.scrollY;
    if (y >= regionTop + m && y + vh <= regionTop + regionH - m) return false;   // safely inside the current region
    if (Math.abs(y - lastRegionY) < half - m) return false;   // near an edge, but not meaningfully past where the region was last centred
    const before = regionTop;
    placeRegion();
    return regionTop !== before;
  }

  // a picture of the whole board as it would look lit, for the region the canvas covers (redrawn only when the
  // region moves or the board is rebuilt -- NOT on every scroll step)
  function renderBoard(ox, oy, vw, vh) {
    const key = `${oy},${geoVersion},${dpr},${vw}x${vh}`;
    if (key === boardKey) return;
    boardKey = key;
    const g = geometry, cell = g.cell, c = boardCv.getContext('2d'), m = 24;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, vw, vh);
    c.lineCap = 'round'; c.lineJoin = 'round';
    const seen = (x0, y0, x1, y1) => x1 - ox > -m && x0 - ox < vw + m && y1 - oy > -m && y0 - oy < vh + m;
    c.strokeStyle = '#fff'; c.lineWidth = Math.max(0.6, cell * 0.4); c.beginPath();
    for (const set of [g.stripLanes, g.viaLanes]) for (const lane of set) {
      laneMetrics(lane);
      if (lane.length < 2 || !seen(lane.bb[0], lane.bb[1], lane.bb[2], lane.bb[3])) continue;
      c.moveTo(lane[0].x - ox, lane[0].y - oy);
      for (let i = 1; i < lane.length; i++) c.lineTo(lane[i].x - ox, lane[i].y - oy);
    }
    c.stroke();
    c.beginPath();                                               // vias, as rings
    const vr = cell * 0.35;
    for (const v of g.vias) if (seen(v.x, v.y, v.x, v.y)) { c.moveTo(v.x - ox + vr, v.y - oy); c.arc(v.x - ox, v.y - oy, vr, 0, 6.2832); }
    c.stroke();
    c.fillStyle = '#fff';
    for (const p of g.pads) if (seen(p.x, p.y, p.x + p.w, p.y + p.h)) c.fillRect(p.x - ox, p.y - oy, p.w, p.h);
    const pageSet = new Set(g.pageChips);
    for (const ch of g.chips.concat(g.pageChips)) {              // chips: a dark body, a white edge, and pins -- a real page
      if (!seen(ch.x, ch.y, ch.x + ch.w, ch.y + ch.h)) continue; // element's own body stays exactly the page's own background
      c.fillStyle = pageSet.has(ch) ? '#161616' : '#4a4a4a';     // colour, even when charged, rather than lightening like a chip
      c.fillRect(ch.x - ox, ch.y - oy, ch.w, ch.h);
      c.strokeStyle = '#fff'; c.lineWidth = 1.2; c.strokeRect(ch.x - ox, ch.y - oy, ch.w, ch.h);
      c.beginPath();
      for (let k = 0; k < Math.round(ch.w / cell); k++) {
        const px = ch.x + k * cell + cell / 2 - ox;
        c.moveTo(px, ch.y - oy); c.lineTo(px, ch.y - oy - cell * 0.8); c.moveTo(px, ch.y + ch.h - oy); c.lineTo(px, ch.y + ch.h - oy + cell * 0.8);
      }
      for (let k = 0; k < Math.round(ch.h / cell); k++) {
        const py = ch.y + k * cell + cell / 2 - oy;
        c.moveTo(ch.x - ox, py); c.lineTo(ch.x - ox - cell * 0.8, py); c.moveTo(ch.x + ch.w - ox, py); c.lineTo(ch.x + ch.w - ox + cell * 0.8, py);
      }
      c.stroke();
    }
  }

  // stroke the part of a trace between arc lengths a and b
  function strokeSlice(c, lane, a, b, ox, oy) {
    a = Math.max(0, a); b = Math.min(lane.len, b);
    if (b <= a) return;
    c.beginPath();
    let started = false;
    for (let i = 1; i < lane.length; i++) {
      const s0 = lane.cum[i - 1], s1 = lane.cum[i];
      if (s1 < a || s0 > b) continue;
      const p = lane[i - 1], q = lane[i], seg = s1 - s0 || 1;
      const ta = Math.max(0, (a - s0) / seg), tb = Math.min(1, (b - s0) / seg);
      if (!started) { c.moveTo(p.x + (q.x - p.x) * ta - ox, p.y + (q.y - p.y) * ta - oy); started = true; }
      c.lineTo(p.x + (q.x - p.x) * tb - ox, p.y + (q.y - p.y) * tb - oy);
    }
    c.stroke();
  }

  // a slice of a wire from arc length a to b -- measured from its far end when the light is running back up it
  const sl = (c, lane, a, b, rev) => (rev ? strokeSlice(c, lane, lane.len - b, lane.len - a, 0, regionTop) : strokeSlice(c, lane, a, b, 0, regionTop));
  function frame(now) {
    raf = 0;
    ensureRegion();
    const vw = canvasW, vh = regionH;   // the canvas covers page y in [regionTop, regionTop + regionH)
    // Clear every canvas WHOLE, in its own pixels -- not vw x vh through the scaling transform. The buffers are rounded UP (a 729px region
    // is 92 rows at 1/8 but vw x vh only reaches row 91.125), so a scaled clear left the last partial row uncleared, and with 'lighter'
    // drawing it built up frame after frame into a bright strip that the reveal then smeared along the bottom of the page.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const b of softBufs) {
      b.x.setTransform(1, 0, 0, 1, 0, 0);
      b.x.clearRect(0, 0, b.c.width, b.c.height);
      b.x.setTransform(b.scale, 0, 0, b.scale, 0, 0);   // draw in viewport px; the buffer is just smaller
      b.x.globalCompositeOperation = 'lighter';
      b.x.lineCap = 'round'; b.x.lineJoin = 'round';
    }
    const ox = 0, oy = regionTop, K = 5;
    let lit = false, reveal = 0;
    // The "reveal" halo (soft glow stencils + a board re-render + a multi-canvas composite, every frame) is by far the
    // most expensive part of a frame -- too slow for phones, so touch devices get the glowing wires without it.
    const revealEnabled = !coarsePointer;
    for (const p of pulses) {
      const t = now - p.start, o = p.opts;
      if (p.reveals) for (const rv of p.reveals) if (!rv.done && t >= rv.at) { rv.done = true; scroll.revealEl(rv.el); }   // the light has reached it
      if (t > p.end) { if (p.section) p.section.state = 'done'; pulses.delete(p); continue; }
      const revealOn = revealEnabled && o.reveal > 0;
      // full strength until the last trace has arrived, then everything fades out together. `front` is how far along the wires
      // (clock distance from the origin) the light reaches, with the pulse's acceleration.
      const front = p.clock(t);
      let fadeF = 1;
      if (t > p.done) {
        const fx = Math.min(1, (t - p.done) / o.fadeOut);
        fadeF = (Math.exp(-o.fadeRate * fx) - Math.exp(-o.fadeRate)) / (1 - Math.exp(-o.fadeRate));
      }
      if (revealOn) reveal = Math.max(reveal, o.reveal);
      ctx.strokeStyle = o.color; ctx.lineWidth = o.width * geometry.cell;
      if (revealOn) for (const b of softBufs) { b.x.strokeStyle = '#fff'; b.x.lineWidth = o.revealSize; }
      for (const s of p.sched) {
        const lane = s.lane, head = front - s.S0;
        if (head < 0) continue;                                           // not started yet
        const bb = lane.bb;                                               // skip traces that are off screen
        const m = revealOn ? o.revealSize : 20;
        if (bb[2] - ox < -m || bb[0] - ox > vw + m || bb[3] - oy < -m || bb[1] - oy > vh + m) continue;
        // the whole trace from its start up to the head stays lit at a steady glow; the last `tail` px (the leading edge)
        // is brighter, and once the head has reached the end that edge eases down to the glow. A bundle shares its light
        // out (dividing by its size^0.65), so 25 wires side by side reveal about as much as a few, not 25 times as much.
        const reached = Math.min(head, lane.len);
        const edge = head <= lane.len ? 1 : Math.max(0, 1 - (head - lane.len) / o.tail);
        const glow = o.alpha * 0.5 * fadeF, gs = Math.pow(lane.gsize || 1, 0.65);
        const bodyEnd = edge > 0 ? reached - Math.min(o.tail, reached) : reached;
        ctx.globalAlpha = glow;
        sl(ctx, lane, 0, bodyEnd, s.rev);
        if (edge > 0) for (let k = 0; k < K; k++) {
          ctx.globalAlpha = (glow + (Math.pow((k + 1) / K, 1.6) * o.alpha * fadeF - glow) * edge);
          sl(ctx, lane, reached - (Math.min(o.tail, reached) * (K - k)) / K, reached - (Math.min(o.tail, reached) * (K - k - 1)) / K, s.rev);
        }
        if (revealOn) {
          lit = true;
          for (const b of softBufs) {
            b.x.globalAlpha = (0.32 * fadeF) / gs;
            sl(b.x, lane, 0, reached, s.rev);
          }
        }
      }
      ctx.lineWidth = 2;
      for (const f of p.flashes) {                                        // a chip glows once the pulse reaches it
        const dt = t - f.at;
        if (dt < 0) continue;
        const n = f.node;
        // a burst that settles to a steady glow, held until everything has arrived, then faded with the rest
        const level = (0.55 + 0.45 * Math.max(0, 1 - dt / o.flash)) * fadeF;
        ctx.globalAlpha = level * 0.9;
        ctx.strokeRect(n.x - ox, n.y - oy, n.w, n.h);
        if (revealOn) {
          lit = true;
          for (const b of softBufs) {
            b.x.globalAlpha = level * 0.5;
            b.x.fillStyle = '#fff';
            b.x.fillRect(n.x - ox, n.y - oy, n.w, n.h);
          }
        }
      }
    }
    // ---- the power field: every cell of trace lit by the power it holds (see buildNet / solveNet) ----------------
    solveField(now);
    if (net && net.max > FLOW.eps) {
      const floor = visibleFloor();
      const caScale = FLOW.layer / PULSE.layerOpacity;    // the layer is set for pulses; the power field is drawn a little dimmer than that
      // wires are batched into NB brightness bands, one stroke() each: 48 looks continuous once anti-aliased, and keeps the
      // number of draw calls (the main per-frame cost) small
      const NB = 48, rv = revealEnabled && PULSE.reveal > 0, p = net.p, xs = net.x, ys = net.y, nx = net.nxt, ws = net.w, eps = FLOW.eps;
      const paths = [], sp = [];
      for (let b = 0; b < NB; b++) { paths.push(null); if (rv) sp.push(new Path2D()); }
      const used = new Uint8Array(NB), sused = new Uint8Array(NB);
      const bot0 = window.scrollY - oy - 140, top = bot0 + window.innerHeight + 280;   // only what is on screen (plus a margin) is drawn: the frame reruns on every scroll step
      // Power is only SOLVED at the net's cells (FLOW.cellStep apart); between two neighbouring cells it is drawn as a straight line, cut
      // into SUB steps each at its own interpolated brightness, so the change along a cell is continuous instead of jumping in one step at
      // each cell (visible as beading when a source's decayLength is short and neighbouring cells differ a lot). Position is interpolated
      // in px, value in power (its natural, ~exponential unit) before the brightness curve (shade) is applied.
      const SUB = 4;
      // net.sortedY/order (cells sorted by y, built once in buildNet) let this binary-search to the cells near the visible
      // window and walk only those, not every cell on the board. Neighbouring cells are FLOW.cellStep apart, far inside the
      // on-screen margin, so bounding by a cell's own y can't cut off an edge whose other end is still in view.
      const sortedY = net.sortedY, order = net.order, NO = order.length;
      let lo = 0, hi = NO;
      while (lo < hi) { const m = (lo + hi) >> 1; if (sortedY[m] < bot0 + oy) lo = m + 1; else hi = m; }
      let hiIdx = lo;
      while (hiIdx < NO && sortedY[hiIdx] <= top + oy) hiIdx++;
      for (let oi = lo; oi < hiIdx; oi++) {
        const i = order[oi];
        const v = p[i], j = nx[i];
        if (j < 0) continue;
        const vj = p[j];
        if (v < floor && vj < floor) continue;
        const y0 = ys[i] - oy, y1 = ys[j] - oy;
        if ((y0 < bot0 && y1 < bot0) || (y0 > top && y1 > top)) continue;               // off screen
        const x0 = xs[i] - ox, x1 = xs[j] - ox;
        let px = x0, py = y0, pdv = shade(v);
        for (let t = 1; t <= SUB; t++) {
          const f = t / SUB, qx = x0 + (x1 - x0) * f, qy = y0 + (y1 - y0) * f;
          const dv = shade(v + (vj - v) * f);
          const mid = (pdv + dv) / 2, b = Math.min(NB - 1, (mid * NB) | 0);            // the sub-step's own brightness (its midpoint)
          if (mid >= floor) {
            const pb = paths[b] || (paths[b] = new Path2D());
            pb.moveTo(px, py); pb.lineTo(qx, qy); used[b] = 1;
            if (rv) {
              const sb = Math.min(NB - 1, (mid * ws[i] * NB) | 0);                     // a bundle shares its light out
              sp[sb].moveTo(px, py); sp[sb].lineTo(qx, qy); sused[sb] = 1;
            }
          }
          px = qx; py = qy; pdv = dv;
        }
      }
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'butt';   // round caps would add up at every joint under 'lighter' and bead the line
      ctx.strokeStyle = FLOW.color; ctx.lineWidth = FLOW.width * geometry.cell;
      for (let b = 0; b < NB; b++) if (used[b]) { ctx.globalAlpha = Math.min(1, ((b + 0.5) / NB) * FLOW.alpha * caScale); ctx.stroke(paths[b]); lit = true; }
      if (rv) for (const bf of softBufs) {
        bf.x.strokeStyle = '#fff'; bf.x.lineWidth = PULSE.revealSize * geometry.cell / 2;
        for (let b = 0; b < NB; b++) if (sused[b]) { bf.x.globalAlpha = ((b + 0.5) / NB) * 0.5; bf.x.stroke(sp[b]); }
      }
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(0.8, geometry.cell * 0.5);                               // vias: rings at the end of their wire
      const vr = geometry.cell * 0.35;
      ctx.beginPath();
      let vb = -1;
      const flushVias = () => { if (vb >= 0) { ctx.globalAlpha = Math.min(1, ((vb + 0.5) / 24) * caScale); ctx.stroke(); ctx.beginPath(); } };
      const vOrder = [];
      for (let k = 0; k < geometry.vias.length; k++) {
        const c = net.viaCell[k];
        if (c < 0 || p[c] < floor) continue;
        const vy = geometry.vias[k].y - oy;
        if (vy < bot0 || vy > top) continue;
        vOrder.push(k);
      }
      const vq = (k) => Math.min(23, (shade(p[net.viaCell[k]]) * 24) | 0);
      vOrder.sort((a, b) => vq(a) - vq(b));
      for (const k of vOrder) {
        const q = vq(k);
        if (q !== vb) { flushVias(); vb = q; }
        const v = geometry.vias[k];
        ctx.moveTo(v.x - ox + vr, v.y - oy); ctx.arc(v.x - ox, v.y - oy, vr, 0, 6.2832);
        lit = true;
      }
      flushVias();
      ctx.lineWidth = 2;
      for (let k = 0; k < net.hubs; k++) {                                            // chips glow with the power they hold
        const v = p[k];
        if (v < floor) continue;
        const n = geometry.nodes[k];
        if (n.y + n.h - oy < bot0 || n.y - oy > top) continue;
        const cv = shade(v);
        ctx.globalAlpha = Math.min(1, cv * 0.9 * caScale);
        ctx.strokeRect(n.x - ox, n.y - oy, n.w, n.h);
        if (rv) for (const bf of softBufs) { bf.x.globalAlpha = cv * 0.5; bf.x.fillStyle = '#fff'; bf.x.fillRect(n.x - ox, n.y - oy, n.w, n.h); }
        lit = true;
      }
      if (lit && revealEnabled) reveal = Math.max(reveal, PULSE.reveal);
      // (the current point of chain progress needs no drawing of its own: solveField feeds power into the real cells there, and
      // the per-cell glow above shows it like any other charged cell)
    }
    if (lit && reveal > 0) {
      // show the rest of the board, but only inside the stencil, and dimly
      renderBoard(ox, oy, vw, vh);
      const m = maskCv.getContext('2d');
      m.setTransform(1, 0, 0, 1, 0, 0);
      m.clearRect(0, 0, maskCv.width, maskCv.height);
      m.imageSmoothingEnabled = true;
      m.globalCompositeOperation = 'lighter';
      m.drawImage(softBufs[1].c, 0, 0, maskCv.width, maskCv.height);   // the wider, softer light...
      m.drawImage(softBufs[0].c, 0, 0);                                // ...plus the tighter one
      const t2 = tmpCv.getContext('2d');
      t2.setTransform(1, 0, 0, 1, 0, 0);
      t2.globalCompositeOperation = 'source-over';
      t2.clearRect(0, 0, tmpCv.width, tmpCv.height);
      t2.drawImage(boardCv, 0, 0);
      t2.globalCompositeOperation = 'destination-in';
      t2.imageSmoothingEnabled = true;
      t2.drawImage(maskCv, 0, 0, tmpCv.width, tmpCv.height);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = reveal;
      ctx.drawImage(tmpCv, 0, 0);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    if (pulses.size || caActive() || warming(now)) raf = requestAnimationFrame(frame);   // otherwise it rests: the line is redrawn on each scroll
  }

  // the component a caller means: a node id, a CSS selector, or a DOM element (matches a component built from
  // that element or from anything inside it)
  function findNode(g, target) {
    if (typeof target === 'number') return g.nodes[target] || null;
    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) return null;
    return g.nodes.find((n) => n.el === el) || g.nodes.find((n) => n.el && (el.contains(n.el) || n.el.contains(el))) || null;
  }

  // Light the traces up starting at `target`; returns a handle with .cancel(), or null if there is nothing to
  // light (unknown target, board not built yet, or the visitor prefers reduced motion).
  function pulse(target, opts) {
    if (!geometry || !canvas || mm.matches) return null;   // no board yet, or the visitor prefers reduced motion
    const node = findNode(geometry, target);
    if (!node) return null;
    ensureRegion();
    const p = Object.assign(schedulePulse(geometry, node.id, opts), { start: performance.now() });
    p.cancel = () => pulses.delete(p);
    // frames don't run in a hidden tab, so pulses started there would never finish -- keep only the latest few
    while (pulses.size >= MAX_PULSES) pulses.delete(pulses.values().next().value);
    pulses.add(p);
    if (!raf) raf = requestAnimationFrame(frame);
    return p;
  }

  // ---- power fed into the cellular automaton -------------------------------------------------------------------------
  let net = null;
  // does the power field need redrawing every frame? (charge still building up or easing away -- steady power is just drawn
  // again whenever the page scrolls)
  let lineAnimating = false;
  // Light fades in rather than snapping on: the scroll light is scaled up from 0 to full over WARM_MS from when the board first
  // appears, and each steady source (PCB_POWERED) over WARM_MS from when it first switches on -- so the glow spreads out from its
  // source instead of being there, fully lit, on its very first frame. Keyed by page element, so a rebuild doesn't restart it.
  const WARM_MS = 900;
  let warmStart = 0, lastWarm = 0;
  const warmFrom = new Map();   // page element -> when its steady power switched on
  const warming = (now) => now - Math.max(warmStart, lastWarm) < WARM_MS;
  function warmth(now, from) {
    const t = Math.max(0, Math.min(1, (now - from) / WARM_MS));
    return t * t * (3 - 2 * t);   // smoothstep: eases in and out
  }
  function caActive() { return !!net && lineAnimating; }

  // Tell the page when the line goes over (or leaves) an activated element -- a 'pcb-power' event on that element, detail.on true/false --
  // so other things (the project videos) can follow the bar: it vanishes into the element as they start.
  let lineWas = new Set();
  function announceLine(inside) {
    for (const id of inside) if (!lineWas.has(id)) { const n = geometry.nodes[id]; if (n && n.el) n.el.dispatchEvent(new CustomEvent('pcb-power', { detail: { on: true } })); }
    for (const id of lineWas) if (!inside.has(id)) { const n = geometry.nodes[id]; if (n && n.el) n.el.dispatchEvent(new CustomEvent('pcb-power', { detail: { on: false } })); }
    lineWas = inside;
  }
  let linkedFor = -1, linked = new Map();   // page element id -> the elements it shares a hand-written cable with
  const charge = new Map();        // page element id -> { q: the power it has stored, surge: extra charge from a rise in its feed, prev: last feed } (see CAP)
  let lineT = 0;
  function solveField(now) {
    if (!net) return;
    const idx = [], val = [], idxReach = [];
    const warm = warmth(now, warmStart);
    for (const s of poweredSources()) {
      const el = geometry.nodes[s.id].el;
      if (!warmFrom.has(el)) { warmFrom.set(el, now); lastWarm = now; }
      idx.push(s.id); val.push(s.level * warmth(now, warmFrom.get(el))); idxReach.push(s.decayLength);
    }
    const dt = Math.min(100, lineT ? now - lineT : 0), inside = new Set(), lineCells = [], lineVal = [];
    lineT = now;
    // Where the light actually is: a single point of PROGRESS along the whole chain of cables (see buildChain/chainPointAt), driven
    // by scroll input in onLineScroll (pcb-scroll.js) -- so it advances evenly however a cable is oriented (a horizontal stretch gets exactly as
    // much of it as a vertical one of the same length), and the viewport is corrected to track it. A page element only charges
    // (and only fires its 'pcb-power' event -- see announceLine) while that point is a BRIDGE actually inside it (see buildChain),
    // never merely because it shares a y with wherever the point happens to be -- a component off to the side at that height, or
    // further along a cable that has since bent away in x, is not "under the light" just because a horizontal line would cross it.
    const pt = scroll.currentPoint();
    if (pt && pt.bridge && pt.componentId != null && scroll.activated(pt.componentId)) inside.add(pt.componentId);
    announceLine(inside);
    if (LINE.power > 0 && pt && !pt.bridge && (scroll.activated(pt.seg.cable.from) || scroll.activated(pt.seg.cable.to)))
      for (const c of pt.cells) { lineCells.push(c); lineVal.push(LINE.power * warm); }
    // One network for all power. A component the light has not reached yet is closed: power does not enter it (or pass through it).
    const closed = new Uint8Array(net.hubs);
    for (const n of geometry.comps) if (!scroll.activated(n.id)) closed[n.id] = 1;
    const floor = visibleFloor();
    // 1) what is FEEDING each element: the outside sources (the line's power on the cables, clicks) plus the stored charge of every OTHER
    //    element, carried along the wires and cables between them -- never its own charge, which would echo back into it and feed itself
    const base = idx.concat(lineCells), baseVal = val.concat(lineVal);
    const baseReach = idxReach.concat(lineCells.map(() => LINE.decayLength));
    const feed = new Map();
    solveNet(net, floor, Int32Array.from(base), Float32Array.from(baseVal), closed, baseReach);
    for (const n of geometry.comps) feed.set(n.id, net.p[n.id]);
    // an element only needs an extra solve if an element it shares a cable with holds a charge (the one that reaches it noticeably)
    if (linkedFor !== geoVersion) {
      linkedFor = geoVersion; linked = new Map();
      for (const c of geometry.cables) if (c && SHARE_CHARGE) {
        (linked.get(c.from) || linked.set(c.from, new Set()).get(c.from)).add(c.to);
        (linked.get(c.to) || linked.set(c.to, new Set()).get(c.to)).add(c.from);
      }
    }
    // solveNet's propagation is a max, not a sum, so max(base-sources + near-sources) at a cell is just the max of the two
    // solved separately. The base-only result is already in `feed` from the solve above, so each component only needs the
    // small set of its charged neighbours solved here -- the same answer as re-including `base`, for a fraction of the cost.
    for (const n of geometry.comps) {
      const near = [...(linked.get(n.id) || [])].filter((o) => (charge.get(o) || { q: 0 }).q > 0.005);
      if (!near.length) continue;
      solveNet(net, floor, Int32Array.from(near), Float32Array.from(near.map((o) => charge.get(o).q)), closed, near.map(() => CAP.decayLength));
      feed.set(n.id, Math.max(feed.get(n.id) || 0, net.p[n.id]));         // (this element's own charge is not among the sources)
    }
    // 2) each element charges towards its input x CAP.gain (the line being over it also feeds it LINE.power) and leaks when unfed
    lineAnimating = false;
    const stored = [], storedVal = [];
    for (const n of geometry.comps) {
      const id = n.id;
      const input = closed[id] ? 0 : Math.max(inside.has(id) ? LINE.power * warm : 0, feed.get(id) || 0);
      const st = charge.get(id) || (charge.set(id, { q: 0, surge: 0, prev: 0 }), charge.get(id));
      if (input > st.prev) st.surge = Math.min(1, st.surge + (input - st.prev) / 0.3);      // a rise in the feed: a surge of extra charge...
      st.surge *= Math.exp(-dt / CAP.surgeTau);                                               // ...which fades away
      st.prev = input;
      const target = input * (1 + (CAP.gain - 1) * st.surge);                                // relax to the feed, plus the surge on top
      st.q = Math.min(CAP.max * warm, st.q + (dt * (target - st.q)) / (target > st.q ? CAP.tauUp : CAP.tau));
      if (st.q < 0.005 && input === 0 && st.surge < 0.01) { charge.delete(id); continue; }
      // still charging, surging or draining: keep drawing frames (measured against the cap, or a feed above CAP.max never counts as settled)
      if (Math.abs(Math.min(CAP.max, target) - st.q) > 0.005 || st.surge > 0.01) lineAnimating = true;
      if (st.q > 0.005) { stored.push(id); storedVal.push(st.q); }
    }
    // 3) the field that is drawn: the outside sources plus what the elements have stored. An element's output is ONLY its stored charge:
    //    what arrives at it (step 1) just charges it, so the light changes smoothly with time however the bar moves.
    const shut = new Uint8Array(net.hubs);
    for (const n of geometry.comps) shut[n.id] = 1;
    solveNet(net, floor, Int32Array.from(idx.concat(lineCells, stored)), Float32Array.from(val.concat(lineVal, storedVal)), shut,
      idxReach.concat(lineCells.map(() => LINE.decayLength), stored.map(() => CAP.decayLength)));
  }

  // window.PCB_POWERED (set in the page): [{ el, level?, decayLength? }, ...] -- page elements that are powered for good, not just while the
  // line passes over them (for a page that doesn't scroll, like the About page, where it never would). Each is a steady source of
  // `level` power (default CAP.max, as bright as a fully charged element) falling to 1/e over `decayLength` px of wire (default
  // CAP.decayLength) -- a longer decayLength lights the wires much further out from it. Only once its section has activated it.
  let poweredFor = -1, poweredList = [];
  function poweredSources() {
    if (!geometry) return [];
    if (poweredFor !== geoVersion) {
      poweredFor = geoVersion;
      poweredList = (window.PCB_POWERED || []).map((s) => {
        const n = findNode(geometry, s.el);
        return n && { id: n.id, level: s.level === undefined ? CAP.max : s.level, decayLength: s.decayLength || CAP.decayLength };
      }).filter(Boolean);
    }
    return poweredList.filter((s) => scroll.activated(s.id));
  }

  // clicking a component (a text block, card -- or any invisible chip, by position) sets off a pulse: light spreads out
  // along the wires and lights each component it reaches, one after another (see PULSE).
  function onPowerClick(e) {
    if (!geometry) return;
    const x = e.pageX, y = e.pageY, m = 4;
    let best = null;
    for (const n of geometry.nodes) {
      if (x < n.x - m || x > n.x + n.w + m || y < n.y - m || y > n.y + n.h + m) continue;
      if (!best || n.w * n.h < best.w * best.h) best = n;      // the smallest one under the pointer
    }
    if (best) pulse(best.id);
  }


  // the scroll-driven parts (sections, the chain, steering) live in pcb-scroll.js
  const scroll = window.PCBScroll({
    LINE, mm, coarsePointer, findNode, pulse, ensureRegion,
    requestFrame() { if (!raf) raf = requestAnimationFrame(frame); },
    get geometry() { return geometry; }, get net() { return net; }, get geoVersion() { return geoVersion; }, get canvas() { return canvas; },
  });

  let timer = null;
  function relayout() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const w = document.documentElement.clientWidth;
      const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const [lw, lh] = lastKey.split('x').map(Number);
      // redraw if the page changed size OR any element has moved since the board was built (a shift that leaves
      // the page height alone -- fonts arriving, the viewport height changing -- would otherwise leave it stale)
      if (Math.abs(w - lw) < 2 && Math.abs(h - lh) < 40 && signature(collectElements()) === lastSig) return;
      paint();
    }, 220);
  }

  function start() {
    svg = document.createElementNS(SVGNS, 'svg');
    svg.id = 'pcb-board';
    svg.setAttribute('aria-hidden', 'true');
    document.body.prepend(svg);
    canvas = document.createElement('canvas');
    canvas.id = 'pcb-pulse';
    canvas.setAttribute('aria-hidden', 'true');
    svg.after(canvas);
    scroll.listen();
    ctx = canvas.getContext('2d');
    canvas.style.opacity = String(PULSE.layerOpacity);   // constant: switching it while a pulse starts/ends made everything else on the layer jump
    sizeCanvas();
    window.addEventListener('resize', sizeCanvas, { passive: true });
    document.addEventListener('click', onPowerClick, { passive: true });
    // With the worker, the build starts straight away and runs alongside the page's first frames. Without it, it's ~200ms of solid
    // main-thread work, so it waits until the page itself is on screen (run before the first frame, it held the whole page back,
    // text and nav too, until it finished): a rAF callback runs just before that frame is drawn; the setTimeout inside it lands just after.
    startWorker();
    if (worker) paint();
    else requestAnimationFrame(() => setTimeout(paint, 0));
    window.addEventListener('resize', relayout, { passive: true });
    window.addEventListener('load', relayout);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);
    if ('ResizeObserver' in window) new ResizeObserver(relayout).observe(document.body);
    document.querySelectorAll('img').forEach((im) => { if (!im.complete) im.addEventListener('load', relayout, { once: true }); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  // public API: PCBBoard.pulse(target, opts) lights the traces up starting at a component.
  //   target: a DOM element, a CSS selector, or a node id (see PCBBoard.nodes())
  //   opts:   { hops, speed, tail, duration, hopDelay, flash, color, width, alpha, reveal, revealSize, fadeOut } -- see PULSE above
  //           (it spreads through every chip it reaches unless you cap it with `hops`)
  api.pulse = pulse;
  api.active = () => pulses.size;   // how many pulses are running right now
  api.mediaDriven = !mm.matches;   // whether the page's videos follow the line (off for reduced motion, where the effects are skipped)
  api.geometry = () => geometry;
  api.nodes = () => (geometry ? geometry.nodes.map((n, i) => ({ id: i, kind: n.kind, tag: n.tag, el: n.el || null, x: n.x, y: n.y, w: n.w, h: n.h })) : []);
  window.PCBBoard = api;
})();
