// Generative PCB page background -- a port of python_pcb_test/{my_code,nub_via_demo}.py.
//
// Every substantial page element (headings, paragraphs, the photo, the project cards) is treated as a
// component sitting on the board. Strips of parallel wires grow out of each component's four faces by a
// random walk on an occupancy grid, ending in new chip-like components (which do the same, breadth-first)
// or, for single leftover nubs, in vias. Small exposed pads are scattered first, so everything routes
// around them. The page's own elements are drawn by the page itself; this only paints the board behind.
//
// Everything below the "geometry" section is pure (no DOM) so it can be tested in Node.
(() => {
  'use strict';

  // ---- tuning (sizes in grid cells unless noted) ---------------------------
  const CFG = {
    cell: 4,                    // px per grid cell = wire pitch (at minimum; grows on very large pages, see cellFor)
    maxGridCells: 350000,       // budget: cells are enlarged so the grid never exceeds this, keeping generation time flat
    minWires: 2, maxWires: 25,  // wires per strip
    compMin: 6, compMax: 50,    // destination component side, in cells
    compRatio: [1.2, 2.0],      // destination side as a multiple of the strip feeding it
    clearance: 5,               // keepout margin around every component
    maxStripsPerFace: 3, extraStripChance: 0.6, stripGap: 2,
    maxBackups: 200,            // retreats a blocked strip may make
    shuffleVias: true,          // start a face's via walks in random order, not nub by nub (in order, neighbours settle into repeating patterns)
    viaBackups: 0,              // via walks stay greedy (retreat makes them steal each other's lanes)
    padSizes: [2, 3], padClearance: 2, padLeadChance: 0.7, padClustersPer120k: 40,
    litKinds: ['text', 'card'],   // which page elements give off light ([] turns the lighting off)
    lightReach: 20,             // how far that light reaches, in cells
    // how strongly each element glows (0-1): headings by level so bigger = brighter, then by kind
    lightLevels: { H1: 1, H2: 0.75, H3: 0.55, H4: 0.4, H5: 0.3, H6: 0.3, text: 0.3, card: 0.5 },
    lightDecay: 8.8,            // how fast it fades with distance: 1 = evenly, higher = bright near the box, gone quickly
    dimpleChance: 0.6,          // chance a chip has a pin-1 dimple at all (in a random one of its four corners)
    textPad: 12,                // px of extra room between a text block and its first wire (not scaled with the cell)
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
    const componentBox = (p, a) => {
      const band = bandAt(p, a);
      let cx = 0, cy = 0;
      for (const [c, r] of band) { const q = centerOf(c, r); cx += q.x; cy += q.y; }
      cx /= width; cy /= width;
      if (fc !== 0) return [fc > 0 ? (a + 1) * cell : a * cell - newSize, Math.round((cy - half) / cell) * cell];
      return [Math.round((cx - half) / cell) * cell, fr > 0 ? (a + 1) * cell : a * cell - newSize];
    };
    const boxFits = (fx, fy) => {
      if (fx < 0 || fy < 0 || fx + newSize > cols * cell || fy + newSize > rows * cell) return false;
      if (boxCells(fx, fy, newSize, newSize, 0).some((k) => isBlocked((k / rows) | 0, k % rows))) return false;
      // the keepout margin must clear everything except this cable's own cells (it plugs into this component)
      return !boxCells(fx, fy, newSize, newSize, clearance)
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
    fx = Math.max(0, Math.min(fx, cols * cell - newSize));
    fy = Math.max(0, Math.min(fy, rows * cell - newSize));
    const placed = { x: fx, y: fy, w: newSize, h: newSize };
    for (const k of boxCells(fx, fy, newSize, newSize, clearance)) blocked[k]++;

    const edgeX = fc !== 0 ? (fc > 0 ? fx : fx + newSize) : null;
    const edgeY = fc === 0 ? (fr > 0 ? fy : fy + newSize) : null;
    lanes = lanes.map(simplify);
    for (const lane of lanes) {
      if (!lane.length) continue;
      lane.unshift(startTouch(lane[0]));
      const last = lane[lane.length - 1];
      lane.push(edgeX !== null ? { x: edgeX, y: last.y } : { x: last.x, y: edgeY });
    }
    return { lanes, comp: placed, via: null };
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

  // Small square exposed pads in clusters (single, row, column, 2x2) -- put down first so cables route around.
  function makePads(rng, G, elements, cfg) {
    const { cols, rows, cell } = G;
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
    return Math.max(c.cell, Math.ceil(Math.sqrt((width * height) / c.maxGridCells)));
  }

  // elements: [{x, y, w, h, kind}] in page pixels. Returns everything needed to draw the board.
  function generate(elements, width, height, seed, overrides) {
    const cfg = Object.assign({}, CFG, overrides);
    if (!overrides || overrides.cell === undefined) cfg.cell = cellFor(width, height, cfg);
    const rng = mulberry32(seed);
    const G = makeGrid(width, height, cfg.cell);
    const { cell, cols, rows, blocked, boxCells } = G;

    // A 'round' element (the photo, the social icons) only blocks the grid -- its circle plus the usual margin:
    // everything routes around it, but it isn't a component, so no chip behind it and nothing grows out of it.
    const obstacles = elements.filter((e) => e.kind === 'round');
    elements = elements.filter((e) => e.kind !== 'round');

    // page elements become components, snapped OUTWARD to the grid (a wire needs a whole number of cells to sit on)
    const comps = elements.map((e) => {
      const pad = e.kind === 'text' ? cfg.textPad : 0;
      const x0 = Math.floor((e.x - pad) / cell) * cell, y0 = Math.floor((e.y - pad) / cell) * cell;
      const x1 = Math.ceil((e.x + e.w + pad) / cell) * cell, y1 = Math.ceil((e.y + e.h + pad) / cell) * cell;
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, kind: e.kind, tag: e.tag };
    });
    const pads = makePads(rng, G, comps.concat(obstacles), cfg);
    for (const c of comps.concat(pads))
      for (const k of boxCells(c.x, c.y, c.w, c.h, c.clearance === undefined ? cfg.clearance : c.clearance)) blocked[k]++;
    for (const o of obstacles)
      for (const k of G.circleCells(o.x + o.w / 2, o.y + o.h / 2, Math.min(o.w, o.h) / 2, cfg.clearance)) blocked[k]++;

    const stripLanes = [], viaLanes = [], vias = [], chips = [];
    let edgeStrips = 0;
    const queue = comps.slice();
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi];
      for (const direction of shuffle(rng, ['N', 'E', 'S', 'W'])) {
        const faceSpan = Math.round((direction === 'N' || direction === 'S' ? cur.w : cur.h) / cell);
        const covered = new Set();      // nubs used by a strip that actually grew
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
          const res = growCable(G, rng, cur, direction, {
            turnChance: 0.02, bias: 0.9, turn90Chance: 0.02, maxTurns90: 1, maxCells: 98, minCells: 40,
            width: stripWires, offset, newSize: compWires * cell, clearance: cfg.clearance,
            maxBackups: cfg.maxBackups,
          });
          if (!res.lanes.length) continue;   // scrapped -- those nubs stay free for vias or a later strip
          for (let n = offset; n < offset + stripWires; n++) covered.add(n);
          stripLanes.push(...res.lanes);
          if (res.comp) { chips.push(res.comp); queue.push(res.comp); }
          else edgeStrips++;               // ran off the board: ends at the edge, nothing to plant
        }
        // every leftover nub gets its own single-wire walk ending in a via, dropped silently if blocked
        const nubs = [];
        for (let nub = 0; nub < faceSpan; nub++) if (!covered.has(nub)) nubs.push(nub);
        if (cfg.shuffleVias) shuffle(rng, nubs);
        for (const nub of nubs) {
          const res = growCable(G, rng, cur, direction, {
            turnChance: 0.1, bias: 0.7, maxCells: randint(rng, 20, 50), minCells: 2, width: 1, offset: nub,
            endsInVia: true, clearance: cfg.clearance, maxBackups: cfg.viaBackups,
          });
          if (!res.via) continue;
          viaLanes.push(res.lanes[0]); vias.push(res.via);
        }
      }
    }

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
    }
    // decided last, so it never disturbs the routing: -1 = no dimple, else 0 TL / 1 TR / 2 BL / 3 BR
    const pageChips = comps.filter((c) => c.kind === 'text' || c.kind === 'card');
    for (const c of chips.concat(pageChips)) c.dimple = rng() < cfg.dimpleChance ? Math.floor(rng() * 4) : -1;
    const lights = pageChips.filter((c) => cfg.litKinds.includes(c.kind));
    for (const c of lights) c.light = cfg.lightLevels[c.tag] !== undefined ? cfg.lightLevels[c.tag] : (cfg.lightLevels[c.kind] || 0.5);
    return { width, height, cell, comps, obstacles, pads, chips, pageChips, lights, lightReach: cfg.lightReach * cell, lightDecay: cfg.lightDecay, edgeStrips, stripLanes, viaLanes, vias, cols, rows, blocked };
  }

  // ---- drawing (SVG strings) -------------------------------------------------
  const STYLE = {
    trace: '#1d4f86', via: '#8fbfee', pad: '#c8d1dc', body: '#1f4f94', bodyEdge: '#5b8fd0',
    bevelLight: '#5b93d6', bevelDark: '#0f2b57', dimple: '#0c2245', pin: '#86b6ea',
  };
  const GLOW = {
    trace: '#5fb0ff', via: '#cfe6ff', pad: '#eef3fa', body: '#3d78d2', bodyEdge: '#8cb9f2', pageBody: '#1d3b6e',
    bevelLight: '#8fbdf6', bevelDark: '#1a4a92', dimple: '#123566', pin: '#bcdafb',
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
    d.push(`<path d="${viaD}" fill="var(--bg, #0a192f)" stroke="${S.via}" stroke-width="${f(cell * 0.15)}"/>`);
    d.push('</g>');
    if (lit) {
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

  // ===========================================================================
  // Browser side
  // ===========================================================================
  const api = { generate, growCable, makeGrid, toSvg, CFG, mulberry32 };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  if (typeof document === 'undefined') return;

  const SVGNS = 'http://www.w3.org/2000/svg';
  let svg = null, glow = null, lastKey = '', lastSig = '';
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
      out.push({ x: r.left + sx, y: r.top + sy, w: r.width, h: r.height,
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

  function paint() {
    if (!document.body) return;
    const width = document.documentElement.clientWidth;
    const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const t0 = performance.now();
    const els = collectElements();
    svg.__elements = els;   // what the board was built from (handy for checking it against the live page)
    lastSig = signature(els);
    const g = generate(els, width, height, 0x9e3779b9 + Math.round(width / 40));
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.innerHTML = toSvg(g, grainImage());
    // a brighter copy of the same board, revealed only in a halo around each light (see toSvg)
    glow.setAttribute('width', width);
    glow.setAttribute('height', height);
    glow.innerHTML = g.lights.length ? toSvg(g, null, GLOW, true) : '';   // nothing lit = nothing to draw
    lastKey = `${width}x${height}`;
    svg.dataset.stats = `cell ${g.cell}px, ${g.chips.length} chips, ${g.stripLanes.length} strip wires, ${g.viaLanes.length} via wires, ${Math.round(performance.now() - t0)}ms`;
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
    paint();
    window.addEventListener('resize', relayout, { passive: true });
    window.addEventListener('load', relayout);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);
    if ('ResizeObserver' in window) new ResizeObserver(relayout).observe(document.body);
    document.querySelectorAll('img').forEach((im) => { if (!im.complete) im.addEventListener('load', relayout, { once: true }); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.PCBBoard = api;
})();
