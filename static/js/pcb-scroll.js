// Generative PCB page background, part 3 of 3: everything the page's scrolling drives.
//   - sections (window.PCB_SECTIONS): what lights up on load or on scroll, and which elements stay hidden until it does
//   - the chain: the page's hand-written cables (window.PCB_LINKS) joined into one continuous path
//   - steering: scrolling moves the light along that path, and the viewport is corrected to follow it
// A factory, not a self-starting script: pcb-board.js (the runtime) calls window.PCBScroll(B) once with the parts of
// itself this needs (B -- its geometry/net/geoVersion/canvas are live getters), and uses what it returns.
window.PCBScroll = (B) => {
  'use strict';
  const { LINE, mm, coarsePointer, findNode, pulse, ensureRegion, requestFrame } = B;

  // ---- sections: what activates each big part of a page (window.PCB_SECTIONS, set in the page) ---------------------------
  // A section's light starts at its `start` element -- when the page loads, or when the scroll line first reaches it -- and
  // travels along the hand-written cables between that section's elements. Each `reveal` element stays invisible until the
  // light arrives. state: 'idle' (waiting), 'running' (its pulse is going), 'done'.
  const SECTIONS = (window.PCB_SECTIONS || []).map((sec) => Object.assign({ state: 'idle' }, sec));
  function revealEl(el) {
    if (el.dataset.pcbShown) return;
    el.dataset.pcbShown = '1';
    el.classList.add('pcb-fade-in');
    el.style.opacity = '1';
  }
  function revealAll() {
    for (const sec of SECTIONS) for (const sel of sec.reveal || []) document.querySelectorAll(sel).forEach((el) => { el.dataset.pcbShown = '1'; el.style.opacity = '1'; });
  }
  function fireSection(sec) {
    if (!B.geometry || !B.canvas) return false;
    const startNode = findNode(B.geometry, sec.start);
    if (!startNode) return false;
    const items = (sec.reveal || []).map((sel) => ({ el: document.querySelector(sel), node: findNode(B.geometry, sel) })).filter((x) => x.el);
    const allowed = new Set([startNode.id]);
    for (const it of items) if (it.node) allowed.add(it.node.id);
    const p = pulse(startNode.id, { cableNodes: allowed });
    if (!p) return false;
    p.section = sec;
    sec.state = 'running';
    const arrive = new Map(p.flashes.map((f) => [f.node.id, f.at]));
    p.reveals = items.map((it) => ({ el: it.el, at: it.node && arrive.has(it.node.id) ? arrive.get(it.node.id) : p.done, done: false }));
    return true;
  }
  // An element is ACTIVATED once its section's light has reached it: a `reveal` element once it has been revealed, a section's
  // `start` element once that section has fired. The line's effects (its glow along the cables, the power it gives an element)
  // only work on activated elements; an element that is in no section is always active.
  let roleFor = -1, roles = new Map();
  function activated(id) {
    if (roleFor !== B.geoVersion) {
      roleFor = B.geoVersion; roles = new Map();
      for (const sec of SECTIONS) {
        const st = findNode(B.geometry, sec.start);
        if (st) roles.set(st.id, { sec });
        for (const sel of sec.reveal || []) { const nd = findNode(B.geometry, sel), el = document.querySelector(sel); if (nd && el) roles.set(nd.id, { el }); }
      }
    }
    const role = roles.get(id);
    if (!role) return true;
    return role.el ? !!role.el.dataset.pcbShown : role.sec.state !== 'idle';
  }
  // A scroll section starts once the light has actually reached its start element along the real cable path (see buildChain's
  // reachAt) -- not merely when the line's y passes it, which could happen while the light is elsewhere on a cable that only
  // swings down to that y later. A start element that isn't on the chain at all falls back to that plain y check.
  function checkScrollSections(yc) {
    for (const sec of SECTIONS) {
      if (sec.trigger !== 'scroll' || sec.state !== 'idle' || !B.geometry) continue;
      const n = findNode(B.geometry, sec.start);
      if (!n) continue;
      const reached = reachAt.has(n.id) ? chainProgress >= reachAt.get(n.id) : yc >= n.y;
      if (reached) fireSection(sec);
    }
  }
  // once the page has settled (fonts and images in, board rebuilt if they moved things), set the 'load' sections off
  function startSections() {
    if (mm.matches) { revealAll(); SECTIONS.forEach((sec) => { sec.state = 'done'; }); return; }
    const ready = [document.fonts && document.fonts.ready, document.readyState === 'complete' ? null : new Promise((res) => window.addEventListener('load', res, { once: true }))];
    Promise.all(ready).then(() => setTimeout(() => {
      for (const sec of SECTIONS) if (sec.trigger === 'load' && sec.state === 'idle') fireSection(sec);
      checkScrollSections(lineY());
    }, 500));
  }

  // ---- the chain: every hand-written cable, in the order PCB_LINKS lists them, joined into ONE continuous path -- arc length end to
  // end, including a straight bridge across each component they pass through (so progress never has to jump: it just crosses that gap
  // at the same steady pace as everywhere else, over the straight-line distance between where one cable arrives and the next leaves).
  // Scroll drives PROGRESS along this path (chainProgress, in px), not the page's scroll position directly -- see onLineScroll, which
  // corrects the viewport to sit wherever that point of progress truly is. So scrolling through a stretch that runs sideways advances
  // the light exactly as much as a vertical stretch of the same length would, and the viewport doesn't move at all while it does --
  // there's nothing above or below to correct toward -- until the path next heads down the page and scrolling starts moving it again.
  let chain = null, chainTotal = 0, chainProgress = 0, chainFor = -1, reachAt = new Map();
  // window.PCB_HOLD (set in the page; px of scroll, default 0 -- or a function returning it, asked at every board build, so it can
  // depend on the layout): how long the page stays completely still while the light is in a component. The light crosses a
  // component at normal pace (the page following it), except that where its path passes the component's middle height it stops
  // there for this much scrolling -- so the component sits centred, not moving, for a while. Never on touch, which doesn't steer.
  let HOLD = 0;
  const holdNow = () => {
    const h = typeof window.PCB_HOLD === 'function' ? window.PCB_HOLD() : window.PCB_HOLD;
    return coarsePointer ? 0 : Math.max(0, +h || 0);
  };
  // the light's crossing of component n from a to b (len: px of scroll for the moving part): one straight bridge, or -- with a HOLD --
  // split where it passes n's middle height (clamped to the crossing), with a stationary bridge of HOLD px in between
  function crossing(n, a, b, len) {
    const push = (from, to, l) => { chain.push({ bridge: true, componentId: n.id, from, to, cumStart: chainTotal, len: l }); chainTotal += l; };
    if (!HOLD) { push(a, b, len); return; }
    const hy = Math.max(Math.min(a.y, b.y), Math.min(Math.max(a.y, b.y), n.y + n.h / 2));
    const f = b.y !== a.y ? (hy - a.y) / (b.y - a.y) : 0;
    const h = { x: a.x + (b.x - a.x) * f, y: hy };
    const l1 = Math.abs(hy - a.y), l2 = Math.abs(b.y - hy);
    if (l1 > 0) push(a, h, l1);
    push(h, h, HOLD);
    if (l2 > 0) push(h, b, l2);
  }
  // A cable's own path is the centre of each of its rungs (see layStrip in pcb-gen.js): the exact route the walk took, one point
  // per construction step -- axis-aligned along a straight run, one short diagonal per tick through a turn.
  function rungCentres(cable) {
    const w = cable.rungs[0].length;
    return cable.rungs.map((rung) => ({ x: rung.reduce((s, p) => s + p.x, 0) / w, y: rung.reduce((s, p) => s + p.y, 0) / w }));
  }
  function cumLength(pts) {   // index i -> distance along the points from pts[0] to pts[i]
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    return cum;
  }
  function buildChain() {
    chain = []; chainTotal = 0; reachAt = new Map(); HOLD = holdNow();
    if (!B.geometry || !B.net) { chainFor = B.geoVersion; return; }
    let prevEnd = null, prevComp = null;
    B.geometry.cables.forEach((cable, ci) => {
      if (!cable) { console.warn('PCB_LINKS: cable', ci, 'could not be routed'); prevEnd = null; prevComp = null; return; }
      const na = B.geometry.nodes[cable.from], nb = B.geometry.nodes[cable.to];
      if (!reachAt.has(na.id)) reachAt.set(na.id, chainTotal);       // the progress at which the light actually gets here -- not
      const pts = rungCentres(cable), cum = cumLength(pts);          // wherever its y happens to coincide with the component's own
      const len = cum[cum.length - 1], startPt = pts[0];
      if (prevEnd && prevComp === na.id) {                          // this cable leaves the same component the last one arrived at
        // Measured by its VERTICAL span only, not the diagonal between where one cable arrives and the next leaves: scroll only
        // ever corrects towards pt.y, so counting sideways drift (a wide card whose two cables don't line up) would make a big
        // component take far more scrolling to get through than its own height. (Plus any HOLD -- see crossing.)
        crossing(na, prevEnd, startPt, Math.max(1, Math.abs(startPt.y - prevEnd.y)));
      } else if (!prevEnd) {
        // The very first component has the same problem the last one does (see the tail below), the opposite way round: nothing
        // precedes it to make a bridge out of, so without this it would never register as the light being inside it either, at
        // the very start of the chain. Give it the same treatment -- its own depth, from its top edge down to where the first
        // cable actually leaves it.
        const innerStart = Math.min(na.y, startPt.y - 1);
        const inLen = startPt.y - innerStart;
        crossing(na, { x: startPt.x, y: innerStart }, startPt, inLen);
      }
      chain.push({ cable, ci, pts, cum, len, cumStart: chainTotal });
      chainTotal += len;
      if (!reachAt.has(nb.id)) reachAt.set(nb.id, chainTotal);
      prevEnd = pts[pts.length - 1]; prevComp = nb.id;
    });
    // Past the last cable there's nothing left to steer onto, but scrolling shouldn't stop being 1:1 with the page there -- so the
    // chain keeps going, straight down to the bottom of the page, exactly like a bridge across a component (see above): progress
    // and page y move together at the same rate, so the correction this drives is always where the page already is, not fighting it.
    // Split in two: first the rest of the LAST component's own depth (still genuinely inside it, so it can still charge/fire
    // 'pcb-power' like any other component the chain crosses -- it's the chain's final stop, not just a component it passes
    // through, so it never otherwise gets a bridge of its own), then componentId: null for the page beyond that, which isn't
    // inside anything and must never register as such no matter how far past it the page goes.
    if (prevEnd) {
      const lastNode = B.geometry.nodes[prevComp];
      const innerEnd = lastNode ? Math.max(prevEnd.y + 1, lastNode.y + lastNode.h) : prevEnd.y + 1;
      const innerLen = innerEnd - prevEnd.y;
      if (lastNode) crossing(lastNode, prevEnd, { x: prevEnd.x, y: innerEnd }, innerLen);
      else { chain.push({ bridge: true, componentId: prevComp, from: prevEnd, to: { x: prevEnd.x, y: innerEnd }, cumStart: chainTotal, len: innerLen }); chainTotal += innerLen; }
      const bottom = Math.max(innerEnd + 1, B.geometry.height);
      const tailLen = bottom - innerEnd;
      chain.push({ bridge: true, componentId: null, from: { x: prevEnd.x, y: innerEnd }, to: { x: prevEnd.x, y: bottom }, cumStart: chainTotal, len: tailLen });
      chainTotal += tailLen;
    }
    chainFor = B.geoVersion;
  }
  // the point at arc-length distance s along the chain: { bridge, seg, cells, x, y } (cells/seg only for a cable). cells are the
  // power cells of the rung the point is at -- the cable's true cross-section there (net.rungCells, see buildNet in pcb-board.js).
  function chainPointAt(s) {
    if (!chain || !chain.length) return null;
    s = Math.max(0, Math.min(chainTotal, s));
    let seg = chain[chain.length - 1];
    for (const c of chain) if (s <= c.cumStart + c.len) { seg = c; break; }
    const local = Math.max(0, Math.min(seg.len, s - seg.cumStart));
    if (seg.bridge) {
      const t = seg.len ? local / seg.len : 0;
      const x = seg.from.x + (seg.to.x - seg.from.x) * t, y = seg.from.y + (seg.to.y - seg.from.y) * t;
      return { bridge: true, componentId: seg.componentId, x, y };
    }
    // binary-search the rung step `local` falls in (cum is sorted; a cable has hundreds of rungs and this runs every frame
    // while scrolling), interpolate the position along that step, and light the nearer of its two rungs
    const { pts, cum } = seg;
    let lo = 1, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < local) lo = mid + 1; else hi = mid; }
    const i = lo;
    const segLen = cum[i] - cum[i - 1], t = segLen ? (local - cum[i - 1]) / segLen : 0;
    const p0 = pts[i - 1], p1 = pts[i];
    const x = p0.x + (p1.x - p0.x) * t, y = p0.y + (p1.y - p0.y) * t;
    return { bridge: false, seg, cells: B.net.rungCells[seg.ci][t < 0.5 ? i - 1 : i], x, y };
  }
  // re-sync progress to wherever on the (possibly just-rebuilt) chain sits closest to a given page y -- so a rebuild (resize, fonts
  // arriving) doesn't reset progress to the start, and the very first scroll event has something sensible to correct from.
  function chainProgressForY(targetY) {
    if (!chain || !chain.length) return 0;
    let best = 0, bestDist = Infinity;
    for (const seg of chain) {
      const pts = seg.bridge ? [seg.from, seg.to] : seg.pts;
      const cum = seg.bridge ? [0, seg.len] : seg.cum;
      for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i - 1], p1 = pts[i], segLen = cum[i] - cum[i - 1];
        const dy = p1.y - p0.y;
        const t = dy ? Math.max(0, Math.min(1, (targetY - p0.y) / dy)) : 0;
        const cy = p0.y + dy * t, dist = Math.abs(targetY - cy);
        if (dist < bestDist) { bestDist = dist; best = seg.cumStart + cum[i - 1] + t * segLen; }
      }
    }
    return best;
  }

  // ---- the line: the middle of the window. It has three jobs, all in the sections/power code above: it sets a section off (once);
  // an activated element under it charges up; and the current point of chain PROGRESS is a LINE OF POWER (see solveField), lighting
  // the cable it's on by the same exponential falloff as any other power.
  // The line only sets off the sections (see above), once each -- it doesn't pulse the elements it passes over.
  const lineY = () => window.scrollY + window.innerHeight / 2;
  // Not a plain flag: the exact scrollY we last corrected TO, so an incoming 'scroll' event can be checked against it rather
  // than just trusted. A correction's own 'scroll' event doesn't necessarily fire before the next one is issued (they can
  // coalesce, or something else can scroll the page in between) -- a boolean would absorb whichever scroll event happened to
  // arrive next as "ours" and skip resyncing, even if the page had actually moved somewhere else in the meantime. Comparing
  // against the real target instead means a mismatch always falls through to a proper resync, however it got there.
  let pwLastRawY = 0, correctingTarget = null;
  // Advance progress by `delta` px and, if that lands somewhere genuinely near the chain, correct the viewport to match it. Shared by
  // the wheel handler (which can PREVENT the native scroll before it happens, so nothing ever has to be corrected back -- no fight, no
  // shake) and the plain 'scroll' fallback (for input a 'wheel' listener can't see, like touch or the keyboard, where the native
  // scroll has already happened by the time we hear about it and can only be corrected after the fact). Returns whether it engaged.
  function steer(delta) {
    if (chainFor !== B.geoVersion) buildChain();
    if (!LINE.chainSteer || !chain || !chain.length) return false;
    const prospective = chainProgress + delta;
    if (prospective < 0 || prospective > chainTotal) return false;   // past either end of the chain: hand scrolling back to the page, rather than freezing at the last point it covers
    const pt = chainPointAt(prospective);
    if (!pt || Math.abs(window.scrollY + window.innerHeight / 2 - pt.y) >= window.innerHeight) return false;   // nowhere near it
    chainProgress = prospective;
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    // Not rounded to a whole pixel: a trackpad's own wheel deltas are fine, sub-pixel fractions (that's what makes native
    // scrolling feel smooth), and snapping our correction to the nearest integer pixel throws that away -- several ticks in
    // a row can round to the exact same target and produce no visible motion at all, then suddenly jump 1px once the
    // accumulated fraction crosses a whole pixel, which reads as rough, stair-stepped scrolling instead of a smooth glide.
    const target = Math.max(0, Math.min(maxY, pt.y - window.innerHeight / 2));
    if (Math.abs(target - window.scrollY) > 0.1) { correctingTarget = target; window.scrollTo({ top: target, left: 0, behavior: 'instant' }); }   // instant: the page's own CSS sets scroll-behavior:smooth, which would otherwise animate every correction and let the real scroll position fall further and further behind chainProgress
    return true;
  }
  function onWheel(e) {
    if (steer(e.deltaY)) { e.preventDefault(); checkScrollSections(lineY()); ensureRegion(); requestFrame(); }
  }
  function onLineScroll() {
    // Touch: never correct the scroll position (see coarsePointer in pcb-board.js) -- just read progress off wherever the
    // finger/momentum already put the page, same as the "nowhere near the chain" fallback below always did.
    if (coarsePointer) {
      if (chainFor !== B.geoVersion) buildChain();
      if (chain && chain.length) chainProgress = chainProgressForY(lineY());
      checkScrollSections(lineY());
      ensureRegion();
      requestFrame();
      return;
    }
    if (correctingTarget != null && Math.abs(window.scrollY - correctingTarget) < 1) {
      correctingTarget = null; pwLastRawY = window.scrollY; checkScrollSections(lineY()); ensureRegion(); requestFrame(); return;
    }
    correctingTarget = null;   // whatever this scroll is, it didn't land where our last correction expected -- treat it as fresh
    const rawY = window.scrollY, delta = rawY - pwLastRawY;
    pwLastRawY = rawY;
    // a no-op if nowhere near the chain -- the fallback for scrolling a 'wheel' listener never sees, but also a big jump
    // (an anchor link, keyboard Home/End, dragging the scrollbar) that's too far for steer to track smoothly. Either way,
    // resync progress to wherever on the chain now matches, so anything gated on it (section triggers) still reflects reality.
    if (!steer(delta) && chain && chain.length) chainProgress = chainProgressForY(lineY());
    checkScrollSections(lineY());
    ensureRegion();
    requestFrame();
  }

  // Called after every board build: rebuild the chain and re-sync progress to it. The very first build starts the light at the
  // very start of the chain (the first PCB_LINKS element), UNLESS the page opened already scrolled down (a bfcache restore, an
  // anchor link): then progress must match where the page is, or the section triggers (which go by chain progress -- see
  // checkScrollSections) would stay unfired. A later rebuild (resize, fonts arriving) keeps the light where it was ALONG THE
  // CHAIN -- the same segment, the same fraction of the way along it -- rather than re-deriving it from the page's scroll
  // position: a chain that runs sideways crosses the same height in several places, so "nearest the middle of the window" can
  // land on a different cable entirely. Only if the chain's shape changed does it fall back to that.
  function rebuilt(firstBuild) {
    const place = firstBuild ? null : chainPlace();
    buildChain();
    if (place && chain.length === place.n) chainProgress = chain[place.i].cumStart + place.frac * chain[place.i].len;
    else chainProgress = (firstBuild && window.scrollY < 50) ? 0 : chainProgressForY(window.scrollY + window.innerHeight / 2);
    pwLastRawY = window.scrollY;
    for (const sec of SECTIONS) if (sec.state === 'running') { sec.state = 'idle'; fireSection(sec); }   // the rebuild cleared its pulse
  }
  // where the light is, in terms that survive a rebuild: which chain segment it's on (of n), and how far along it (0..1)
  function chainPlace() {
    if (!chain || !chain.length) return null;
    const i = Math.max(0, chain.findIndex((c) => chainProgress <= c.cumStart + c.len));
    const seg = chain[i];
    return { i, n: chain.length, frac: seg.len ? Math.max(0, Math.min(1, (chainProgress - seg.cumStart) / seg.len)) : 0 };
  }
  // where the light is now: a point along the chain (see chainPointAt), or null when there's no chain to steer along
  function currentPoint() {
    return LINE.chainSteer && chain && chain.length ? chainPointAt(chainProgress) : null;
  }
  function listen() {
    if (!LINE.enabled || mm.matches) return;
    window.addEventListener('scroll', onLineScroll, { passive: true });
    window.addEventListener('wheel', onWheel, { passive: false });   // not passive: steering needs to be able to preventDefault it
  }

  return { rebuilt, currentPoint, activated, revealEl, startSections, listen };
};
