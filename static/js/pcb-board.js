// Generative PCB page background -- a port of python_pcb_test/{my_code,nub_via_demo}.py.
//
// Every substantial page element (headings, paragraphs, the photo, the project cards) is treated as a
// component sitting on the board. Strips of parallel wires grow out of each component's four faces by a
// random walk on an occupancy grid, ending in new chip-like components (which do the same, breadth-first)
// or, for single leftover nubs, in vias. Small exposed pads are scattered last, into whatever space that
// growth left over. The page's own elements are drawn by the page itself; this only paints the board behind.
//
// Everything below the "geometry" section is pure (no DOM) so it can be tested in Node.
(() => {
  'use strict';

  // ---- tuning (sizes in grid cells unless noted) ---------------------------
  const CFG = {
    cell: 2,                    // px per grid cell = wire pitch (at minimum; grows on very large pages, see cellFor)
    maxGridCells: 2500000,       // budget: cells are enlarged so the grid never exceeds this, keeping generation time flat
    minWires: 2, maxWires: 25,  // wires per strip
    compMin: 6, compMax: 50,    // destination component side, in cells
    rectChance: 0.35,           // chance a chip grown at the end of a strip is a rectangle instead of a square
    rectDepth: [0.5, 1.7],      // a rectangle's depth (along the strip) as a multiple of the side the strip plugs into
    compRatio: [1.2, 2.0],      // destination side as a multiple of the strip feeding it
    clearance: 15,              // keepout margin around every component, in cells (x the cell size: 2px -> 30px)
    maxStripsPerFace: 5, extraStripChance: 0.8, stripGap: 2,
    maxBackups: 200,            // retreats a blocked strip may make
    shuffleVias: true,          // start a face's via walks in random order, not nub by nub (in order, neighbours settle into repeating patterns)
    viaBackups: 0,              // via walks stay greedy (retreat makes them steal each other's lanes)
    links: [],                  // hand-written cables between page elements: [[elementA, elementB, width?], ...] (a DOM element, or an index into the page elements). One cable per entry, routed with A*
    connect: { width: 21, margin: 60, turnCost: 3, weight: 1.0, maxExpand: 2000000 },   // default cable width in wires, A* search margin (cells), extra cost of a turn, A* greediness, search cap
    padSizes: [2, 3], padClearance: 2, padLeadChance: 0.7, padClustersPer120k: 12,
    litKinds: [],               // which page elements give off a steady light -- off: the board is invisible until a pulse runs; ['text', 'card'] turns them on
    lightReach: 20,             // how far that light reaches, in cells
    // how strongly each element glows (0-1): headings by level so bigger = brighter, then by kind
    lightLevels: { H1: 1, H2: 0.75, H3: 0.55, H4: 0.4, H5: 0.3, H6: 0.3, text: 0.3, card: 0.5 },
    lightDecay: 8.8,            // how fast it fades with distance: 1 = evenly, higher = bright near the box, gone quickly
    dimpleChance: 0.6,          // chance a chip has a pin-1 dimple at all (in a random one of its four corners)
    maxBoardWidth: 1600,        // px: the board is built over a strip at most this wide, centred; on a wider page the left and right edges of that strip act as hard edges (wires stop there) and the sides stay plain dark
    insetTop: 0,                // px along the top of the page the board leaves out (the fixed nav bar): its canvas starts below
    textPad: 12,                // px of extra room between a text block and its first wire, at a 2px cell (it scales with the cell)
  };

  // ---- small helpers ---------------------------------------------------------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const randint = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));      // inclusive, like Python
  const uniform = (rng, lo, hi) => lo + rng() * (hi - lo);
  const shuffle = (rng, arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  const rectGap = (a, b) => {
    const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w), 0);
    const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h), 0);
    return Math.hypot(dx, dy);
  };

  function simplify(points) {           // drop points on a straight run, keep only the turns
    if (points.length < 3) return points.slice();
    const out = [points[0]];
    for (let i = 1; i < points.length - 1; i++) {
      const a = points[i - 1], b = points[i], c = points[i + 1];
      if (b.x - a.x !== c.x - b.x || b.y - a.y !== c.y - b.y) out.push(b);
    }
    out.push(points[points.length - 1]);
    return out;
  }

  // ---- the occupancy grid -------------------------------------------------
  // Cells hold a COUNT, not a flag, because keepout margins overlap each other: freeing one cable's
  // cells must leave every other claim on them standing.
  function makeGrid(width, height, cell) {
    // whole cells only: a partial cell hanging past the page edge would let wires end outside it
    const cols = Math.max(1, Math.floor(width / cell)), rows = Math.max(1, Math.floor(height / cell));
    const blocked = new Int16Array(cols * rows);
    const cellC = (x) => Math.max(0, Math.min(cols - 1, Math.floor(x / cell)));
    const cellR = (y) => Math.max(0, Math.min(rows - 1, Math.floor(y / cell)));
    // every cell a box covers, grown by `clr` cells (clipped to the board), as flat indices.
    // The far corner is pulled back a hair so an edge landing exactly on a cell boundary doesn't claim
    // the cell just outside it.
    function boxCells(x, y, w, h, clr) {
      const c0 = cellC(x + 1e-6), r0 = cellR(y + 1e-6);
      const c1 = cellC(x + w - 1e-6), r1 = cellR(y + h - 1e-6);
      const out = [];
      for (let c = Math.max(0, c0 - clr); c <= Math.min(cols - 1, c1 + clr); c++)
        for (let r = Math.max(0, r0 - clr); r <= Math.min(rows - 1, r1 + clr); r++) out.push(c * rows + r);
      return out;
    }
    // every cell whose centre lies within `radius` (+ a margin of `clr` cells) of (cx, cy), as flat indices --
    // an obstacle that is round blocks a circle, not its bounding square
    function circleCells(cx, cy, radius, clr) {
      const reach = radius + clr * cell, out = [];
      for (let c = cellC(cx - reach); c <= cellC(cx + reach); c++)
        for (let r = cellR(cy - reach); r <= cellR(cy + reach); r++) {
          const dx = (c + 0.5) * cell - cx, dy = (r + 0.5) * cell - cy;
          if (dx * dx + dy * dy <= reach * reach) out.push(c * rows + r);
        }
      return out;
    }
    return { cols, rows, cell, blocked, cellC, cellR, boxCells, circleCells, width, height };
  }

  // ---- growing a cable -------------------------------------------------------
  // Grows `width` parallel wires out of one face of `comp`, ending in a new component (or, with
  // endsInVia, a single wire ending at a via). Returns { lanes, comp, via }; lanes is [] if scrapped.
  const DIRS = { N: [0, -1], S: [0, 1], W: [-1, 0], E: [1, 0] };

  function growCable(G, rng, comp, direction, o) {
    const { cols, rows, cell, blocked, cellC, cellR, boxCells, width: pageW, height: pageH } = G;
    const turnChance = o.turnChance || 0, bias = o.bias === undefined ? 0.5 : o.bias;
    const turn90Chance = o.turn90Chance || 0;
    const maxTurns90 = o.maxTurns90 === undefined ? null : o.maxTurns90;
    const maxCells = o.maxCells === undefined ? null : o.maxCells;
    const minCells = o.minCells || 0, clearance = o.clearance || 0, maxBackups = o.maxBackups || 0;
    const endsInVia = !!o.endsInVia;
    const NONE = { lanes: [], comp: null, via: null };

    const c0 = cellC(comp.x), r0 = cellR(comp.y);
    let vertical = direction === 'N' || direction === 'S';
    const faceSpan = Math.round((vertical ? comp.w : comp.h) / cell);
    let width = o.width === undefined || o.width === null ? faceSpan : o.width;
    if (width > faceSpan) throw new Error(`growCable: width ${width} exceeds the ${faceSpan}-wire ${direction} face`);
    if (endsInVia && width !== 1) throw new Error('growCable: endsInVia is only for width 1');
    let faceOffset;
    if (o.offset === undefined || o.offset === null) faceOffset = Math.floor((faceSpan - width) / 2);
    else if (o.offset < 0 || o.offset + width > faceSpan) throw new Error('growCable: offset does not fit the face');
    else faceOffset = o.offset;

    let [fc, fr] = DIRS[direction];
    const prefDir = [-fr, fc];          // fixed bias direction: the starting direction rotated 90 deg clockwise
    const startDir = [fc, fr];          // leant along once a turn has made prefDir parallel to travel

    // first cell outside the face. N/W use the near edge (exact whatever the alignment); S/E find the far
    // edge the same way the grid does, so a component that isn't cell-aligned still starts in the right place.
    let firstOutside;
    if (vertical) firstOutside = direction === 'N' ? r0 - 1 : cellR(comp.y + comp.h - 1e-6) + 1;
    else firstOutside = direction === 'W' ? c0 - 1 : cellC(comp.x + comp.w - 1e-6) + 1;
    // the first loop iteration always advances `along` by one, so start one short of the first outside cell
    let perp, along;
    if (vertical) { perp = c0 + faceOffset; along = firstOutside - fr; }
    else { perp = r0 + faceOffset; along = firstOutside - fc; }

    const bandAt = (p, a) => {
      const out = new Array(width);
      for (let k = 0; k < width; k++) out[k] = vertical ? [p + k, a] : [a, p + k];
      return out;
    };
    const cellAt = (p, a) => (vertical ? [p, a] : [a, p]);
    const inBounds = (cells) => cells.every(([c, r]) => c >= 0 && c < cols && r >= 0 && r < rows);
    const centerOf = (c, r) => ({ x: c * cell + cell / 2, y: r * cell + cell / 2 });

    // this cable has to leave `comp`'s own face, so that one component's keepout margin doesn't hold it off;
    // discount its contribution (rather than clearing cells, which would drop the margin for everyone else)
    // (tested by arithmetic, not by building the ring as a set -- a card's ring is tens of thousands of cells)
    let inOrigin = null;
    if (clearance) {
      const bc0 = cellC(comp.x + 1e-6), br0 = cellR(comp.y + 1e-6);
      const bc1 = cellC(comp.x + comp.w - 1e-6), br1 = cellR(comp.y + comp.h - 1e-6);
      const ec0 = Math.max(0, bc0 - clearance), er0 = Math.max(0, br0 - clearance);
      const ec1 = Math.min(cols - 1, bc1 + clearance), er1 = Math.min(rows - 1, br1 + clearance);
      inOrigin = (c, r) => c >= ec0 && c <= ec1 && r >= er0 && r <= er1
        && !(c >= bc0 && c <= bc1 && r >= br0 && r <= br1);
    }
    let allMarked = new Set();          // every cell this cable currently holds
    const isBlocked = (c, r) => {
      let n = blocked[c * rows + r];
      if (inOrigin && inOrigin(c, r)) n--;
      return n > 0;
    };
    const blockedByOther = (c, r) => {   // like isBlocked, but this cable's own cells don't count
      if (c < 0 || c >= cols || r < 0 || r >= rows) return false;
      const k = c * rows + r;
      let n = blocked[k] - (allMarked.has(k) ? 1 : 0);
      if (inOrigin && inOrigin(c, r)) n--;
      return n > 0;
    };
    const mark = (c, r) => { blocked[c * rows + r]++; allMarked.add(c * rows + r); };
    const unmark = (c, r) => { blocked[c * rows + r]--; allMarked.delete(c * rows + r); };

    let lanes = Array.from({ length: width }, () => []);
    const laneOrder = Array.from({ length: width }, (_, i) => i);   // position -> which physical wire sits there
    let heading = 0, steps = 0, turns90Done = 0;
    let justTurned = true;              // forces the first step (and the one after any turn) straight
    let history = [];                   // every committed step on the current axis: {perp, along, band, prev}
    let segmentStart = [perp, along];
    let backups = 0, best = null, bestSteps = -1;
    let hitEdge = false;                // the walk ran off the end of the board rather than into something
    const tried = new Map();            // (perp, along, heading) -> shifts already taken from there

    while (maxCells === null || steps < maxCells) {
      // ---- a 90 degree turn: each lane takes a different number of diagonal steps, so the paths nest and never cross
      if (heading === 0 && !justTurned && turn90Chance > 0 && rng() < turn90Chance
          && (maxTurns90 === null || turns90Done < maxTurns90)) {
        const side = rng() < 0.5 ? -1 : 1;
        const [nfc, nfr] = side === 1 ? [-fr, fc] : [fr, -fc];
        const laneAxis = vertical ? [1, 0] : [0, 1];
        const leaningHigh = laneAxis[0] * nfc + laneAxis[1] * nfr > 0;
        const wiggles = Array.from({ length: width }, (_, i) => (leaningHigh ? width - i : i + 1));
        const trial = bandAt(perp, along);
        const gained = Array.from({ length: width }, () => []);
        let ok = true;
        for (let t = 1; t <= width && ok; t++) {
          for (let i = 0; i < width; i++) {
            if (t > wiggles[i]) continue;
            const [c, r] = trial[i];
            const nc = c + fc + nfc, nr = r + fr + nfr;
            if (nc < 0 || nc >= cols || nr < 0 || nr >= rows || isBlocked(nc, nr)
                || blockedByOther(nc, r) || blockedByOther(c, nr)) { ok = false; break; }
            trial[i] = [nc, nr];
            gained[i].push([nc, nr]);
          }
        }
        if (ok) {
          for (let k = 0; k < width; k++)
            for (const [c, r] of gained[k]) { mark(c, r); lanes[laneOrder[k]].push(centerOf(c, r)); }
          vertical = !vertical;
          const coord = vertical ? (x) => x[0] : (x) => x[1];
          const swapped = coord(trial[0]) > coord(trial[width - 1]);
          if (swapped) laneOrder.reverse();
          fc = nfc; fr = nfr;
          const first = swapped ? trial[width - 1] : trial[0];
          if (vertical) { perp = first[0]; along = first[1]; } else { perp = first[1]; along = first[0]; }
          steps += width; turns90Done++;
          best = null; bestSteps = steps;        // a snapshot from before the turn no longer fits
          history = []; segmentStart = [perp, along];
          justTurned = true;
          continue;
        }
      }

      // ---- an ordinary step, with an optional 45 degree wiggle
      const forward = vertical ? fr : fc;
      let wanted;
      if (justTurned) wanted = 0;
      else if (turnChance > 0 && rng() < turnChance) {
        if (heading === 0) {
          const laneAxis = vertical ? [1, 0] : [0, 1];
          let alignment = laneAxis[0] * prefDir[0] + laneAxis[1] * prefDir[1];
          if (alignment === 0) alignment = laneAxis[0] * startDir[0] + laneAxis[1] * startDir[1];
          wanted = rng() < (alignment > 0 ? bias : 1 - bias) ? 1 : -1;
        } else wanted = 0;                        // a diagonal only goes back to straight, never straight to the other diagonal
      } else wanted = heading;

      const nextA = along + forward;
      if (nextA < 0 || nextA >= (vertical ? rows : cols)) { hitEdge = true; break; }

      let candidates = [];
      for (const s of [wanted, heading, 0]) if (!candidates.includes(s)) candidates.push(s);
      let triedHere = null;
      if (maxBackups) {
        for (const s of (justTurned ? [0] : heading === 0 ? [0, 1, -1] : [heading, 0]))
          if (!candidates.includes(s)) candidates.push(s);
        const key = ((perp + 8) * 8192 + (along + 8)) * 3 + heading + 1;
        triedHere = tried.get(key);
        if (!triedHere) tried.set(key, (triedHere = new Set()));
        candidates = candidates.filter((s) => !triedHere.has(s));
      }
      const prev = [perp, along, heading, justTurned];

      let moved = false;
      for (const shift of candidates) {
        const nextPerp = perp + shift, nextAlong = along + forward;
        const band = bandAt(nextPerp, nextAlong);
        if (!inBounds(band) || band.some(([c, r]) => isBlocked(c, r))) continue;
        if (shift !== 0) {                        // a diagonal step mustn't cut across another cable's corner
          const corners = shift > 0
            ? [cellAt(perp, nextAlong), cellAt(nextPerp + width - 1, along)]
            : [cellAt(perp + width - 1, nextAlong), cellAt(nextPerp, along)];
          if (corners.some(([c, r]) => c >= 0 && c < cols && r >= 0 && r < rows && isBlocked(c, r))) continue;
        }
        for (const [c, r] of band) mark(c, r);
        for (let k = 0; k < width; k++) lanes[laneOrder[k]].push(centerOf(band[k][0], band[k][1]));
        if (triedHere) triedHere.add(shift);
        perp = nextPerp; along = nextAlong;
        history.push({ perp, along, band, prev });
        heading = shift; moved = true; justTurned = false;
        break;
      }
      if (!moved) {
        if (maxBackups && backups < maxBackups && history.length) {
          if (steps > bestSteps) {                // about to unwind from a new deepest point -- keep it
            bestSteps = steps;
            best = { steps, perp, along, heading, justTurned, lanes: lanes.map((l) => l.slice()),
                     history: history.slice(), marked: new Set(allMarked) };
          }
          backups++;
          const popped = history.pop();
          for (const [c, r] of popped.band) unmark(c, r);
          for (const lane of lanes) lane.pop();
          [perp, along, heading, justTurned] = popped.prev;
          steps--;
          continue;
        }
        break;
      }
      steps++;
    }

    // a failed search must never leave the walk shorter than plain greedy would have: put the deepest state back
    if (best && steps < bestSteps) {
      for (const k of allMarked) if (!best.marked.has(k)) blocked[k]--;
      for (const k of best.marked) if (!allMarked.has(k)) blocked[k]++;
      ({ steps, perp, along, heading, justTurned, lanes, history } = best);
      allMarked = best.marked;
      hitEdge = false;
    }
    const releaseAll = () => { for (const k of allMarked) blocked[k]--; };

    const startVertical = direction === 'N' || direction === 'S';
    const startEdge = { N: comp.y, S: comp.y + comp.h, W: comp.x, E: comp.x + comp.w }[direction];
    const startTouch = (first) => (startVertical ? { x: first.x, y: startEdge } : { x: startEdge, y: first.y });

    if (endsInVia) {
      if (steps < Math.max(1, minCells)) { releaseAll(); return NONE; }
      const lane = simplify(lanes[0]);
      lane.unshift(startTouch(lane[0]));
      return { lanes: [lane], comp: null, via: lane[lane.length - 1] };
    }

    // ---- a strip that reached the edge of the board simply ends there -- no destination component
    if (hitEdge) {
      if (steps < (o.minEdgeCells === undefined ? 4 : o.minEdgeCells)) { releaseAll(); return NONE; }
      const edgeAt = fc !== 0 ? { x: fc > 0 ? pageW : 0 } : { y: fr > 0 ? pageH : 0 };
      lanes = lanes.map(simplify);
      for (const lane of lanes) {
        if (!lane.length) continue;
        lane.unshift(startTouch(lane[0]));
        const last = lane[lane.length - 1];
        lane.push({ x: edgeAt.x === undefined ? last.x : edgeAt.x, y: edgeAt.y === undefined ? last.y : edgeAt.y });
      }
      return { lanes, comp: null, via: null };
    }

    // ---- plant the destination component just past the cable's end, backing into its own tail if needed
    let newSize = o.newSize === undefined || o.newSize === null ? width * cell : Math.round(o.newSize / cell) * cell;
    if (newSize < width * cell) throw new Error("growCable: newSize can't hold this cable's wires");
    const half = newSize / 2;
    // newSize is the side the cable plugs into (across its wires); the depth (how far the chip reaches along the cable) is the same by
    // default -- a square -- or o.newDepth for a rectangle
    const depth = o.newDepth === undefined || o.newDepth === null ? newSize : Math.max(cell, Math.round(o.newDepth / cell) * cell);
    const bw = fc !== 0 ? depth : newSize, bh = fc !== 0 ? newSize : depth;
    const componentBox = (p, a) => {
      const band = bandAt(p, a);
      let cx = 0, cy = 0;
      for (const [c, r] of band) { const q = centerOf(c, r); cx += q.x; cy += q.y; }
      cx /= width; cy /= width;
      if (fc !== 0) return [fc > 0 ? (a + 1) * cell : a * cell - bw, Math.round((cy - half) / cell) * cell];
      return [Math.round((cx - half) / cell) * cell, fr > 0 ? (a + 1) * cell : a * cell - bh];
    };
    const boxFits = (fx, fy) => {
      if (fx < 0 || fy < 0 || fx + bw > cols * cell || fy + bh > rows * cell) return false;
      if (boxCells(fx, fy, bw, bh, 0).some((k) => isBlocked((k / rows) | 0, k % rows))) return false;
      // the keepout margin must clear everything except this cable's own cells (it plugs into this component)
      return !boxCells(fx, fy, bw, bh, clearance)
        .some((k) => !allMarked.has(k) && isBlocked((k / rows) | 0, k % rows));
    };

    let [fx, fy] = componentBox(perp, along);
    let backedOff = 0;
    while (!boxFits(fx, fy)) {
      if (!history.length || steps - backedOff <= minCells) { releaseAll(); return NONE; }
      const popped = history.pop();
      backedOff++;
      for (const [c, r] of popped.band) unmark(c, r);
      for (const lane of lanes) if (lane.length) lane.pop();
      if (history.length) ({ perp, along } = history[history.length - 1]); else [perp, along] = segmentStart;
      [fx, fy] = componentBox(perp, along);
    }
    fx = Math.max(0, Math.min(fx, cols * cell - bw));
    fy = Math.max(0, Math.min(fy, rows * cell - bh));
    const placed = { x: fx, y: fy, w: bw, h: bh };
    for (const k of boxCells(fx, fy, bw, bh, clearance)) blocked[k]++;

    const edgeX = fc !== 0 ? (fc > 0 ? fx : fx + bw) : null;
    const edgeY = fc === 0 ? (fr > 0 ? fy : fy + bh) : null;
    lanes = lanes.map(simplify);
    for (const lane of lanes) {
      if (!lane.length) continue;
      lane.unshift(startTouch(lane[0]));
      const last = lane[lane.length - 1];
      lane.push(edgeX !== null ? { x: edgeX, y: last.y } : { x: last.x, y: edgeY });
    }
    return { lanes, comp: placed, via: null };
  }

  // ---- connecting page elements: A* over the position of a whole strip --------------------------------------
  // A strip is `w` parallel wires. Its state is where its band sits, which way it travels, and whether it has just
  // turned. It can go straight one cell, or make a 90 degree turn using exactly the nesting turn growCable makes (each
  // lane takes a different number of diagonal steps so they never cross). A* finds the cheapest way from any face
  // of one element to any face of another; layStrip then lays the lanes down and marks the grid.
  const DIRV = [[0, -1], [1, 0], [0, 1], [-1, 0]];   // N E S W
  const bandCells = (c, r, d, w) => {                // the w cells of a band whose lowest-coordinate cell is (c, r)
    const out = new Array(w);
    if (d % 2 === 0) for (let k = 0; k < w; k++) out[k] = [c + k, r];
    else for (let k = 0; k < w; k++) out[k] = [c, r + k];
    return out;
  };

  // The 90 degree turn, as pure geometry. hit(c, r): is that cell taken; hitCorner: same test for the two cells a diagonal
  // step cuts across. Returns { gained[i] (the cells lane i takes), first (the new band's lowest cell), d, swapped, ticks } or null.
  // ticks: the band's own centre (fractional grid coords), one entry per real construction tick -- ticks[0] is the band
  // before the turn, ticks[w] is the band after -- since the outer lane needs up to w diagonal steps to sweep clear of
  // the inner ones (see below), a turn isn't one atomic move, it's its own short sequence of exact, gridded sub-steps.
  function turnMacro(c, r, d, side, w, hit, hitCorner) {
    const [fc, fr] = DIRV[d];
    const [nfc, nfr] = side === 1 ? [-fr, fc] : [fr, -fc];
    const laneAxis = fc === 0 ? [1, 0] : [0, 1];
    const leaningHigh = laneAxis[0] * nfc + laneAxis[1] * nfr > 0;
    const trial = bandCells(c, r, d, w);
    const gained = Array.from({ length: w }, () => []);
    const centreOf = () => { let x = 0, y = 0; for (const [cc, rr] of trial) { x += cc; y += rr; } return [x / w, y / w]; };
    const ticks = [centreOf()];
    for (let t = 1; t <= w; t++) {
      for (let i = 0; i < w; i++) {
        if (t > (leaningHigh ? w - i : i + 1)) continue;
        const [cc, rr] = trial[i];
        const nc = cc + fc + nfc, nr = rr + fr + nfr;
        if (hit(nc, nr) || hitCorner(nc, rr) || hitCorner(cc, nr)) return null;
        trial[i] = [nc, nr];
        gained[i].push([nc, nr]);
      }
      ticks.push(centreOf());
    }
    const nd = DIRV.findIndex(([a, b]) => a === nfc && b === nfr);
    const coord = nfr !== 0 ? (x) => x[0] : (x) => x[1];       // the lane axis once the strip has turned
    const swapped = coord(trial[0]) > coord(trial[w - 1]);
    return { gained, first: swapped ? trial[w - 1] : trial[0], d: nd, swapped, ticks };
  }

  // A*: the cheapest route for a strip of `w` wires from any face of A to any face of B. Cells' claims are read straight
  // from G.blocked (the caller has lifted A's and B's own keepout). "Is this rectangle free?" is one lookup in a
  // prefix-sum grid built per route, which makes both a straight step and a whole turn cheap to test. A turn is only
  // taken when the whole square it sweeps is free (conservative -- layStrip does the exact test). Returns
  // { start: {c, r, d}, ops: [{t: 'S'} | {t: 'T', side}] } or null.
  const turnFoot = new Map();          // "d,side,w" -> the turn's result and the box it sweeps, relative to the band's start cell
  function turnFootprint(d, side, w) {
    const k = d * 1000 + (side + 1) * 100 + w;
    let t = turnFoot.get(k);
    if (t) return t;
    let x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    const see = (c, r) => { x0 = Math.min(x0, c); y0 = Math.min(y0, r); x1 = Math.max(x1, c); y1 = Math.max(y1, r); return false; };
    for (const [c, r] of bandCells(0, 0, d, w)) see(c, r);
    const m = turnMacro(0, 0, d, side, w, see, see);
    t = { dc: m.first[0], dr: m.first[1], d: m.d, x0, y0, x1, y1 };
    turnFoot.set(k, t);
    return t;
  }
  let scratch = { n: 0, g: null, par: null, how: null, closed: null };
  function routeStrip(G, A, B, w, rng, conn) {
    const { cols, rows, cellC, cellR, blocked } = G;
    const boxOf = (o) => [cellC(o.x + 1e-6), cellR(o.y + 1e-6), cellC(o.x + o.w - 1e-6), cellR(o.y + o.h - 1e-6)];
    const [ac0, ar0, ac1, ar1] = boxOf(A), [bc0, br0, bc1, br1] = boxOf(B);
    const M = conn.margin;
    const rc0 = Math.max(0, Math.min(ac0, bc0) - M), rr0 = Math.max(0, Math.min(ar0, br0) - M);
    const rc1 = Math.min(cols - 1, Math.max(ac1, bc1) + M), rr1 = Math.min(rows - 1, Math.max(ar1, br1) + M);
    const RW = rc1 - rc0 + 1, RH = rr1 - rr0 + 1, SW = RH + 1;
    const sat = new Int32Array((RW + 1) * SW);                   // sat[(c+1)*SW + (r+1)] = taken cells in the box up to (c, r)
    for (let c = 0; c < RW; c++) {
      let run = 0;
      for (let r = 0; r < RH; r++) {
        if (blocked[(c + rc0) * rows + r + rr0] > 0) run++;
        sat[(c + 1) * SW + r + 1] = sat[c * SW + r + 1] + run;
      }
    }
    const free = (c0, r0, c1, r1) => {                           // every cell of the box is free (and inside the search region)
      if (c0 < rc0 || r0 < rr0 || c1 > rc1 || r1 > rr1) return false;
      c0 -= rc0; c1 -= rc0; r0 -= rr0; r1 -= rr0;
      return sat[(c1 + 1) * SW + r1 + 1] - sat[c0 * SW + r1 + 1] - sat[(c1 + 1) * SW + r0] + sat[c0 * SW + r0] === 0;
    };
    const bandFree = (c, r, d) => (d % 2 === 0 ? free(c, r, c + w - 1, r) : free(c, r, c, r + w - 1));
    const N = RW * RH * 8;
    if (scratch.n < N) scratch = { n: N, g: new Float32Array(N), par: new Int32Array(N).fill(-2), how: new Int8Array(N), closed: new Uint8Array(N) };
    const { g, par, how, closed } = scratch;
    const touched = [];
    const key = (c, r, d, fl) => (((c - rc0) * RH + (r - rr0)) * 4 + d) * 2 + fl;
    const decode = (k) => { const fl = k & 1, d = (k >> 1) & 3, cr = k >> 3; return { c: Math.floor(cr / RH) + rc0, r: (cr % RH) + rr0, d, fl }; };
    const inB = (c, r) => c >= bc0 && c <= bc1 && r >= br0 && r <= br1;
    const H = conn.weight;                                       // 1 = exact A*; >1 is greedier: fewer states explored, routes a little less tidy
    const h = (c, r) => H * (Math.max(bc0 - (c + w), c - bc1, 0) + Math.max(br0 - (r + w), r - br1, 0));
    const heapF = [], heapK = [];
    const push = (f, k) => {
      let i = heapF.length; heapF.push(f); heapK.push(k);
      while (i > 0) { const p = (i - 1) >> 1; if (heapF[p] <= f) break; heapF[i] = heapF[p]; heapK[i] = heapK[p]; i = p; }
      heapF[i] = f; heapK[i] = k;
    };
    const pop = () => {
      const k0 = heapK[0], fl = heapF.pop(), kl = heapK.pop();
      if (heapF.length) {
        let i = 0;
        for (;;) {
          const a = 2 * i + 1; if (a >= heapF.length) break;
          const b = a + 1 < heapF.length && heapF[a + 1] < heapF[a] ? a + 1 : a;
          if (heapF[b] >= fl) break;
          heapF[i] = heapF[b]; heapK[i] = heapK[b]; i = b;
        }
        heapF[i] = fl; heapK[i] = kl;
      }
      return k0;
    };
    const isNew = (k) => par[k] === -2;                          // par is -2 until a state is first reached
    const startFrom = (c, r, d) => {
      if (!bandFree(c, r, d)) return false;
      const k = key(c, r, d, 1), g0 = rng() * 0.6;
      if (!isNew(k) && g[k] <= g0) return true;
      if (isNew(k)) touched.push(k);
      g[k] = g0; par[k] = -1; how[k] = -1; push(g0 + h(c, r), k);
      return true;
    };
    // Seeding EVERY position on every face lets A* pick whichever start gives the shortest overall path -- which is nearly always
    // the position most directly aligned with B, so the cable leaves in a dead straight line. Instead: work out which face it would
    // have picked anyway (the one facing B), and seed only ONE random position along THAT face, so the cable still leaves sensibly
    // but from wherever chance puts it, not necessarily the position that shortens the route -- giving it some visual wander. Falls
    // back to every position on that face (then, failing that, every face) if the random spot turns out to be blocked.
    const faceRange = (d) => (d % 2 === 0 ? [ac0, ac1 - w + 1] : [ar0, ar1 - w + 1]);
    const seedFace = (d, c0, c1) => {
      let any = false;
      for (let c = c0; c <= c1; c++) any = (d % 2 === 0 ? startFrom(c, d === 0 ? ar0 - 1 : ar1 + 1, d) : startFrom(d === 3 ? ac0 - 1 : ac1 + 1, c, d)) || any;
      return any;
    };
    const acx = (ac0 + ac1) / 2, acy = (ar0 + ar1) / 2, bcx = (bc0 + bc1) / 2, bcy = (br0 + br1) / 2;
    const dx = bcx - acx, dy = bcy - acy;
    const face = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
    const [f0, f1] = faceRange(face);
    let seeded = false;
    if (f1 >= f0) for (let attempt = 0; attempt < 5 && !seeded; attempt++) { const c = f0 + Math.floor(rng() * (f1 - f0 + 1)); seeded = seedFace(face, c, c); }
    if (!seeded && f1 >= f0) seeded = seedFace(face, f0, f1);                 // that face has no free spot at all left to chance: use it all
    if (!seeded) for (let c = ac0; c <= ac1 - w + 1; c++) { startFrom(c, ar0 - 1, 0); startFrom(c, ar1 + 1, 2); }
    if (!seeded) for (let r = ar0; r <= ar1 - w + 1; r++) { startFrom(ac0 - 1, r, 3); startFrom(ac1 + 1, r, 1); }
    let result = null, expanded = 0;
    while (heapF.length && expanded++ < conn.maxExpand) {
      const k = pop();
      if (closed[k]) continue;
      closed[k] = 1;
      const { c, r, d, fl } = decode(k), gk = g[k];
      const [fc, fr] = DIRV[d];
      if (bandCells(c + fc, r + fr, d, w).every(([x, y]) => inB(x, y))) {         // the next step lands in B: done
        const ops = [];
        let cur = k;
        while (par[cur] !== -1) { ops.push(how[cur] === 0 ? { t: 'S' } : { t: 'T', side: how[cur] === 1 ? -1 : 1 }); cur = par[cur]; }
        ops.reverse();
        const s0 = decode(cur);
        result = { start: { c: s0.c, r: s0.r, d: s0.d }, ops };
        break;
      }
      const relax = (nc, nr, nd, nfl, cost, mv) => {
        const nk = key(nc, nr, nd, nfl), ng = gk + cost;
        if (!isNew(nk)) { if (g[nk] <= ng) return; } else touched.push(nk);
        g[nk] = ng; par[nk] = k; how[nk] = mv; push(ng + h(nc, nr), nk);
      };
      if (bandFree(c + fc, r + fr, d)) relax(c + fc, r + fr, d, 0, 1, 0);
      if (!fl) for (const side of [-1, 1]) {
        const t = turnFootprint(d, side, w);
        if (free(c + t.x0, r + t.y0, c + t.x1, r + t.y1)) relax(c + t.dc, r + t.dr, t.d, 1, w + conn.turnCost, side === -1 ? 1 : 2);
      }
    }
    for (const k of touched) { g[k] = 0; closed[k] = 0; par[k] = -2; }   // hand the scratch back clean
    return result;
  }

  // Lays a routed strip down: marks the grid, builds the lanes. own cells are counted by count() (so a strip can't run
  // into itself) but not for the diagonal corner-cut test. Returns { lanes, startD, endD } or null (nothing left marked).
  function layStrip(G, A, B, w, route, count) {
    const { cols, rows, cell, blocked } = G;
    const own = new Set();
    const mark = (c, r) => { blocked[c * rows + r]++; own.add(c * rows + r); };
    const release = () => { for (const k of own) blocked[k]--; };
    const hit = (c, r) => c < 0 || c >= cols || r < 0 || r >= rows || count(c, r) > 0;
    const other = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows && count(c, r) - (own.has(c * rows + r) ? 1 : 0) > 0;
    const centerOf = (c, r) => ({ x: c * cell + cell / 2, y: r * cell + cell / 2 });
    // The SPINE: the bundle's own reference point (the middle of its band), one entry per construction step -- exactly the path the
    // walk actually took, so its direction at any point is just the exact heading of that one step (axis-aligned for a straight move,
    // or the single diagonal chord of a turn), not something reconstructed afterwards by guessing from the finished, simplified lanes.
    const mid = (w - 1) / 2;
    const bandMid = (c, r, d) => (d % 2 === 0 ? centerOf(c + mid, r) : centerOf(c, r + mid));
    const spine = [];
    let lanes = Array.from({ length: w }, () => []);
    let laneOrder = Array.from({ length: w }, (_, i) => i);
    let { c, r, d } = route.start;
    const startD = d;
    const place = (cells) => {
      if (cells.some(([x, y]) => hit(x, y))) return false;
      for (let k = 0; k < w; k++) { mark(cells[k][0], cells[k][1]); lanes[laneOrder[k]].push(centerOf(cells[k][0], cells[k][1])); }
      return true;
    };
    if (!place(bandCells(c, r, d, w))) { release(); return null; }
    spine.push(bandMid(c, r, d));
    for (const op of route.ops) {
      if (op.t === 'S') {
        c += DIRV[d][0]; r += DIRV[d][1];
        if (!place(bandCells(c, r, d, w))) { release(); return null; }
        spine.push(bandMid(c, r, d));
      } else {
        const m = turnMacro(c, r, d, op.side, w, hit, other);
        if (!m) { release(); return null; }
        for (let k = 0; k < w; k++) for (const [nc, nr] of m.gained[k]) { mark(nc, nr); lanes[laneOrder[k]].push(centerOf(nc, nr)); }
        if (m.swapped) laneOrder = laneOrder.slice().reverse();
        c = m.first[0]; r = m.first[1]; d = m.d;
        // one spine point per real tick of the turn (ticks[0] is the band as it already stood, already the spine's last
        // point -- skip it), not one chord bridging the whole thing: the fan the turn actually sweeps is exactly this
        // sequence of steps, so walking it point by point tracks the true, stepped shape instead of a straight shortcut across it.
        for (let ti = 1; ti < m.ticks.length; ti++) {
          const [tc, tr] = m.ticks[ti];
          spine.push({ x: tc * cell + cell / 2, y: tr * cell + cell / 2 });
        }
      }
    }
    lanes = lanes.map(simplify);
    const startEdge = { 0: A.y, 1: A.x + A.w, 2: A.y + A.h, 3: A.x }[startD];
    const [fc, fr] = DIRV[d];
    for (const lane of lanes) {
      if (!lane.length) continue;
      lane.unshift(startD % 2 === 0 ? { x: lane[0].x, y: startEdge } : { x: startEdge, y: lane[0].y });
      const last = lane[lane.length - 1];
      lane.push(fc !== 0 ? { x: fc > 0 ? B.x : B.x + B.w, y: last.y } : { x: last.x, y: fr > 0 ? B.y : B.y + B.h });
    }
    spine.unshift(startD % 2 === 0 ? { x: spine[0].x, y: startEdge } : { x: startEdge, y: spine[0].y });
    const lastSp = spine[spine.length - 1];
    spine.push(fc !== 0 ? { x: fc > 0 ? B.x : B.x + B.w, y: lastSp.y } : { x: lastSp.x, y: fr > 0 ? B.y : B.y + B.h });
    return { lanes, startD, endD: d, endAnchor: [c, r], spine };
  }

  // ---- laying out the whole board -------------------------------------------
  // Runs of nubs on a face that are clear of every strip already on it by at least stripGap.
  function freeRuns(faceSpan, covered, cfg) {
    const taken = new Set();
    for (const n of covered) for (let d = -cfg.stripGap; d <= cfg.stripGap; d++) taken.add(n + d);
    const runs = [];
    let start = null;
    for (let n = 0; n <= faceSpan; n++) {
      if (n < faceSpan && !taken.has(n)) { if (start === null) start = n; }
      else if (start !== null) { if (n - start >= cfg.minWires) runs.push([start, n - start]); start = null; }
    }
    return runs;
  }

  // Small square exposed pads in clusters (single, row, column, 2x2) -- placed last (see generate), so they only fill
  // whatever's left: candidates are checked against the grid itself, not just the page elements passed in, so a pad never
  // lands on a wire or a chip that's already there either.
  function makePads(rng, G, elements, cfg) {
    const { cols, rows, cell, blocked, boxCells } = G;
    const target = Math.round((cols * rows * cfg.padClustersPer120k) / 120000);
    const pads = [];
    let clusters = 0, tries = 0;
    while (clusters < target && tries < 2000) {
      tries++;
      const size = cfg.padSizes[Math.floor(rng() * cfg.padSizes.length)];
      const pitch = (size + 2) * cell;
      const shape = ['single', 'row', 'col', 'block'][Math.floor(rng() * 4)];
      const n = randint(rng, 2, 4);
      let offsets;
      if (shape === 'single') offsets = [[0, 0]];
      else if (shape === 'row') offsets = Array.from({ length: n }, (_, i) => [i, 0]);
      else if (shape === 'col') offsets = Array.from({ length: n }, (_, i) => [0, i]);
      else offsets = [[0, 0], [1, 0], [0, 1], [1, 1]];
      const x0 = randint(rng, 5, cols - 6) * cell, y0 = randint(rng, 5, rows - 6) * cell;
      const group = offsets.map(([dx, dy]) => ({
        x: x0 + dx * pitch, y: y0 + dy * pitch, w: size * cell, h: size * cell, clearance: cfg.padClearance,
      }));
      if (group.some((p) => p.x + p.w > (cols - 5) * cell || p.y + p.h > (rows - 5) * cell)) continue;
      if (group.some((p) => elements.some((e) => rectGap(p, e) < (cfg.clearance + 12) * cell))) continue;
      if (group.some((p) => pads.some((q) => rectGap(p, q) < 6 * cell))) continue;
      if (group.some((p) => boxCells(p.x, p.y, p.w, p.h, p.clearance).some((k) => blocked[k] > 0))) continue;
      pads.push(...group);
      clusters++;
    }
    return pads;
  }

  // Zooming out makes the page bigger in CSS pixels, and generation cost grows with the grid. Enlarging the
  // cell in step keeps the grid (and so the time and SVG size) roughly constant -- and the board looks the
  // same on screen, because a bigger cell in a smaller-looking pixel is the same physical size.
  function cellFor(width, height, cfg) {
    const c = cfg || CFG;
    return Math.max(c.cell, Math.ceil(Math.sqrt((width * height) / c.maxGridCells) * 2) / 2);   // whole or half pixels
  }

  // elements: [{x, y, w, h, kind}] in page pixels. Returns everything needed to draw the board.
  function generate(elements, width, height, seed, overrides) {
    const cfg = Object.assign({}, CFG, overrides);
    // The top `insetTop` px (the nav bar) are not part of the board: grow it in the space below, as if the page
    // began there, so traces heading up end at the bar's lower edge -- then shift the result back down (below).
    const inset = cfg.insetTop || 0;
    if (inset) {
      elements = elements.map((e) => Object.assign({}, e, { y: e.y - inset }));
      height -= inset;
    }
    // A very wide page: build the board over a centred strip and treat its left/right edges as the board's edges, then move it back.
    cfg.cell = cellFor(Math.min(width, cfg.maxBoardWidth), height, cfg);   // cfg.cell is the smallest cell; it grows if the grid (over the board's strip) would be too big
    const pageWidth = width, boardWidth = cfg.maxBoardWidth;
    const x0 = width > boardWidth ? Math.floor((width - boardWidth) / 2) : 0;
    if (x0) {
      elements = elements.map((e) => Object.assign({}, e, { x: e.x - x0 }));
      width = boardWidth;
    }
    const rng = mulberry32(seed);
    const G = makeGrid(width, height, cfg.cell);
    const { cell, cols, rows, blocked, boxCells } = G;

    // A 'round' element (the photo, the social icons) only blocks the grid -- its circle plus the usual margin:
    // everything routes around it, but it isn't a component, so no chip behind it and nothing grows out of it.
    const obstacles = elements.filter((e) => e.kind === 'round');
    elements = elements.filter((e) => e.kind !== 'round');

    // page elements become components, snapped OUTWARD to the grid (a wire needs a whole number of cells to sit on)
    const comps = elements.map((e) => {
      const pad = e.kind === 'text' ? cfg.textPad * cfg.cell / 2 : 0;
      const x0 = Math.floor((e.x - pad) / cell) * cell, y0 = Math.floor((e.y - pad) / cell) * cell;
      const x1 = Math.ceil((e.x + e.w + pad) / cell) * cell, y1 = Math.ceil((e.y + e.h + pad) / cell) * cell;
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, kind: e.kind, tag: e.tag, el: e.el };
    });
    // Every component is a node (page elements, pads, and the chips grown later) and every trace records the
    // node it leaves and, if it ends in a chip, the node it reaches -- so a pulse can spread along the board.
    const nodes = [];
    for (const c of comps) { c.id = nodes.length; nodes.push(c); }
    const srcLanes = [];   // node id -> the traces that leave it
    const record = (lanes, src, dst) => {
      // gsize = how many traces travel together in this bundle, so a pulse can share out its soft light
      for (const l of lanes) { l.src = src; l.dst = dst; l.gsize = lanes.length; (srcLanes[src] || (srcLanes[src] = [])).push(l); }
    };
    for (const c of comps)
      for (const k of boxCells(c.x, c.y, c.w, c.h, c.clearance === undefined ? cfg.clearance : c.clearance)) blocked[k]++;
    for (const o of obstacles)
      for (const k of G.circleCells(o.x + o.w / 2, o.y + o.h / 2, Math.min(o.w, o.h) / 2, cfg.clearance)) blocked[k]++;

    const stripLanes = [], viaLanes = [], vias = [], chips = [];
    const linkSpines = new Map();   // "srcId>dstId" -> exact construction-time spine (see layStrip), for the scroll-chain bar
    // ---- the cables you asked for: cfg.links lists which page elements are joined (one cable each). Each is routed with
    // A* and laid down BEFORE the random growth, which then routes around them and skips the faces they use.
    const facesCovered = new Map();   // "node:face" -> the nubs on that face already used by a cable
    const cover = (id, face, nub, w) => {
      const k = id + ':' + face;
      if (!facesCovered.has(k)) facesCovered.set(k, new Set());
      for (let n = nub; n < nub + w; n++) facesCovered.get(k).add(n);
    };
    const compFor = (x) => {          // an index, or the page element a component was built from (or one inside / around it)
      if (typeof x === 'number') return comps[x] || null;
      if (!x) return null;
      return comps.find((c) => c.el === x) || comps.find((c) => c.el && typeof x.contains === 'function' && (x.contains(c.el) || c.el.contains(x))) || null;
    };
    const ringCells = (o) => {          // the keepout ring around a component (not the component's own cells)
      const bc0 = G.cellC(o.x + 1e-6), br0 = G.cellR(o.y + 1e-6), bc1 = G.cellC(o.x + o.w - 1e-6), br1 = G.cellR(o.y + o.h - 1e-6);
      const cl = cfg.clearance, out = [];
      for (let c = Math.max(0, bc0 - cl); c <= Math.min(cols - 1, bc1 + cl); c++)
        for (let r = Math.max(0, br0 - cl); r <= Math.min(rows - 1, br1 + cl); r++)
          if (!(c >= bc0 && c <= bc1 && r >= br0 && r <= br1)) out.push(c * rows + r);
      return out;
    };
    const conn = cfg.connect;
    for (const link of cfg.links || []) {
      const A = compFor(link[0]), B = compFor(link[1]);
      if (!A || !B || A === B) continue;
      // lift A's and B's own keepout for this cable (it has to cross them); put it back afterwards
      const lifted = [ringCells(A), ringCells(B)];
      for (const list of lifted) for (const k of list) blocked[k]--;
      const count = (c, r) => (c < 0 || c >= cols || r < 0 || r >= rows ? 1 : blocked[c * rows + r]);
      const wMax = Math.min(link[2] || conn.width, Math.floor(Math.min(A.w, A.h, B.w, B.h) / cell));
      for (const w of [wMax, Math.round(wMax * 0.7), wMax >> 1]) {   // a narrower cable if the wide one can't be routed
        if (w < cfg.minWires || (w !== wMax && w >= wMax)) continue;
        // exact A* first (tidy routes); only if that hits the search cap, retry greedier (fewer states, but staircase-y routes)
        let route = null;
        for (const wt of [conn.weight, conn.weight * 4]) {
          route = routeStrip(G, A, B, w, rng, Object.assign({}, conn, { weight: wt }));
          if (route) break;
        }
        if (!route) continue;
        const laid = layStrip(G, A, B, w, route, count);
        if (!laid) continue;
        for (const l of laid.lanes) l.cable = true;    // one of the hand-written links (a click's pulse doesn't run along these)
        stripLanes.push(...laid.lanes);
        record(laid.lanes, A.id, B.id);
        linkSpines.set(A.id + '>' + B.id, laid.spine);
        const nubA = route.start.d % 2 === 0 ? route.start.c - G.cellC(A.x + 1e-6) : route.start.r - G.cellR(A.y + 1e-6);
        const nubB = laid.endD % 2 === 0 ? laid.endAnchor[0] - G.cellC(B.x + 1e-6) : laid.endAnchor[1] - G.cellR(B.y + 1e-6);
        cover(A.id, route.start.d, nubA, w);
        cover(B.id, (laid.endD + 2) % 4, nubB, w);
        break;
      }
      for (const list of lifted) for (const k of list) blocked[k]++;
    }
    // The components waiting to grow their own traces, in a multilevel queue. A component's level is how many components it is
    // from a page element: page elements are level 0, a chip grown from one is level 1, a chip grown from that is level 2...
    // Each step takes a random component from the lowest non-empty level, so everything nearer the page elements has claimed
    // its space before anything further out gets a turn (and the order within a level is mixed up).
    const queues = [comps.slice()];
    comps.forEach((c) => { c.level = 0; });
    const nextWaiting = () => {
      let lvl = 0;
      while (lvl < queues.length && !queues[lvl].length) lvl++;
      if (lvl >= queues.length) return null;
      const q = queues[lvl], i = Math.floor(rng() * q.length), pick = q[i];
      q[i] = q[q.length - 1];                 // swap-remove
      q.pop();
      return pick;
    };
    let cur;
    while ((cur = nextWaiting())) {
      for (const direction of shuffle(rng, ['N', 'E', 'S', 'W'])) {
        const faceSpan = Math.round((direction === 'N' || direction === 'S' ? cur.w : cur.h) / cell);
        const covered = new Set(facesCovered.get(cur.id + ':' + 'NESW'.indexOf(direction)) || []);   // nubs used by a strip that actually grew (or that a connecting strip took)
        for (let attempt = 0; attempt < cfg.maxStripsPerFace; attempt++) {
          if (attempt > 0 && rng() > cfg.extraStripChance) break;
          const runs = freeRuns(faceSpan, covered, cfg);
          if (!runs.length) break;
          const [runStart, runLen] = runs[Math.floor(rng() * runs.length)];
          const stripWires = randint(rng, cfg.minWires, Math.min(cfg.maxWires, runLen));
          const offset = attempt === 0 ? runStart + Math.floor((runLen - stripWires) / 2)
            : runStart + randint(rng, 0, runLen - stripWires);
          let compWires = Math.round(stripWires * uniform(rng, cfg.compRatio[0], cfg.compRatio[1]));
          compWires = Math.max(stripWires, cfg.compMin, Math.min(compWires, cfg.compMax));
          // sometimes the chip is a rectangle: its depth (how far it reaches along the strip) differs from the side the strip plugs into
          const newDepth = rng() < cfg.rectChance ? Math.max(3, Math.round(compWires * uniform(rng, cfg.rectDepth[0], cfg.rectDepth[1]))) * cell : null;
          const res = growCable(G, rng, cur, direction, {
            turnChance: 0.02, bias: 0.9, turn90Chance: 0.02, maxTurns90: 1, maxCells: 98, minCells: 40,
            width: stripWires, offset, newSize: compWires * cell, newDepth, clearance: cfg.clearance,
            maxBackups: cfg.maxBackups,
          });
          if (!res.lanes.length) continue;   // scrapped -- those nubs stay free for vias or a later strip
          for (let n = offset; n < offset + stripWires; n++) covered.add(n);
          stripLanes.push(...res.lanes);
          if (res.comp) {
            res.comp.id = nodes.length; res.comp.level = cur.level + 1;
            nodes.push(res.comp); chips.push(res.comp);
            (queues[res.comp.level] || (queues[res.comp.level] = [])).push(res.comp);
          }
          record(res.lanes, cur.id, res.comp ? res.comp.id : -1);
        }
        // every leftover nub gets its own single-wire walk ending in a via, dropped silently if blocked
        const nubs = [];
        for (let nub = 0; nub < faceSpan; nub++) if (!covered.has(nub)) nubs.push(nub);
        if (cfg.shuffleVias) shuffle(rng, nubs);
        const faceVias = [];
        for (const nub of nubs) {
          const res = growCable(G, rng, cur, direction, {
            turnChance: 0.1, bias: 0.7, maxCells: randint(rng, 20, 50), minCells: 2, width: 1, offset: nub,
            endsInVia: true, clearance: cfg.clearance, maxBackups: cfg.viaBackups,
          });
          if (!res.via) continue;
          viaLanes.push(res.lanes[0]); vias.push(res.via);
          record(res.lanes, cur.id, -1);
          faceVias.push(res.lanes[0]);
        }
        for (const l of faceVias) l.gsize = faceVias.length;
      }
    }

    // Pads go down last, after every real component's own walk has had first claim on the space -- otherwise a pad placed
    // early could sit right where a walk would have grown, and how many chips a run produces became inconsistent purely
    // because of where chance happened to drop pads. makePads now checks the grid directly (not just the page elements it's
    // handed), so it only ever lands on space nothing else -- a wire, a chip, a pad -- has already claimed.
    const pads = makePads(rng, G, comps.concat(obstacles), cfg);
    for (const c of pads) { c.id = nodes.length; nodes.push(c); }
    for (const c of pads) for (const k of boxCells(c.x, c.y, c.w, c.h, c.clearance === undefined ? cfg.clearance : c.clearance)) blocked[k]++;

    // pads get a short lead of their own ending in a via, grown last so they only use what room is left
    for (const pad of pads) {
      if (rng() > cfg.padLeadChance) continue;
      const faceSpan = Math.round(pad.w / cell);
      const res = growCable(G, rng, pad, ['N', 'E', 'S', 'W'][Math.floor(rng() * 4)], {
        turnChance: 0.1, bias: 0.7, maxCells: randint(rng, 10, 30), minCells: 2, width: 1,
        offset: Math.floor(rng() * faceSpan), endsInVia: true, clearance: cfg.padClearance, maxBackups: 0,
      });
      if (!res.via) continue;
      viaLanes.push(res.lanes[0]); vias.push(res.via);
      record(res.lanes, pad.id, -1);
    }
    // decided last, so it never disturbs the routing: -1 = no dimple, else 0 TL / 1 TR / 2 BL / 3 BR
    const pageChips = comps.filter((c) => c.kind === 'text' || c.kind === 'card');
    for (const c of chips.concat(pageChips)) c.dimple = rng() < cfg.dimpleChance ? Math.floor(rng() * 4) : -1;
    const lights = pageChips.filter((c) => cfg.litKinds.includes(c.kind));
    for (const c of lights) c.light = cfg.lightLevels[c.tag] !== undefined ? cfg.lightLevels[c.tag] : (cfg.lightLevels[c.kind] || 0.5);
    const result = { width, height: height + inset, cell, comps, nodes, srcLanes, obstacles, pads, chips, pageChips, lights, lightReach: cfg.lightReach * cell, lightDecay: cfg.lightDecay, stripLanes, viaLanes, vias, cols, rows, blocked, linkSpines };
    if (inset || x0) shiftBy(result, x0, inset);
    if (x0) result.width = pageWidth;
    return result;
  }

  // Moves everything a generation produced right by dx and down by dy. Shared objects (a via IS its trace's last point; nodes are
  // the same objects as comps, pads and chips) are moved once, not once per list they appear in.
  function shiftBy(g, dx, dy) {
    const seen = new Set();
    const move = (o) => { if (o && !seen.has(o)) { seen.add(o); o.x += dx; o.y += dy; } };
    for (const list of [g.comps, g.obstacles, g.pads, g.chips, g.nodes, g.vias]) list.forEach(move);
    for (const set of [g.stripLanes, g.viaLanes]) for (const lane of set) lane.forEach(move);
    if (g.linkSpines) for (const spine of g.linkSpines.values()) spine.forEach(move);
  }

  // ---- drawing (SVG strings) -------------------------------------------------
  // black and white: white copper on the dark grey page. STYLE is the plain board, GLOW the brighter copy the
  // cursor spotlight shows -- chip bodies stay dark so text on them is readable, the metal is white.
  const STYLE = {
    trace: '#d9d9d9', via: '#e6e6e6', pad: '#f2f2f2', body: '#333333', bodyEdge: '#bdbdbd',
    bevelLight: '#9a9a9a', bevelDark: '#0d0d0d', dimple: '#0a0a0a', pin: '#cfcfcf',
  };
  const GLOW = {
    trace: '#ffffff', via: '#ffffff', pad: '#ffffff', body: '#4a4a4a', bodyEdge: '#ffffff', pageBody: '#161616',
    bevelLight: '#ffffff', bevelDark: '#111111', dimple: '#0d0d0d', pin: '#ffffff',
  };
  const f = (v) => Math.round(v * 10) / 10;

  function toSvg(g, grainHref, pal, lit) {
    const S = pal || STYLE;
    const cell = g.cell, pinW = cell * 0.5, pinLen = cell * 0.8;
    const d = [];
    // one path per layer -- a few dozen DOM nodes instead of thousands
    const polyline = (pts) => 'M' + pts.map((p) => `${f(p.x)} ${f(p.y)}`).join('L');
    const traces = g.stripLanes.concat(g.viaLanes).filter((l) => l.length > 1).map(polyline).join('');

    const leads = [], bodies = [], pageBodies = [], bevelL = [], bevelD = [], dimples = [];
    const pageSet = new Set(g.pageChips || []);
    const rectD = (x, y, w, h) => `M${f(x)} ${f(y)}h${f(w)}v${f(h)}h${f(-w)}z`;
    for (const c of g.chips.concat(g.pageChips || [])) {
      for (let k = 0; k < Math.round(c.w / cell); k++) {
        const px = c.x + k * cell + cell / 2 - pinW / 2;
        leads.push(rectD(px, c.y - pinLen, pinW, pinLen), rectD(px, c.y + c.h, pinW, pinLen));
      }
      for (let k = 0; k < Math.round(c.h / cell); k++) {
        const py = c.y + k * cell + cell / 2 - pinW / 2;
        leads.push(rectD(c.x - pinLen, py, pinLen, pinW), rectD(c.x + c.w, py, pinLen, pinW));
      }
      (lit && S.pageBody && pageSet.has(c) ? pageBodies : bodies).push(rectD(c.x, c.y, c.w, c.h));
      const b = cell * 0.3;
      bevelL.push(`M${f(c.x + b)} ${f(c.y + c.h - b)}L${f(c.x + b)} ${f(c.y + b)}L${f(c.x + c.w - b)} ${f(c.y + b)}`);
      bevelD.push(`M${f(c.x + c.w - b)} ${f(c.y + b)}L${f(c.x + c.w - b)} ${f(c.y + c.h - b)}L${f(c.x + b)} ${f(c.y + c.h - b)}`);
      if (c.dimple < 0) continue;
      const r = Math.max(cell * 0.4, Math.min(cell * 1.5, Math.min(c.w, c.h) * 0.05));
      const inset = 2.2 * r + cell * 0.5;
      const cx = c.dimple % 2 === 0 ? c.x + inset : c.x + c.w - inset;
      const cy = c.dimple < 2 ? c.y + inset : c.y + c.h - inset;
      dimples.push(`M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0`);
    }
    const vr = cell * 0.35;
    const viaD = g.vias.map((v) =>
      `M${f(v.x - vr)} ${f(v.y)}a${f(vr)} ${f(vr)} 0 1 0 ${f(2 * vr)} 0a${f(vr)} ${f(vr)} 0 1 0 ${f(-2 * vr)} 0`).join('');
    const padD = g.pads.map((p) => rectD(p.x, p.y, p.w, p.h)).join('');

    d.push(`<g transform="translate(.5 .5)">`);
    d.push(`<path d="${traces}" fill="none" stroke="${S.trace}" stroke-width="${f(cell * 0.25)}" stroke-linejoin="round"/>`);
    d.push(`<path d="${leads.join('')}" fill="${S.pin}"/>`);
    d.push(`<path d="${bodies.join('')}" fill="${S.body}" stroke="${S.bodyEdge}" stroke-width="${f(cell * 0.2)}"/>`);
    if (pageBodies.length) d.push(`<path d="${pageBodies.join('')}" fill="${S.pageBody}" stroke="${S.bodyEdge}" stroke-width="${f(cell * 0.2)}"/>`);
    if (grainHref) d.push(`<path d="${bodies.join('')}" fill="url(#pcb-grain)"/>`);
    d.push(`<path d="${bevelL.join('')}" fill="none" stroke="${S.bevelLight}" stroke-width="${f(cell * 0.3)}"/>`);
    d.push(`<path d="${bevelD.join('')}" fill="none" stroke="${S.bevelDark}" stroke-width="${f(cell * 0.3)}"/>`);
    d.push(`<path d="${dimples.join('')}" fill="${S.dimple}" stroke="${S.bevelLight}" stroke-width="${f(cell * 0.12)}"/>`);
    d.push(`<path d="${padD}" fill="${S.pad}"/>`);
    d.push(`<path d="${viaD}" fill="var(--bg, #161616)" stroke="${S.via}" stroke-width="${f(cell * 0.15)}"/>`);
    d.push('</g>');
    if (lit && g.lights.length) {
      // the bright copy shows only in a soft halo around each light: stacked translucent rounded rects, biggest
      // first, so brightness builds towards the box and fades with distance (no blur filter -- those stall the page)
      const steps = 10, halo = [];
      for (const c of g.lights) {
        for (let i = 0; i < steps; i++) {
          const e = g.lightReach * Math.pow((steps - i) / steps, g.lightDecay);   // rings packed towards the box = steeper falloff
          halo.push(`<rect x="${f(c.x - e)}" y="${f(c.y - e)}" width="${f(c.w + 2 * e)}" height="${f(c.h + 2 * e)}" rx="${f(e)}" fill="#fff" opacity="${f(0.1 * c.light * 100) / 100}"/>`);
        }
        halo.push(`<rect x="${f(c.x)}" y="${f(c.y)}" width="${f(c.w)}" height="${f(c.h)}" fill="#fff" opacity="${f(0.5 * c.light * 100) / 100}"/>`);
      }
      return `<defs><mask id="pcb-lit" maskUnits="userSpaceOnUse" x="0" y="0" width="${g.width}" height="${g.height}">`
        + `<rect width="${g.width}" height="${g.height}" fill="#000"/>${halo.join('')}</mask></defs>`
        + `<g mask="url(#pcb-lit)">${d.join('')}</g>`;
    }
    const defs = grainHref
      ? `<defs><pattern id="pcb-grain" width="64" height="64" patternUnits="userSpaceOnUse"><image href="${grainHref}" width="64" height="64"/></pattern></defs>`
      : '';
    return defs + d.join('');
  }

  // ---- pulses: light spreading along the traces -----------------------------------------------------------
  // A pulse starts at one node (a component) and runs along every trace leaving it, at `speed` px/ms. When a
  // trace reaches a chip, that chip lights up and the traces leaving IT start too -- like current spreading
  // through the board -- up to `hops` chips deep.
  const PULSE = {
    speed: 0.6,        // px per ms (the STARTING speed: see duration)
    persist: true,     // true: lit traces STAY lit until every trace in the pulse has reached its end, then all fade
                       // together; false: each trace only lights up as the head passes, with a fading tail behind it
    tail: 240,         // px of bright light behind the head (with persist: the leading edge that eases down to the steady glow)
    duration: 2000,    // ms the light takes to reach its farthest wire: it accelerates as much as needed (0 = constant speed)
    boomerang: false,  // once the light has reached its farthest wires it comes BACK along the same paths, farthest first, to the element it started from (false: everything just fades)
    fadeOut: 1500,     // ms the return trip (or, without boomerang, the fade) takes once the last trace has arrived (persist only)
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
    hover: false,          // whether moving the pointer onto a component sets off a pulse -- paused for now; true turns it back on
    hoverCooldown: 1500,   // ms before the same component can be set off again by the pointer
  };

  function laneMetrics(lane) {   // cumulative length along a trace, and its bounding box (computed once)
    if (lane.cum) return lane;
    const cum = new Float64Array(lane.length);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < lane.length; i++) {
      if (i) cum[i] = cum[i - 1] + Math.hypot(lane[i].x - lane[i - 1].x, lane[i].y - lane[i - 1].y);
      x0 = Math.min(x0, lane[i].x); y0 = Math.min(y0, lane[i].y); x1 = Math.max(x1, lane[i].x); y1 = Math.max(y1, lane[i].y);
    }
    lane.cum = cum; lane.len = cum[lane.length - 1]; lane.bb = [x0, y0, x1, y1];
    return lane;
  }

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
    const a = T ? Math.max(0, (2 * (Smax - v0 * T)) / (T * T)) : o.accel || 0;                  // px/ms^2
    const clock = (t) => v0 * t + 0.5 * a * t * t;                                            // distance the head has covered by time t
    const tOf = (S) => (a > 1e-9 ? (-v0 + Math.sqrt(v0 * v0 + 2 * a * S)) / a : S / v0);      // ...and the time it gets to distance S
    for (const e of sched) { e.t0 = tOf(e.S0); e.arrive = tOf(e.arriveS); }
    for (const fl of flashes) fl.at = tOf(fl.atS);
    const last = tOf(Smax);
    // persist: everything holds until the last trace arrives (`done`), then fades over fadeOut
    const end = o.persist ? last + o.fadeOut : last + o.tail / v0 + o.flash;
    return { sched, flashes, opts: o, done: last, end, clock, accel: a, Smax, origin: g.nodes[originId] };
  }

  // ---- power as a cellular automaton, solved instantly ------------------------------------------------------
  // Every trace is cut into cells FLOW.cellStep px apart; each chip is a cell too, linked to the ends of every
  // trace touching it. A cell holds a power 0..1: the strongest of (source level * gain^hops) over the sources,
  // gain = exp(-cellStep / decayLength), i.e. a little less at every hop. Nothing travels over time -- change a
  // source's level and the whole field follows at once; a stronger source reaches further because more cells stay
  // above the cutoff `eps`. Animation is just the source levels changing (a click's level, the scroll speed).
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
  // clicking a component
  const CLICK = { hold: 3000, fade: 1200, level: 1, decayLength: undefined };   // decayLength: px this source's power falls to 1/e over; undefined = FLOW.decayLength

  function buildNet(g, S) {
    const nNodes = g.nodes.length, xs = [], ys = [], nxt = [], ws = [], cabSrc = [], cabDst = [], cabStep = [], edges = [], viaCell = new Int32Array(g.vias.length).fill(-1);
    for (const nd of g.nodes) { xs.push(nd.x + nd.w / 2); ys.push(nd.y + nd.h / 2); nxt.push(-1); ws.push(1); cabSrc.push(-1); cabDst.push(-1); cabStep.push(-1); }
    // Every wire of a bundle (the wires of one strip or cable, which share their two ends) gets the SAME number of cells, from the bundle's
    // mean length. Power fades per cell, so wires that run side by side then carry the same power at the same place -- instead of the outer
    // wire of a turn (which is physically longer) being dimmer all the way along.
    const bundleLen = new Map();
    for (const lane of g.stripLanes) {
      if (lane.length < 2 || lane.dst < 0) continue;
      laneMetrics(lane);
      const b = bundleLen.get(lane.src + '>' + lane.dst) || bundleLen.set(lane.src + '>' + lane.dst, { sum: 0, count: 0 }).get(lane.src + '>' + lane.dst);
      b.sum += lane.len; b.count++;
    }
    // Cable cells are also grouped by STEP -- their position (0..n-1) along the bundle, the same for every wire at once, since all of a
    // bundle's wires share the same cell count. This lets a "slice across the cable" follow its turns (see cableSteps, used by the line of
    // power) instead of only ever being a flat horizontal line irrespective of which way the wires are actually running.
    const cableMeta = new Map(), stepCells = new Map();
    for (const set of [g.stripLanes, g.viaLanes]) for (let li = 0; li < set.length; li++) {
      const lane = set[li];
      if (lane.length < 2) continue;
      laneMetrics(lane);
      const bl = set === g.stripLanes && lane.dst >= 0 ? bundleLen.get(lane.src + '>' + lane.dst) : null;
      const len = bl ? bl.sum / bl.count : lane.len;
      const n = Math.max(2, Math.round(len / S) + 1), base = xs.length, w = 1 / Math.pow(lane.gsize || 1, 0.65);
      const key = lane.cable ? lane.src + '>' + lane.dst : null;
      if (key && !cableMeta.has(key)) { cableMeta.set(key, { n, len }); stepCells.set(key, Array.from({ length: n }, () => [])); }
      let seg = 1;
      for (let j = 0; j < n; j++) {
        const s = (lane.len * j) / (n - 1);
        while (seg < lane.length - 1 && lane.cum[seg] < s) seg++;
        const s0 = lane.cum[seg - 1], s1 = lane.cum[seg], t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
        xs.push(lane[seg - 1].x + (lane[seg].x - lane[seg - 1].x) * t);
        ys.push(lane[seg - 1].y + (lane[seg].y - lane[seg - 1].y) * t);
        nxt.push(j < n - 1 ? base + j + 1 : -1); ws.push(w);
        cabSrc.push(lane.cable ? lane.src : -1); cabDst.push(lane.cable ? lane.dst : -1);   // (cells of a hand-written cable know its two ends)
        cabStep.push(key ? j : -1);
        if (key) stepCells.get(key)[j].push(base + j);
        if (j) edges.push(base + j - 1, base + j);
      }
      if (set === g.viaLanes) viaCell[li] = base + n - 1;         // a via sits at the end of its wire
      if (lane.src >= 0 && lane.src < nNodes) edges.push(lane.src, base);
      if (lane.dst >= 0 && lane.dst < nNodes) edges.push(lane.dst, base + n - 1);
    }
    const N = xs.length, start = new Int32Array(N + 1);
    for (let e = 0; e < edges.length; e++) start[edges[e] + 1]++;
    for (let i = 0; i < N; i++) start[i + 1] += start[i];
    const adj = new Int32Array(edges.length), fill = start.slice(0, N);
    for (let e = 0; e < edges.length; e += 2) { adj[fill[edges[e]]++] = edges[e + 1]; adj[fill[edges[e + 1]]++] = edges[e]; }
    const order = Int32Array.from({ length: N - nNodes }, (_, i) => i + nNodes).sort((a, b) => ys[a] - ys[b]);
    const sortedY = Float32Array.from(order, (i) => ys[i]);
    for (const [key, meta] of cableMeta) {
      const [srcHub, dstHub] = key.split('>').map(Number);
      const cells = stepCells.get(key), avgY = (list) => list.reduce((s, c) => s + ys[c], 0) / list.length;
      const A = g.nodes[srcHub], B = g.nodes[dstHub];
      meta.srcHub = srcHub; meta.dstHub = dstHub;
      // y0/y1: where the cable's wires actually TOUCH each component (the mean of its wires at that end) -- used to work out how far
      // along the cable the light is. lo/hi: the cable stays active for the FULL BOX of either end component too, not just its own
      // span between them -- so as the bar crosses a component, the cable it just arrived on stays lit, pinned at that true touch
      // point (u clamped to 0..1), instead of the light jumping straight across the component to the next cable at its centre, or
      // going dark while the bar is still sitting on the component.
      meta.y0 = avgY(cells[0]); meta.y1 = avgY(cells[meta.n - 1]);
      meta.lo = Math.min(meta.y0, meta.y1, A.y, B.y);
      meta.hi = Math.max(meta.y0, meta.y1, A.y + A.h, B.y + B.h);
    }
    return { n: N, hubs: nNodes, x: Float32Array.from(xs), y: Float32Array.from(ys), nxt: Int32Array.from(nxt), w: Float32Array.from(ws),
      start, adj, order, sortedY, viaCell, cabSrc: Int16Array.from(cabSrc), cabDst: Int16Array.from(cabDst), cabStep: Int16Array.from(cabStep),
      cableMeta, stepCells, p: new Float32Array(N), q: new Float32Array(N), max: 0 };
  }

  // The power field, instantly: every cell holds the strongest of (source level * gain^hops) over the sources, and
  // anything at or below `eps` is dark. No time is involved -- the field is whatever the source levels say right now,
  // so a stronger source simply reaches further. Cost is proportional to the number of lit cells (a label-correcting
  // walk out from the sources), not the size of the board.
  // Decay is a property of the SOURCE, not of the solve: `reach` is an optional array parallel to `src` giving each source's own
  // decayLength in px (falls back to FLOW.decayLength -- the previous, single global value -- for any entry left undefined). Power
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

  // cells (not chips) within `band` px of the horizontal line y
  function cellsNear(net, y, band) {
    const sy = net.sortedY;
    let lo = 0, hi = sy.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sy[m] < y - band) lo = m + 1; else hi = m; }
    const out = [];
    for (let i = lo; i < sy.length && sy[i] <= y + band; i++) out.push(net.order[i]);
    return out;
  }

  // ---- the line: a band across the middle of the window that lights only the hand-written cables ----------------------
  // A page element stores power a bit like a capacitor. Its stored charge always relaxes (over about tau ms) towards the power it is being
  // fed. When the feed RISES it also gets a surge -- extra charge that lets it overshoot up to (gain x its input) -- and the surge decays
  // away over surgeTau ms, so the charge comes back down to exactly the power the bar is feeding it (0 when nothing is). max caps the charge.
  const CAP = { gain: 2, tau: 250, tauUp: 100, surgeTau: 900, max: 2 };   // tau: ms to drain / settle down; tauUp: ms to charge up (faster, so a fast-moving bar doesn't outrun it)
  const LINE = {
    enabled: true,
    power: 2.5,         // the LINE's power: what it feeds a cable it crosses, and a page element it is over (which STORES it -- see CAP). A click gives CLICK.level = 1
    decayLength: 6,     // px the line's own power falls to 1/e over -- a tight, bright pinpoint of light on the wires it crosses
    chainSteer: true,   // scroll drives progress ALONG THE CABLES (see buildChain), and the viewport is corrected to track it, rather than
                        // scroll position driving where the light is -- false goes back to plain, uncorrected scrolling
  };
  // A charged component radiates into its own wires at the SAME rate the bar itself decays on a wire -- so a component doesn't glow any
  // further out than the bar's own tight pinpoint does (undefined would fall back to the much gentler FLOW.decayLength instead).
  CAP.decayLength = LINE.decayLength;


  // ===========================================================================
  // Browser side
  // ===========================================================================
  const api = { generate, growCable, makeGrid, toSvg, schedulePulse, buildNet, solveNet, cellsNear, CFG, PULSE, FLOW, CLICK, CAP, LINE, mulberry32 };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  if (typeof document === 'undefined') return;

  const SVGNS = 'http://www.w3.org/2000/svg';
  const mm = window.matchMedia('(prefers-reduced-motion: reduce)');
  let svg = null, glow = null, canvas = null, ctx = null, softBufs = [], boardCv = null, tmpCv = null, maskCv = null,
      boardKey = '', geoVersion = 0, dpr = 1, canvasW = 0, regionH = 0, regionTop = 0, raf = 0, geometry = null, lastKey = '', lastSig = '';
  const pulses = new Set();
  const MAX_PULSES = 8;
  const signature = (els) => els.map((e) => [e.x, e.y, e.w, e.h].map(Math.round).join(',')).join(';');

  // Every substantial content element is a component; nested ones count once (a card, not each child).
  function collectElements() {
    const sx = window.scrollX, sy = window.scrollY;
    const claimed = [];
    const nested = (r) => claimed.some((s) => {
      const ix = Math.max(0, Math.min(r.right, s.right) - Math.max(r.left, s.left));
      const iy = Math.max(0, Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top));
      return ix * iy > r.width * r.height * 0.55;
    });
    const list = [...document.querySelectorAll('h1, h2, h3, h4, p, li, img, figure, blockquote, .project-card, .text-panel')]
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

  // The grid cell is chosen so the board is about GRID_COLS cells across on ANY screen or zoom level (720 x 2px = a 1440px page;
  // it is given the width of the board's strip, so a very wide window gets the board a maxBoardWidth window would):
  // a bigger or more zoomed-out window gets bigger cells, not a bigger board with more components. Cell sizes are whole or half
  // CSS pixels (exactly representable, so the grid arithmetic stays exact), and among those near the ideal size the one that lands
  // closest to a whole DEVICE pixel is used, so 1px wires stay crisp. Never below 2 device pixels.
  const GRID_COLS = 720;
  function gridCell(width) {
    const dpr = window.devicePixelRatio || 1, ideal = width / GRID_COLS;
    let best = 0, bestErr = Infinity;
    for (let k = Math.max(2, Math.floor(ideal * 2) - 1); k <= Math.ceil(ideal * 2) + 1; k++) {
      const cell = k / 2, dev = cell * dpr;
      if (dev < 2) continue;
      const err = Math.abs(dev - Math.round(dev)) * 10 + Math.abs(cell - ideal);   // crispness first, then closeness to the ideal
      if (err < bestErr) { bestErr = err; best = cell; }
    }
    return best || Math.max(1, Math.ceil(2 / dpr * 2) / 2);
  }

  const paintLog = [];
  function paint() {
    if (!document.body) return;
    const width = document.documentElement.clientWidth;
    const t0 = performance.now();
    paintLog.push({ t: Math.round(t0), width });
    const nav = document.querySelector('.site-nav');
    const seed = 0x9e3779b9 + Math.round(width / 40), insetTop = nav ? nav.offsetHeight : 0, cell = gridCell(Math.min(width, CFG.maxBoardWidth));
    const links = resolveLinks();
    const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const els = collectElements();
    const g = generate(els, width, height, seed, { insetTop, links, cell });
    svg.__elements = els;   // what the board was built from (handy for checking it against the live page)
    lastSig = signature(els);
    geometry = g;
    geoVersion++;
    net = buildNet(g, FLOW.cellStep);
    clickSrc.clear();
    if (canvas) sizeCanvas();   // the page may have changed height since the canvas was last sized
    pulses.clear();   // a redraw builds new traces, so anything mid-flight refers to ones that no longer exist
    hoverNode = null;
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.innerHTML = toSvg(g, grainImage());
    // a brighter copy of the same board, revealed only in a halo around each lit element (see toSvg)
    glow.setAttribute('width', width);
    glow.setAttribute('height', height);
    glow.innerHTML = g.lights.length ? toSvg(g, null, GLOW, true) : '';   // the brighter copy is only built if some element is set to glow
    lastKey = `${width}x${height}`;
    lineWas = new Set();   // new board: the line is over nothing until the next frame says otherwise
    buildChain();
    // The very first build starts the light at the very start of the chain -- inside the name header, where PCB_LINKS begins --
    // rather than wherever chainProgressForY would sync it to, UNLESS the page actually opened already scrolled down (a bfcache
    // restore, an anchor link straight to #projects): then it needs to match reality immediately, or section triggers below
    // (which now go by chain progress, not just y -- see checkScrollSections) would wrongly stay unfired even though the page
    // is already sitting past them. Every later rebuild (resize, fonts arriving) always re-syncs to the current scroll position.
    chainProgress = (geoVersion === 1 && window.scrollY < 50) ? 0 : chainProgressForY(window.scrollY + window.innerHeight / 2);
    pwLastRawY = window.scrollY;
    for (const sec of SECTIONS) if (sec.state === 'running') { sec.state = 'idle'; fireSection(sec); }   // the rebuild cleared its pulse
    if (canvas && !raf) raf = requestAnimationFrame(frame);   // draw the line for the new board
    const paintMs = Math.round(performance.now() - t0);
    paintLog[paintLog.length - 1].ms = paintMs;
    svg.dataset.stats = `cell ${g.cell}px, ${g.chips.length} chips, ${g.stripLanes.length} strip wires, ${g.viaLanes.length} via wires, ${paintMs}ms`;
  }


  // ---- the pulse layer: a canvas over the viewport, only animating while a pulse is running ---------------
  function sizeCanvas() {
    // The pulse layer is a canvas positioned IN THE PAGE (absolute), covering the visible area plus a margin above
    // and below (two viewports tall in all). Because it is part of the page it scrolls with the text, exactly, on
    // the browser's own scrolling -- a window-fixed canvas redrawn on every scroll step lags behind the text.
    // It is only moved (and redrawn) when the visible area nears the edge of its margin: see ensureRegion().
    dpr = Math.min(window.devicePixelRatio || 1, 2);
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
  // Re-centre only when the visible area has come within a margin of the canvas edge -- AND has actually moved
  // meaningfully since the last time it recentred. Without that second check, scrolling back and forth near a
  // boundary (completely ordinary -- reading near the edge of what fits on screen, then scrolling back up) recentres
  // on every single reversal, each one repainting the whole board (renderBoard) from scratch: real measurements
  // showed that costing half of all frames during exactly this kind of back-and-forth scrolling. The safe distance
  // before that's needed is the same margin the immediate check already uses, so this doesn't weaken it for a scroll
  // that keeps going the same way -- it only stops re-triggering for one that doubles back within that same margin.
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
    const __t0 = performance.now();
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
    PROF.board += performance.now() - __t0; PROF.boardRuns++;
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

  const PROF = { frames: 0, solve: 0, build: 0, stroke: 0, composite: 0, cells: 0, worst: 0, board: 0, boardRuns: 0 };
  // a slice of a wire from arc length a to b -- measured from its far end when the light is running back up it
  const sl = (c, lane, a, b, rev) => (rev ? strokeSlice(c, lane, lane.len - b, lane.len - a, 0, regionTop) : strokeSlice(c, lane, a, b, 0, regionTop));
  function frame(now) {
    raf = 0;
    const T0 = performance.now();
    let T1 = T0, T2 = T0, T3 = T0;
    ensureRegion();
    const vw = canvasW, vh = regionH;   // the canvas covers page y in [regionTop, regionTop + regionH)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const b of softBufs) {
      b.x.setTransform(b.scale, 0, 0, b.scale, 0, 0);   // draw in viewport px; the buffer is just smaller
      b.x.clearRect(0, 0, vw, vh);
      b.x.globalCompositeOperation = 'lighter';
      b.x.lineCap = 'round'; b.x.lineJoin = 'round';
    }
    const ox = 0, oy = regionTop, K = 5, KS = 3;
    let lit = false, reveal = 0;
    for (const p of pulses) {
      const t = now - p.start, o = p.opts;
      if (p.reveals) for (const rv of p.reveals) if (!rv.done && t >= rv.at) { rv.done = true; revealEl(rv.el); }   // the light has reached it
      if (t > p.end) { if (p.section) p.section.state = 'done'; pulses.delete(p); continue; }
      const revealOn = o.reveal > 0;
      // persist: full strength until the last trace has arrived, then everything fades out together
      // `front` is how far along the wires (clock distance from the origin) the light reaches. It goes OUT with the pulse's acceleration
      // and, with o.boomerang, then comes BACK: the lit region retracts along the same paths, farthest wires first, the bright front
      // sliding home to the element that started it (accelerating as it goes), instead of everything fading together.
      const back = o.persist && o.boomerang && t > p.done;
      const u = back ? Math.min(1, (t - p.done) / o.fadeOut) : 0;                   // progress of the return, 0..1
      const front = back ? p.Smax * (1 - u * u) : p.clock(t);
      let fadeF = 1;
      if (back) { const w = Math.max(0, (u - 0.9) / 0.1); fadeF = 1 - w * w * (3 - 2 * w); }   // the last sliver eases out as the front reaches the origin
      else if (o.persist && !o.boomerang && t > p.done) {                                     // (no boomerang: an exponential fade of everything together)
        const fx = Math.min(1, (t - p.done) / o.fadeOut);
        fadeF = (Math.exp(-o.fadeRate * fx) - Math.exp(-o.fadeRate)) / (1 - Math.exp(-o.fadeRate));
      }
      if (revealOn) reveal = Math.max(reveal, o.reveal);
      ctx.strokeStyle = o.color; ctx.lineWidth = o.width * geometry.cell;
      if (revealOn) for (const b of softBufs) { b.x.strokeStyle = '#fff'; b.x.lineWidth = o.revealSize; }
      for (const s of p.sched) {
        const lane = s.lane, head = front - s.S0;
        if (head < 0) continue;                                           // not started yet
        if (!o.persist && head - o.tail > lane.len) continue;             // (fading-tail mode) already finished
        const bb = lane.bb;                                               // skip traces that are off screen
        const m = revealOn ? o.revealSize : 20;
        if (bb[2] - ox < -m || bb[0] - ox > vw + m || bb[3] - oy < -m || bb[1] - oy > vh + m) continue;
        if (!o.persist) {
          for (let k = 0; k < K; k++) {                                   // the lit line: brighter towards the head
            ctx.globalAlpha = Math.pow((k + 1) / K, 1.6) * o.alpha;
            sl(ctx, lane, head - (o.tail * (K - k)) / K, head - (o.tail * (K - k - 1)) / K, s.rev);
          }
          if (revealOn) {
            lit = true;
            for (let k = 0; k < KS; k++) {                                // the stencil: where the light reaches
              // a bundle shares its light out (dividing by its size^0.65) so 25 side by side reveal about as
              // much as a few, not 25 times as much
              const a = Math.pow((k + 1) / KS, 1.6) * 0.5 / Math.pow(lane.gsize || 1, 0.65);
              for (const b of softBufs) {
                b.x.globalAlpha = a;
                sl(b.x, lane, head - (o.tail * (KS - k)) / KS, head - (o.tail * (KS - k - 1)) / KS, s.rev);
              }
            }
          }
          continue;
        }
        // persist: the whole trace from its start up to the head stays lit at a steady glow; the last `tail` px
        // (the leading edge) is brighter, and once the head has reached the end that edge eases down to the glow
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
        if (!o.persist && dt > o.flash) continue;
        const n = f.node;
        // persist: a burst that settles to a steady glow, held until everything has arrived, then faded with the rest
        let level = o.persist ? (0.55 + 0.45 * Math.max(0, 1 - dt / o.flash)) * fadeF : 1 - dt / o.flash;
        if (back) level *= Math.max(0, Math.min(1, (front - f.atS) / o.tail));       // a chip goes dark as the returning front passes it
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
    const Ta = performance.now();
    solveField(now);
    T1 = performance.now();   // solveField's own cost is Ta..T1; T1..T2 below is building the wire-glow paths from its result
    if (net && net.max > FLOW.eps) {
      const floor = visibleFloor();
      const caScale = FLOW.layer / PULSE.layerOpacity;    // the layer is set for pulses; the power field is drawn a little dimmer than that
      // 200 brightness bands meant up to 200 separate ctx.stroke() calls every frame, each its own state change -- finer than
      // the eye can actually tell apart once anti-aliased, and the real cost driving the remaining per-frame lag. 48 is still
      // a fine enough gradient to look continuous, at a quarter of the worst-case draw calls.
      const NB = 48, rv = PULSE.reveal > 0, p = net.p, xs = net.x, ys = net.y, nx = net.nxt, ws = net.w, eps = FLOW.eps;
      const paths = [], sp = [];
      for (let b = 0; b < NB; b++) { paths.push(null); if (rv) sp.push(new Path2D()); }
      const used = new Uint8Array(NB), sused = new Uint8Array(NB);
      const bot0 = window.scrollY - oy - 140, top = bot0 + window.innerHeight + 280;   // only what is on screen (plus a margin) is drawn: the frame reruns on every scroll step
      // Power is only SOLVED at the net's cells (FLOW.cellStep apart); between two neighbouring cells it is drawn as a straight line, cut
      // into SUB steps each at its own interpolated brightness, so the change along a cell is continuous instead of jumping in one step at
      // each cell (visible as beading when a source's decayLength is short and neighbouring cells differ a lot). Position is interpolated
      // in px, value in power (its natural, ~exponential unit) before the brightness curve (shade) is applied.
      const SUB = 4;
      // net.sortedY/order (built once in buildNet, the same index cellsNear binary-searches) let this walk only the cells near
      // the visible window instead of every cell the whole board has -- tens of thousands of them on a real page -- most of
      // which this loop used to visit just to immediately discard as off screen or unlit, every single frame while scrolling.
      // Neighbouring cells are FLOW.cellStep apart, far inside the existing on-screen margin, so bounding by a node's own y
      // (with that same margin) can't cut off an edge whose other end is still genuinely in view.
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
      T2 = performance.now();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'butt';   // round caps would add up at every joint under 'lighter' and bead the line
      ctx.strokeStyle = FLOW.color; ctx.lineWidth = FLOW.width * geometry.cell;
      for (let b = 0; b < NB; b++) if (used[b]) { ctx.globalAlpha = Math.min(1, ((b + 0.5) / NB) * FLOW.alpha * caScale); ctx.stroke(paths[b]); lit = true; }
      if (PULSE.reveal > 0) for (const bf of softBufs) {
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
        if (PULSE.reveal > 0) for (const bf of softBufs) { bf.x.globalAlpha = cv * 0.5; bf.x.fillStyle = '#fff'; bf.x.fillRect(n.x - ox, n.y - oy, n.w, n.h); }
        lit = true;
      }
      if (lit) reveal = Math.max(reveal, PULSE.reveal);
      // The current point of progress isn't drawn as its own shape at all -- solveField already feeds real power directly into
      // whichever real cells (net.stepCells, picked by physical proximity to the exact construction-time position -- see
      // chainPointAt) are actually there, and the ordinary per-cell glow above (the same code that lights any other charged cell)
      // is what shows where it is. No separate reconstruction of a position/width to draw.
    }
    T3 = performance.now();
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
    const T4 = performance.now();
    PROF.frames++;
    PROF.solve += T1 - Ta;
    PROF.build += T2 - T1;
    PROF.stroke += T3 - T2;
    PROF.composite += T4 - T3;
    PROF.worst = Math.max(PROF.worst, T4 - T0);
    PROF.cells += net ? net.nTouched || 0 : 0;
    if (pulses.size || caActive()) raf = requestAnimationFrame(frame);   // otherwise it rests: the line is redrawn on each scroll
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

  // Moving the pointer onto a component sets off a pulse from it. Only when it ENTERS a different component (not
  // for every move inside one), and not again for the same one within `hoverCooldown`.
  let hoverNode = null;
  const lastFired = new Map();
  function onPointerOver(e) {
    if (!PULSE.hover || !geometry || !(e.target instanceof Element)) return;
    const t = e.target;
    const node = geometry.nodes.find((n) => n.el && (n.el === t || n.el.contains(t))) || null;
    if (node === hoverNode) return;
    hoverNode = node;
    if (!node) return;
    const now = performance.now();
    if (now - (lastFired.get(node.id) || -Infinity) < PULSE.hoverCooldown) return;
    lastFired.set(node.id, now);
    pulse(node.id);
  }

  // ---- power fed into the cellular automaton (PCBBoard.powerNode) ------------------------------------------------------
  let net = null;
  const clickSrc = new Map();   // node id -> time (ms) the click happened

  // is anything still lit or being fed?
  // does the power field need redrawing every frame? (a click's timed power, or line power still easing away -- steady power is
  // just drawn again whenever the page scrolls)
  let lineAnimating = false;
  function caActive() { return !!net && (clickSrc.size > 0 || lineAnimating); }

  // a click's power level: full for CLICK.hold ms, then eased down to nothing over CLICK.fade ms
  function clickLevel(t0, now) {
    const t = now - t0;
    if (t < CLICK.hold) return CLICK.level;
    const x = (t - CLICK.hold) / CLICK.fade;
    return x >= 1 ? 0 : CLICK.level * (1 - x) * (1 - x);
  }

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
    const idx = [], val = [];
    const idxReach = [];
    for (const [id, t0] of clickSrc) {
      const lv = clickLevel(t0, now);
      if (lv <= 0) { clickSrc.delete(id); continue; }
      idx.push(id); val.push(lv); idxReach.push(CLICK.decayLength);
    }
    const dt = Math.min(100, lineT ? now - lineT : 0), inside = new Set(), lineCells = [], lineVal = [];
    lineT = now;
    // Where the light actually is: a single point of PROGRESS along the whole chain of cables (see buildChain/chainPointAt), driven
    // by scroll input in onLineScroll -- so it advances evenly however a cable is oriented (a horizontal stretch gets exactly as
    // much of it as a vertical one of the same length), and the viewport is corrected to track it. A page element only charges
    // (and only fires its 'pcb-power' event -- see announceLine) while that point is a BRIDGE actually inside it (see buildChain),
    // never merely because it shares a y with wherever the point happens to be -- a component off to the side at that height, or
    // further along a cable that has since bent away in x, is not "under the light" just because a horizontal line would cross it.
    const pt = (LINE.chainSteer && chain && chain.length) ? chainPointAt(chainProgress) : null;
    if (pt && pt.bridge && pt.componentId != null && activated(pt.componentId)) inside.add(pt.componentId);
    announceLine(inside);
    if (LINE.power > 0 && pt && !pt.bridge && (activated(pt.seg.meta.srcHub) || activated(pt.seg.meta.dstHub)))
      for (const c of pt.cells) { lineCells.push(c); lineVal.push(LINE.power); }
    // One network for all power. A component the light has not reached yet is closed: power does not enter it (or pass through it).
    const closed = new Uint8Array(net.hubs);
    for (const n of geometry.comps) if (!activated(n.id)) closed[n.id] = 1;
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
      for (const l of geometry.stripLanes) if (l.cable) {
        (linked.get(l.src) || linked.set(l.src, new Set()).get(l.src)).add(l.dst);
        (linked.get(l.dst) || linked.set(l.dst, new Set()).get(l.dst)).add(l.src);
      }
    }
    // solveNet's propagation is a max, not a sum -- max(base-sources ∪ near-sources) at any cell is exactly
    // max(max(base-sources), max(near-sources)), so re-including the whole of `base` (the line's cross-section, click
    // sources -- often dozens of cells) in every one of these calls was pure waste: the base-only result at n.id is
    // already sitting in `feed` from the solve above, so re-solving just the tiny `near` set and taking the max with
    // that gives the exact same answer for a fraction of the cost. This loop runs once per component with a charged
    // linked neighbour, which is exactly the case that gets more common the more vigorously the page is scrolled
    // (charge lingers and decays over CAP.tau, so fast scrolling keeps more components charged at once) -- that used
    // to mean more and more full re-solves of the whole board piling up per frame, which is where the lag was coming from.
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
      const input = closed[id] ? 0 : Math.max(inside.has(id) ? LINE.power : 0, feed.get(id) || 0);
      const st = charge.get(id) || (charge.set(id, { q: 0, surge: 0, prev: 0 }), charge.get(id));
      if (input > st.prev) st.surge = Math.min(1, st.surge + (input - st.prev) / 0.3);      // a rise in the feed: a surge of extra charge...
      st.surge *= Math.exp(-dt / CAP.surgeTau);                                               // ...which fades away
      st.prev = input;
      const target = input * (1 + (CAP.gain - 1) * st.surge);                                // relax to the feed, plus the surge on top
      st.q = Math.min(CAP.max, st.q + (dt * (target - st.q)) / (target > st.q ? CAP.tauUp : CAP.tau));
      if (st.q < 0.005 && input === 0 && st.surge < 0.01) { charge.delete(id); continue; }
      if (Math.abs(target - st.q) > 0.005 || st.surge > 0.01) lineAnimating = true;           // still charging, surging or draining: keep drawing frames
      if (st.q > 0.005) { stored.push(id); storedVal.push(st.q); }
    }
    // 3) the field that is drawn: the outside sources plus what the elements have stored. An element's output is ONLY its stored charge:
    //    what arrives at it (step 1) just charges it, so the light changes smoothly with time however the bar moves.
    const shut = new Uint8Array(net.hubs);
    for (const n of geometry.comps) shut[n.id] = 1;
    solveNet(net, floor, Int32Array.from(idx.concat(lineCells, stored)), Float32Array.from(val.concat(lineVal, storedVal)), shut,
      idxReach.concat(lineCells.map(() => LINE.decayLength), stored.map(() => CAP.decayLength)));
  }

  // give a component power for CLICK.hold ms; after that the automaton lets it decay away
  function powerNode(id) {
    if (!geometry || !net || mm.matches || !geometry.nodes[id]) return false;
    ensureRegion();
    clickSrc.set(id, performance.now());
    if (!raf) raf = requestAnimationFrame(frame);
    return true;
  }

  // clicking a component (a text block, card -- or any invisible chip, by position) sets off a pulse: light spreads out
  // along the wires and lights each component it reaches, one after another (see PULSE). PCBBoard.powerNode(id) still
  // gives one component steady power instead.
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
    if (!geometry || !canvas) return false;
    const startNode = findNode(geometry, sec.start);
    if (!startNode) return false;
    const items = (sec.reveal || []).map((sel) => ({ el: document.querySelector(sel), node: findNode(geometry, sel) })).filter((x) => x.el);
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
    if (roleFor !== geoVersion) {
      roleFor = geoVersion; roles = new Map();
      for (const sec of SECTIONS) {
        const st = findNode(geometry, sec.start);
        if (st) roles.set(st.id, { sec });
        for (const sel of sec.reveal || []) { const nd = findNode(geometry, sel), el = document.querySelector(sel); if (nd && el) roles.set(nd.id, { el }); }
      }
    }
    const role = roles.get(id);
    if (!role) return true;
    return role.el ? !!role.el.dataset.pcbShown : role.sec.state !== 'idle';
  }
  // A scroll section starts once the light has actually reached its start element -- along the real cable path (see buildChain's
  // reachAt), not just whenever the line's y happens to coincide with it, which could fire while the light is still elsewhere on
  // a cable that only later swings down to that y. Falls back to the old y check for a start element that isn't on the chain at
  // all (so it also still works when the page opens part-way down, before a chain even exists to compare progress against).
  function checkScrollSections(yc) {
    for (const sec of SECTIONS) {
      if (sec.trigger !== 'scroll' || sec.state !== 'idle' || !geometry) continue;
      const n = findNode(geometry, sec.start);
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
  // Cumulative arc length along a spine's own points (index i -> distance travelled from spine[0] to spine[i]) -- the exact
  // per-step path layStrip actually walked, so length/position/direction read off it need no reconstruction or averaging.
  function spineCum(spine) {
    const cum = [0];
    for (let i = 1; i < spine.length; i++) cum.push(cum[i - 1] + Math.hypot(spine[i].x - spine[i - 1].x, spine[i].y - spine[i - 1].y));
    return cum;
  }
  function buildChain() {
    chain = []; chainTotal = 0; reachAt = new Map();
    if (!geometry || !net) { chainFor = geoVersion; return; }
    let prevEnd = null, prevComp = null;
    for (const [ea, eb] of resolveLinks()) {
      const na = findNode(geometry, ea), nb = findNode(geometry, eb);
      const key = na && nb && na.id + '>' + nb.id, meta = key && net.cableMeta.get(key);
      const spine = key && geometry.linkSpines.get(key);
      if (!meta || !spine) { prevEnd = null; prevComp = null; continue; }
      if (!reachAt.has(na.id)) reachAt.set(na.id, chainTotal);       // the progress at which the light actually gets here -- not
      const cum = spineCum(spine), len = cum[cum.length - 1];        // wherever its y happens to coincide with the component's own
      const startPt = spine[0];
      if (prevEnd && prevComp === na.id) {                          // this cable leaves the same component the last one arrived at
        // Charged by its VERTICAL span, not the full diagonal distance between where the cable arrived and where the next one
        // leaves: scroll only ever corrects towards pt.y, so a bridge that also drifts sideways (a wide card whose two cables
        // don't line up) was charging progress for x movement scrolling can't see, making it take far more scroll input than
        // the card's own height to get through -- scrolling through a big component felt like wading through honey.
        const blen = Math.max(1, Math.abs(startPt.y - prevEnd.y));
        chain.push({ bridge: true, componentId: na.id, from: prevEnd, to: startPt, cumStart: chainTotal, len: blen });
        chainTotal += blen;
      } else if (!prevEnd) {
        // The very first component has the same problem the last one does (see the tail below), the opposite way round: nothing
        // precedes it to make a bridge out of, so without this it would never register as the light being inside it either, at
        // the very start of the chain. Give it the same treatment -- its own depth, from its top edge down to where the first
        // cable actually leaves it.
        const innerStart = Math.min(na.y, startPt.y - 1);
        const inLen = startPt.y - innerStart;
        chain.push({ bridge: true, componentId: na.id, from: { x: startPt.x, y: innerStart }, to: startPt, cumStart: chainTotal, len: inLen });
        chainTotal += inLen;
      }
      chain.push({ key, meta, spine, cum, len, cumStart: chainTotal });
      chainTotal += len;
      if (!reachAt.has(nb.id)) reachAt.set(nb.id, chainTotal);
      prevEnd = spine[spine.length - 1]; prevComp = nb.id;
    }
    // Past the last cable there's nothing left to steer onto, but scrolling shouldn't stop being 1:1 with the page there -- so the
    // chain keeps going, straight down to the bottom of the page, exactly like a bridge across a component (see above): progress
    // and page y move together at the same rate, so the correction this drives is always where the page already is, not fighting it.
    // Split in two: first the rest of the LAST component's own depth (still genuinely inside it, so it can still charge/fire
    // 'pcb-power' like any other component the chain crosses -- it's the chain's final stop, not just a component it passes
    // through, so it never otherwise gets a bridge of its own), then componentId: null for the page beyond that, which isn't
    // inside anything and must never register as such no matter how far past it the page goes.
    if (prevEnd) {
      const lastNode = geometry.nodes[prevComp];
      const innerEnd = lastNode ? Math.max(prevEnd.y + 1, lastNode.y + lastNode.h) : prevEnd.y + 1;
      const innerLen = innerEnd - prevEnd.y;
      chain.push({ bridge: true, componentId: prevComp, from: prevEnd, to: { x: prevEnd.x, y: innerEnd }, cumStart: chainTotal, len: innerLen });
      chainTotal += innerLen;
      const bottom = Math.max(innerEnd + 1, geometry.height);
      const tailLen = bottom - innerEnd;
      chain.push({ bridge: true, componentId: null, from: { x: prevEnd.x, y: innerEnd }, to: { x: prevEnd.x, y: bottom }, cumStart: chainTotal, len: tailLen });
      chainTotal += tailLen;
    }
    chainFor = geoVersion;
  }
  // the point at arc-length distance s along the chain: { bridge, seg, cells, x, y } (cells/seg only for a wire segment). cells are
  // found by physical proximity to (x, y), not by carrying a fraction across into net's own step numbering: net.stepCells is built
  // by resampling each lane's already-simplified path to a shared, per-BUNDLE mean length (so a bundle's wires glow evenly despite an
  // outer wire physically running further round a turn -- see buildNet) -- a completely different, independently-paced measurement
  // of "how far along" from the spine's real, per-construction-step arc length above. Carrying one system's fraction into the other's
  // index was exactly the bug (a turn is proportionally longer in net's pacing than in the spine's, so the borrowed index landed on
  // the wrong cross-section right around every turn). Asking "which real cells are actually here" sidesteps that mismatch entirely.
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
    // Walk the exact spine: find which construction step `local` falls in, then interpolate on that one step's own straight
    // segment. Every step is either axis-aligned (a straight move) or one 45 degree chord (a whole turn, see layStrip) -- so
    // there is nothing to reconstruct or average, the position is exactly what the walk did at that point. cum is sorted, so a
    // binary search finds the step in O(log steps) instead of walking every one of them -- the spine can run to hundreds of
    // points on a long cable now that a turn is resolved tick by tick (see layStrip), and this runs every frame while scrolling.
    const { spine, cum } = seg;
    let lo = 1, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < local) lo = mid + 1; else hi = mid; }
    const i = lo;
    const segLen = cum[i] - cum[i - 1], t = segLen ? (local - cum[i - 1]) / segLen : 0;
    const p0 = spine[i - 1], p1 = spine[i];
    const x = p0.x + (p1.x - p0.x) * t, y = p0.y + (p1.y - p0.y) * t;
    const cells = nearestStepCells(seg.key, x, y, seg.len ? local / seg.len : 0);
    return { bridge: false, seg, cells, x, y };
  }
  // The true, physical cross-section at (x, y): each wire of the bundle picks its OWN nearest point independently, rather than
  // finding whichever single node is closest and borrowing its entire step group. net.stepCells groups nodes by a SHARED step
  // index across every wire, but that index is assigned by resampling each wire's own (independently simplified) path to an
  // even fraction of the bundle's mean length -- near a turn, an inner and outer wire cover very different physical ground for
  // the "same" step, so a borrowed group can mix wires that are still mid-turn with ones already straight, drawing a diagonal
  // streak across what should be a clean line. Every wire's own steps are still a real, correctly-ordered path along that one
  // wire, though (see buildNet: stepCells[j][k] is lane k's own node at step j, so column k across every j IS lane k's path) --
  // so asking each wire separately "which of your own points is closest to here" always lands on that wire's true position.
  // `frac` (this cable's own fraction of the way along, from the exact spine) is a good starting guess for which net step that
  // is -- the two systems' pacing only really disagrees within a turn's smear (see chainPointAt), never by the whole cable -- so
  // rather than scanning every step for every wire each frame, each wire searches a bounded window around that guess.
  let stepCellsCacheKey = null, stepCellsCache = null;
  function nearestStepCells(key, x, y, frac) {
    const groups = net.stepCells.get(key), n = groups.length, w = groups[0].length;
    const j0 = Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
    // scrolling advances by a few px per event -- consecutive calls very often land on the same starting step, so the last
    // result is reused rather than re-searching for it (the small window search below is still cheap even on a cache miss).
    const cacheKey = key + ':' + j0;
    if (cacheKey === stepCellsCacheKey) return stepCellsCache;
    const cells = new Array(w);
    const win = Math.min(n - 1, Math.max(20, w * 2));
    const lo = Math.max(0, j0 - win), hi = Math.min(n - 1, j0 + win);
    for (let k = 0; k < w; k++) {
      let best = groups[lo][k], bestD = Infinity;
      for (let j = lo; j <= hi; j++) {
        const c = groups[j][k], dx = net.x[c] - x, dy = net.y[c] - y, d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = c; }
      }
      cells[k] = best;
    }
    stepCellsCacheKey = cacheKey; stepCellsCache = cells;
    return cells;
  }
  // re-sync progress to wherever on the (possibly just-rebuilt) chain sits closest to a given page y -- so a rebuild (resize, fonts
  // arriving) doesn't reset progress to the start, and the very first scroll event has something sensible to correct from.
  function chainProgressForY(targetY) {
    if (!chain || !chain.length) return 0;
    let best = 0, bestDist = Infinity;
    for (const seg of chain) {
      const pts = seg.bridge ? [seg.from, seg.to] : seg.spine;
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
    if (chainFor !== geoVersion) buildChain();
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
    if (steer(e.deltaY)) { e.preventDefault(); checkScrollSections(lineY()); ensureRegion(); if (!raf) raf = requestAnimationFrame(frame); }
  }
  function onLineScroll() {
    if (correctingTarget != null && Math.abs(window.scrollY - correctingTarget) < 1) {
      correctingTarget = null; pwLastRawY = window.scrollY; checkScrollSections(lineY()); ensureRegion(); if (!raf) raf = requestAnimationFrame(frame); return;
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
    if (!raf) raf = requestAnimationFrame(frame);
  }

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
    glow = document.createElementNS(SVGNS, 'svg');
    glow.id = 'pcb-board-glow';
    glow.setAttribute('aria-hidden', 'true');
    document.body.prepend(glow);
    document.body.prepend(svg);
    canvas = document.createElement('canvas');
    canvas.id = 'pcb-pulse';
    canvas.setAttribute('aria-hidden', 'true');
    glow.after(canvas);
    if (LINE.enabled && !mm.matches) {
      window.addEventListener('scroll', onLineScroll, { passive: true });
      window.addEventListener('wheel', onWheel, { passive: false });   // not passive: steering needs to be able to preventDefault it
    }
    ctx = canvas.getContext('2d');
    canvas.style.opacity = String(PULSE.layerOpacity);   // constant: switching it while a pulse starts/ends made everything else on the layer jump
    sizeCanvas();
    window.addEventListener('resize', sizeCanvas, { passive: true });
    document.addEventListener('pointerover', onPointerOver, { passive: true });
    document.addEventListener('click', onPowerClick, { passive: true });
    paint();
    startSections();
    window.addEventListener('resize', relayout, { passive: true });
    window.addEventListener('load', relayout);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);
    if ('ResizeObserver' in window) new ResizeObserver(relayout).observe(document.body);
    document.querySelectorAll('img').forEach((im) => { if (!im.complete) im.addEventListener('load', relayout, { once: true }); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  // public API: PCBBoard.pulse(target, opts) lights the traces up starting at a component.
  //   target: a DOM element, a CSS selector, or a node id (see PCBBoard.nodes())
  //   opts:   { hops, speed, tail, hopDelay, flash, color, width, alpha, reveal, revealSize, persist, fadeOut } -- see
  //           PULSE above (it spreads through
  //           every chip it reaches unless you cap it with `hops`)
  api.pulse = pulse;
  api.active = () => pulses.size;   // how many pulses are running right now
  api.powerState = () => ({ max: net ? net.max : 0, cells: net ? net.n : 0 });
  api.powerNode = powerNode;
  api.prof = PROF;
  api.paintLog = () => paintLog;   // debug: every full board (re)build this load, when it happened and how long it took
  api.activated = (id) => activated(id);   // has the light reached this component yet? (see activated)
  api.chargeOf = (id) => (charge.get(id) || { q: 0 }).q;   // debug: an element's own stored charge right now (see CAP)
  api.chainDebug = () => {
    const point = chain && chainPointAt(chainProgress);
    const cellPts = point && !point.bridge ? point.cells.map((c) => ({ x: net.x[c], y: net.y[c], p: net.p[c] })) : null;
    return { total: chainTotal, progress: chainProgress, segments: chain ? chain.length : 0, point, cellPts, netMax: net.max };
  };
  api.setChainProgress = (s) => {                          // debug: force a point of progress and correct the viewport to it, like a real scroll would
    if (!chain || !chain.length) return null;
    chainProgress = Math.max(0, Math.min(chainTotal, s));
    const pt = chainPointAt(chainProgress);
    if (pt) { const t = Math.max(0, pt.y - window.innerHeight / 2); correctingTarget = t; window.scrollTo({ top: t, left: 0, behavior: 'instant' }); }
    return pt;
  };
  api.mediaDriven = !mm.matches;   // whether the page's videos follow the line (off for reduced motion, where the effects are skipped)
  api.geometry = () => geometry;
  api.nodes = () => (geometry ? geometry.nodes.map((n, i) => ({ id: i, kind: n.kind, tag: n.tag, el: n.el || null, x: n.x, y: n.y, w: n.w, h: n.h })) : []);
  window.PCBBoard = api;
})();
