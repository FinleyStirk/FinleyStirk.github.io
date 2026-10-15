// Generative PCB page background, part 1 of 3: the board generator.
//
// Every substantial page element (headings, paragraphs, the photo, the project cards) is treated as a
// component sitting on the board. Strips of parallel wires grow out of each component's four faces by a
// random walk on an occupancy grid, ending in new chip-like components (which do the same, breadth-first)
// or, for single leftover nubs, in vias. Small exposed pads are scattered last, into whatever space that
// growth left over. The page's own elements are drawn by the page itself; this only builds the board behind.
//
// Pure: no DOM. generate() turns element rectangles into board geometry and toSvg() draws it; pcb-board.js
// (the runtime, loaded after this) does everything in the browser.
(() => {
  'use strict';

  // ---- tuning (sizes in grid cells unless noted) ---------------------------
  const CFG = {
    cell: 2,                    // px per grid cell = wire pitch. Overridden per page by gridCell() (from gridCols below); grows past that only on huge pages, see cellFor
    gridCols: 720,              // cells across the board -- fixed whatever the window width, so the board looks the same on every screen (a longer page just gets more rows)
    gridColsNarrow: 360,        // cells across on a board no wider than narrowWidth (phones)
    narrowWidth: 700,           // px: matches style.css's phone breakpoint, so the board and the layout switch together
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
    dimpleChance: 0.6,          // chance a chip has a pin-1 dimple at all (in a random one of its four corners)
    maxBoardWidth: Infinity,    // px: the board is built over a strip at most this wide, centred; on a wider page the left and right edges of that strip act as hard edges (wires stop there) and the sides stay plain dark. Off: the board fills the whole window at any zoom, and since cells are sized from the whole page width (see gridCell) every screenful is the same gridCols-wide grid
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
  // step cuts across. Returns { first (the new band's lowest cell), d, swapped, steps } or null.
  // A turn isn't one atomic move: the outer lane needs w diagonal steps to sweep clear of the inner ones, the inner lane just
  // one, so it runs as w ticks, each moving every lane that still has steps left one cell diagonally (a lane that's done stays
  // put). steps[t] is where every lane is after tick t+1 -- [c, r] per lane, in the band's order from before the turn -- i.e. the
  // cable's exact cross-section at each tick, swinging round the inner corner like a hinge.
  function turnMacro(c, r, d, side, w, hit, hitCorner) {
    const [fc, fr] = DIRV[d];
    const [nfc, nfr] = side === 1 ? [-fr, fc] : [fr, -fc];
    const laneAxis = fc === 0 ? [1, 0] : [0, 1];
    const leaningHigh = laneAxis[0] * nfc + laneAxis[1] * nfr > 0;
    const trial = bandCells(c, r, d, w);
    const steps = [];
    for (let t = 1; t <= w; t++) {
      for (let i = 0; i < w; i++) {
        if (t > (leaningHigh ? w - i : i + 1)) continue;
        const [cc, rr] = trial[i];
        const nc = cc + fc + nfc, nr = rr + fr + nfr;
        if (hit(nc, nr) || hitCorner(nc, rr) || hitCorner(cc, nr)) return null;
        trial[i] = [nc, nr];
      }
      steps.push(trial.slice());
    }
    const nd = DIRV.findIndex(([a, b]) => a === nfc && b === nfr);
    const coord = nfr !== 0 ? (x) => x[0] : (x) => x[1];       // the lane axis once the strip has turned
    const swapped = coord(trial[0]) > coord(trial[w - 1]);
    return { first: swapped ? trial[w - 1] : trial[0], d: nd, swapped, steps };
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
    // Two components side by side (a sideways face, and their heights overlap by at least the cable's width): leave from the exact
    // middle of the facing side instead of a random spot. Run straight across, the cable then meets the other's middle too (cards
    // in one row are the same height), so the scroll light crosses between them at their middle -- never pulling the page up or
    // down as it passes from one to the other.
    if (face % 2 === 1 && Math.min(ar1, br1) - Math.max(ar0, br0) + 1 >= w) {
      const mid = Math.max(f0, Math.min(f1, Math.round(acy - (w - 1) / 2)));
      seeded = seedFace(face, mid, mid);
    }
    if (!seeded && f1 >= f0) for (let attempt = 0; attempt < 5 && !seeded; attempt++) { const c = f0 + Math.floor(rng() * (f1 - f0 + 1)); seeded = seedFace(face, c, c); }
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

  // The rungs through a 90 degree turn, as a hinge. path[k] is lane k's points through the turn, from where it stood as the turn began
  // (on the cross-section line the cable had then) to where it ends up (on the new one). Those two lines meet at the turn's inner
  // corner: the pivot. A ray from it sweeps from the old cross-section to the new one over w steps, and each step's rung is, for every
  // lane, its point nearest that ray -- so the cross-section rotates about the corner, and halfway round it is square across the
  // diagonal part of the turn. Each lane's points run steadily round the pivot, so its pick only ever moves forward.
  function hingeRungs(path, oldD, newD) {
    const [ox, oy] = DIRV[oldD], [nx, ny] = DIRV[newD];
    const first = path[0][0], last = path[0][path[0].length - 1];
    const px = ox !== 0 ? first.x : last.x, py = ox !== 0 ? last.y : first.y;   // where the old and new cross-sections meet
    // 0 = pointing along the old cross-section (towards the outer lanes), pi/2 = along the new one
    const angle = (pt) => Math.atan2((pt.x - px) * ox + (pt.y - py) * oy, -((pt.x - px) * nx + (pt.y - py) * ny));
    const angles = path.map((pts) => pts.map(angle));
    const w = path.length, out = [];
    for (let n = 1; n <= w; n++) {
      const th = (Math.PI / 2) * n / w;
      out.push(path.map((pts, k) => {
        let best = 0;
        for (let i = 1; i < pts.length; i++) if (Math.abs(angles[k][i] - th) < Math.abs(angles[k][best] - th)) best = i;
        return pts[best];
      }));
    }
    return out;
  }

  // Lays a routed strip down: marks the grid, builds the lanes and the rungs. own cells are counted by count() (so a strip can't run
  // into itself) but not for the diagonal corner-cut test. Returns { lanes, startD, endD } or null (nothing left marked).
  function layStrip(G, A, B, w, route, count) {
    const { cols, rows, cell, blocked } = G;
    const own = new Set();
    const mark = (c, r) => { blocked[c * rows + r]++; own.add(c * rows + r); };
    const release = () => { for (const k of own) blocked[k]--; };
    const hit = (c, r) => c < 0 || c >= cols || r < 0 || r >= rows || count(c, r) > 0;
    const other = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows && count(c, r) - (own.has(c * rows + r) ? 1 : 0) > 0;
    const centerOf = (c, r) => ({ x: c * cell + cell / 2, y: r * cell + cell / 2 });
    // RUNGS: the cable's cross-section at every step along it, in order -- rung[k] is lane k's point there (the same object as in
    // the lane, until simplify drops it). A straight step moves every lane one cell; through a turn the rungs rotate about the
    // turn's inner corner like a hinge (see hingeRungs), so a lane near that corner appears in several rungs in a row.
    const rungs = [];
    let lanes = Array.from({ length: w }, () => []);
    let laneOrder = Array.from({ length: w }, (_, i) => i);
    let { c, r, d } = route.start;
    const startD = d;
    const place = (cells) => {
      if (cells.some(([x, y]) => hit(x, y))) return false;
      const rung = new Array(w);
      for (let k = 0; k < w; k++) {
        mark(cells[k][0], cells[k][1]);
        const p = centerOf(cells[k][0], cells[k][1]);
        lanes[laneOrder[k]].push(p); rung[laneOrder[k]] = p;
      }
      rungs.push(rung);
      return true;
    };
    if (!place(bandCells(c, r, d, w))) { release(); return null; }
    for (const op of route.ops) {
      if (op.t === 'S') {
        c += DIRV[d][0]; r += DIRV[d][1];
        if (!place(bandCells(c, r, d, w))) { release(); return null; }
      } else {
        const m = turnMacro(c, r, d, op.side, w, hit, other);
        if (!m) { release(); return null; }
        const path = rungs[rungs.length - 1].map((pt) => [pt]);   // per lane: its points through the turn, in order
        let prev = bandCells(c, r, d, w);
        for (const cells of m.steps) {
          for (let k = 0; k < w; k++) {
            const [nc, nr] = cells[k];
            if (nc === prev[k][0] && nr === prev[k][1]) continue;   // this lane has finished turning
            mark(nc, nr);
            const pt = centerOf(nc, nr);
            lanes[laneOrder[k]].push(pt); path[laneOrder[k]].push(pt);
          }
          prev = cells;
        }
        rungs.push(...hingeRungs(path, d, m.d));
        if (m.swapped) laneOrder = laneOrder.slice().reverse();
        c = m.first[0]; r = m.first[1]; d = m.d;
      }
    }
    lanes = lanes.map(simplify);
    const startEdge = { 0: A.y, 1: A.x + A.w, 2: A.y + A.h, 3: A.x }[startD];
    const [fc, fr] = DIRV[d];
    for (const lane of lanes) {
      lane.unshift(startD % 2 === 0 ? { x: lane[0].x, y: startEdge } : { x: startEdge, y: lane[0].y });
      const last = lane[lane.length - 1];
      lane.push(fc !== 0 ? { x: fc > 0 ? B.x : B.x + B.w, y: last.y } : { x: last.x, y: fr > 0 ? B.y : B.y + B.h });
    }
    // the cable starts and ends exactly on the two components' edges: one more rung at each end, made of the lanes' end points
    rungs.unshift(lanes.map((l) => l[0]));
    rungs.push(lanes.map((l) => l[l.length - 1]));
    return { lanes, rungs, startD, endD: d, endAnchor: [c, r] };
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
    return Math.max(c.cell, Math.ceil(Math.sqrt((width * height) / c.maxGridCells) * 64) / 64);   // multiples of 1/64 px, like gridCell
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
    // the hand-written cables, one entry per cfg.links entry in the same order (null where it couldn't be routed):
    // { from, to (node ids), lanes, rungs (see layStrip) } -- the path the scroll light follows (pcb-scroll.js)
    const cables = [];
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
      cables.push(null);
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
        const cable = { from: A.id, to: B.id, lanes: laid.lanes, rungs: laid.rungs };
        for (const l of laid.lanes) l.cable = cable;   // (a pulse only runs along a cable when it's asked to -- see schedulePulse)
        cables[cables.length - 1] = cable;
        stripLanes.push(...laid.lanes);
        record(laid.lanes, A.id, B.id);
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

    // Pads go down last, after every real component's own walk has had first claim on the space (so where chance drops a pad
    // never changes how many chips grow). makePads checks the grid itself, so a pad only lands on space nothing has claimed.
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
    const result = { width, height: height + inset, cell, comps, nodes, srcLanes, obstacles, pads, chips, pageChips, stripLanes, viaLanes, vias, cols, rows, blocked, cables };
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
    for (const cable of g.cables) if (cable) for (const rung of cable.rungs) rung.forEach(move);
  }

  // ---- drawing (SVG strings) -------------------------------------------------
  // black and white: white copper on the dark grey page -- chip bodies stay dark so text on them is readable, the metal is white
  const STYLE = {
    trace: '#d9d9d9', via: '#e6e6e6', pad: '#f2f2f2', body: '#333333', bodyEdge: '#bdbdbd',
    bevelLight: '#9a9a9a', bevelDark: '#0d0d0d', dimple: '#0a0a0a', pin: '#cfcfcf',
  };
  const f = (v) => Math.round(v * 10) / 10;

  function toSvg(g, grainHref) {
    const S = STYLE;
    const cell = g.cell, pinW = cell * 0.5, pinLen = cell * 0.8;
    const d = [];
    // one path per layer -- a few dozen DOM nodes instead of thousands
    const polyline = (pts) => 'M' + pts.map((p) => `${f(p.x)} ${f(p.y)}`).join('L');
    const traces = g.stripLanes.concat(g.viaLanes).filter((l) => l.length > 1).map(polyline).join('');

    const leads = [], bodies = [], bevelL = [], bevelD = [], dimples = [];
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
      bodies.push(rectD(c.x, c.y, c.w, c.h));
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
    if (grainHref) d.push(`<path d="${bodies.join('')}" fill="url(#pcb-grain)"/>`);
    d.push(`<path d="${bevelL.join('')}" fill="none" stroke="${S.bevelLight}" stroke-width="${f(cell * 0.3)}"/>`);
    d.push(`<path d="${bevelD.join('')}" fill="none" stroke="${S.bevelDark}" stroke-width="${f(cell * 0.3)}"/>`);
    d.push(`<path d="${dimples.join('')}" fill="${S.dimple}" stroke="${S.bevelLight}" stroke-width="${f(cell * 0.12)}"/>`);
    d.push(`<path d="${padD}" fill="${S.pad}"/>`);
    d.push(`<path d="${viaD}" fill="var(--bg, #161616)" stroke="${S.via}" stroke-width="${f(cell * 0.15)}"/>`);
    d.push('</g>');
    const defs = grainHref
      ? `<defs><pattern id="pcb-grain" width="64" height="64" patternUnits="userSpaceOnUse"><image href="${grainHref}" width="64" height="64"/></pattern></defs>`
      : '';
    return defs + d.join('');
  }

  // ---- for the page's power field (pcb-board.js): kept here, with no page code in them, so the board worker can run them too ----
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

  // The power network: every trace cut into cells S px apart (see FLOW in pcb-board.js), each chip a hub cell linked to the ends of
  // every trace touching it, plus a cell per wire per kept rung of each hand-written cable. Cells sorted by y for the drawing code.
  function buildNet(g, S) {
    const nNodes = g.nodes.length, xs = [], ys = [], nxt = [], ws = [], edges = [], viaCell = new Int32Array(g.vias.length).fill(-1);
    for (const nd of g.nodes) { xs.push(nd.x + nd.w / 2); ys.push(nd.y + nd.h / 2); nxt.push(-1); ws.push(1); }
    // Every wire of a bundle (the wires of one strip, which share their two ends) gets the SAME number of cells, from the bundle's
    // mean length. Power fades per cell, so wires that run side by side then carry the same power at the same place -- instead of the outer
    // wire of a turn (which is physically longer) being dimmer all the way along. (Hand-written cables are built from their rungs instead.)
    const bundleLen = new Map();
    for (const lane of g.stripLanes) {
      if (lane.length < 2 || lane.dst < 0 || lane.cable) continue;
      laneMetrics(lane);
      const b = bundleLen.get(lane.src + '>' + lane.dst) || bundleLen.set(lane.src + '>' + lane.dst, { sum: 0, count: 0 }).get(lane.src + '>' + lane.dst);
      b.sum += lane.len; b.count++;
    }
    for (const set of [g.stripLanes, g.viaLanes]) for (let li = 0; li < set.length; li++) {
      const lane = set[li];
      if (lane.length < 2 || lane.cable) continue;
      laneMetrics(lane);
      const bl = set === g.stripLanes && lane.dst >= 0 ? bundleLen.get(lane.src + '>' + lane.dst) : null;
      const len = bl ? bl.sum / bl.count : lane.len;
      const n = Math.max(2, Math.round(len / S) + 1), base = xs.length, w = 1 / Math.pow(lane.gsize || 1, 0.65);
      let seg = 1;
      for (let j = 0; j < n; j++) {
        const s = (lane.len * j) / (n - 1);
        while (seg < lane.length - 1 && lane.cum[seg] < s) seg++;
        const s0 = lane.cum[seg - 1], s1 = lane.cum[seg], t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
        xs.push(lane[seg - 1].x + (lane[seg].x - lane[seg - 1].x) * t);
        ys.push(lane[seg - 1].y + (lane[seg].y - lane[seg - 1].y) * t);
        nxt.push(j < n - 1 ? base + j + 1 : -1); ws.push(w);
        if (j) edges.push(base + j - 1, base + j);
      }
      if (set === g.viaLanes) viaCell[li] = base + n - 1;         // a via sits at the end of its wire
      if (lane.src >= 0 && lane.src < nNodes) edges.push(lane.src, base);
      if (lane.dst >= 0 && lane.dst < nNodes) edges.push(lane.dst, base + n - 1);
    }
    // A hand-written cable's cells come straight from its rungs (see layStrip): a rung kept every ~S px along the cable's centre
    // line becomes one cell per wire, so each kept rung is a true cross-section of cells -- through a turn too, where it swings
    // round the inner corner. A wire holding still through a turn tick keeps its cell rather than getting a second one in the same
    // place. rungCells[j] (per cable) is the cells of the kept rung nearest rung j: what the scroll light powers when it's there.
    const rungCells = g.cables.map((cable) => {
      if (!cable) return null;
      const R = cable.rungs, w = R[0].length, wt = 1 / Math.pow(w, 0.65);
      const at = R.map((rung) => rung.reduce((s, p) => s + p.x, 0) / w), atY = R.map((rung) => rung.reduce((s, p) => s + p.y, 0) / w);
      const lastId = new Array(w).fill(-1), lastPt = new Array(w).fill(null), kept = [];
      let dist = 0, since = Infinity;
      for (let j = 0; j < R.length; j++) {
        if (j) { const d = Math.hypot(at[j] - at[j - 1], atY[j] - atY[j - 1]); dist += d; since += d; }
        if (since < S && j < R.length - 1) continue;
        since = 0;
        const ids = new Array(w);
        for (let k = 0; k < w; k++) {
          const p = R[j][k];
          if (p === lastPt[k]) { ids[k] = lastId[k]; continue; }
          const id = xs.length;
          xs.push(p.x); ys.push(p.y); nxt.push(-1); ws.push(wt);
          if (lastId[k] >= 0) { nxt[lastId[k]] = id; edges.push(lastId[k], id); } else edges.push(cable.from, id);
          lastId[k] = id; lastPt[k] = p; ids[k] = id;
        }
        kept.push({ dist, ids });
      }
      for (let k = 0; k < w; k++) edges.push(cable.to, lastId[k]);
      const out = new Array(R.length);
      dist = 0;
      for (let j = 0, ki = 0; j < R.length; j++) {
        if (j) dist += Math.hypot(at[j] - at[j - 1], atY[j] - atY[j - 1]);
        while (ki + 1 < kept.length && Math.abs(kept[ki + 1].dist - dist) <= Math.abs(kept[ki].dist - dist)) ki++;
        out[j] = kept[ki].ids;
      }
      return out;
    });
    const N = xs.length, start = new Int32Array(N + 1);
    for (let e = 0; e < edges.length; e++) start[edges[e] + 1]++;
    for (let i = 0; i < N; i++) start[i + 1] += start[i];
    const adj = new Int32Array(edges.length), fill = start.slice(0, N);
    for (let e = 0; e < edges.length; e += 2) { adj[fill[edges[e]]++] = edges[e + 1]; adj[fill[edges[e + 1]]++] = edges[e]; }
    const order = Int32Array.from({ length: N - nNodes }, (_, i) => i + nNodes).sort((a, b) => ys[a] - ys[b]);
    const sortedY = Float32Array.from(order, (i) => ys[i]);
    return { n: N, hubs: nNodes, x: Float32Array.from(xs), y: Float32Array.from(ys), nxt: Int32Array.from(nxt), w: Float32Array.from(ws),
      start, adj, order, sortedY, viaCell, rungCells, p: new Float32Array(N), max: 0 };
  }

  self.PCBGen = { CFG, generate, toSvg, mulberry32, laneMetrics, buildNet };   // `self`: the page (window) or the board worker (pcb-worker.js)
})();
