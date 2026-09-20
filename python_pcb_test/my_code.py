from typing import Literal
from utils import Vector2
from random import uniform, gauss, choice, random
import heapq
import math

class Stub:
    def __init__(self, pos: Vector2, component: 'Component'):
        self.pos = pos
        self.component = component     # so routing can exclude "my own body" as an obstacle
        self.connection = None


Direction = Literal['N', 'E', 'S', 'W']
class ComponentFace:
    def __init__(self, direction: Direction, start: Vector2, end: Vector2, num_stubs: int, component: 'Component'):
        self.direction = direction
        self.component = component
        self.stubs = []
        for i in range(num_stubs):
            t = (i + 1) / (num_stubs + 1)
            stub_pos = start + (t * (end - start))
            self.stubs.append(Stub(stub_pos, component))


class Component:
    def __init__(self, pos: Vector2, w, h):
        self.pos = pos
        self.w = w
        self.h = h

        top_left = self.pos
        top_right = self.pos + Vector2(self.w, 0)
        bottom_left = self.pos + Vector2(0, self.h)
        bottom_right = self.pos + Vector2(self.w, self.h)

        num_stubs = 10

        self.faces = {
            'N' : ComponentFace('N', top_left, top_right, num_stubs, self),
            'S' : ComponentFace('S', bottom_left, bottom_right, num_stubs, self),
            'W' : ComponentFace('W', top_left, bottom_left, num_stubs, self),
            'E' : ComponentFace('E', top_right, bottom_right, num_stubs, self),
        }


class Wire:
    def __init__(self, segments):
        self.segments = segments


def pair_stubs(face_a: ComponentFace, face_b: ComponentFace):
    """Match up stubs on two faces one-to-one. Order both faces' stubs
    along the axis perpendicular to the line between the faces' centres,
    then match same-rank stubs — that fans the connections out side by
    side instead of forcing wires from opposite ends of each face to
    cross, which for perpendicular faces (the common case) they otherwise
    would. Pairs are returned shortest-first, since these are routed one
    at a time with each claiming space before the next is attempted — the
    shortest, most direct pairs should go first so the harder ones fit in
    around them, not the reverse."""
    center_a = sum((s.pos for s in face_a.stubs), Vector2(0, 0)) * (1 / len(face_a.stubs))
    center_b = sum((s.pos for s in face_b.stubs), Vector2(0, 0)) * (1 / len(face_b.stubs))
    travel = center_b - center_a
    perp = Vector2(-travel.y, travel.x)

    def cross_key(stub):
        return stub.pos.x * perp.x + stub.pos.y * perp.y

    ordered_a = sorted(face_a.stubs, key=cross_key)
    ordered_b = sorted(face_b.stubs, key=cross_key)
    pairs = list(zip(ordered_a, ordered_b))
    pairs.sort(key=lambda pair: (pair[0].pos.x - pair[1].pos.x) ** 2 + (pair[0].pos.y - pair[1].pos.y) ** 2)
    return pairs


def _dist_point_to_segment(p, a, b):
    ab = b - a
    ab_len2 = ab.x * ab.x + ab.y * ab.y
    if ab_len2 == 0:
        d = p - a
        return math.hypot(d.x, d.y)
    t = max(0.0, min(1.0, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / ab_len2))
    closest = a + ab * t
    d = p - closest
    return math.hypot(d.x, d.y)


def distribute_vias(w, h, n, components=(), wires=(), clusters=None, spread=25.0, wire_clearance=1.0):
    """Scatter n via positions over a w x h board in loose clusters rather
    than uniformly at random: pick a handful of cluster centres first, then
    place each via near a randomly chosen centre (a gaussian offset with
    standard deviation `spread`), rejecting any that land off the board,
    inside one of `components` — a via sitting on top of a component is
    meaningless, and worse, routing to one legitimately has to cross that
    component's body to reach it — or within `wire_clearance` of one of
    `wires`, so a via dropped in afterwards never lands on top of a trace
    that was routed before it existed.

    `clusters` defaults to roughly one cluster per 10 vias; pass it
    explicitly for tighter/looser grouping."""
    if clusters is None:
        clusters = max(1, n // 10)
    centers = [Vector2(uniform(0, w), uniform(0, h)) for _ in range(clusters)]

    made, tries = 0, 0
    while made < n and tries < n * 30:
        tries += 1
        center = choice(centers)
        p = Vector2(center.x + gauss(0, spread), center.y + gauss(0, spread))
        if not (0 <= p.x <= w and 0 <= p.y <= h):
            continue
        if any(c.pos.x <= p.x <= c.pos.x + c.w and c.pos.y <= p.y <= c.pos.y + c.h for c in components):
            continue
        if any(_dist_point_to_segment(p, wr.segments[i], wr.segments[i + 1]) < wire_clearance
               for wr in wires for i in range(len(wr.segments) - 1)):
            continue
        made += 1
        yield p


# ===========================================================================
# Routing: connect two points with a plain grid A*, stepping in 8 directions
# (45° apart), avoiding every component, every via, and every wire already
# on the board.
# ===========================================================================

CELL = 2.0    # grid resolution
PAD = 20.0    # extra room the search area extends around the two points

WIRE_ATTRACT_RADIUS = 1.5     # cells within this many world units of an existing
                              # wire get a small cost discount
WIRE_ATTRACT_DISCOUNT = 0.85  # multiplier applied to a step landing in one of
                              # those cells, biasing routes to bundle alongside
                              # wires that are already there rather than
                              # spreading out — mild on purpose, and note it
                              # makes the octile heuristic technically
                              # inadmissible (it assumes full-price steps), so
                              # this trades strict shortest-path optimality
                              # for the bundled look

_DIRS = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]


def _build_grid(pos_a: Vector2, pos_b: Vector2, components, vias, existing_wires, pad):
    x0 = min(pos_a.x, pos_b.x) - pad
    x1 = max(pos_a.x, pos_b.x) + pad
    y0 = min(pos_a.y, pos_b.y) - pad
    y1 = max(pos_a.y, pos_b.y) + pad

    cols = max(2, math.ceil((x1 - x0) / CELL))
    rows = max(2, math.ceil((y1 - y0) / CELL))

    def cell_of(p: Vector2):
        c = int((p.x - x0) // CELL)
        r = int((p.y - y0) // CELL)
        return max(0, min(cols - 1, c)), max(0, min(rows - 1, r))

    def center_of(cell):
        c, r = cell
        return Vector2(x0 + c * CELL + CELL / 2, y0 + r * CELL + CELL / 2)

    blocked = [[False] * rows for _ in range(cols)]
    near_wire = [[False] * rows for _ in range(cols)]

    def mark(grid, bx0, by0, bx1, by1):
        if bx1 < x0 or bx0 > x1 or by1 < y0 or by0 > y1:
            return
        c0, r0 = cell_of(Vector2(max(bx0, x0), max(by0, y0)))
        c1, r1 = cell_of(Vector2(min(bx1, x1), min(by1, y1)))
        for c in range(c0, c1 + 1):
            for r in range(r0, r1 + 1):
                grid[c][r] = True

    for comp in components:
        mark(blocked, comp.pos.x, comp.pos.y, comp.pos.x + comp.w, comp.pos.y + comp.h)

    for v in vias:
        mark(blocked, v.x - 0.5, v.y - 0.5, v.x + 0.5, v.y + 0.5)

    for w in existing_wires:
        for i in range(len(w.segments) - 1):
            a, b = w.segments[i], w.segments[i + 1]
            mark(blocked, min(a.x, b.x), min(a.y, b.y), max(a.x, b.x), max(a.y, b.y))
            r = WIRE_ATTRACT_RADIUS
            mark(near_wire, min(a.x, b.x) - r, min(a.y, b.y) - r, max(a.x, b.x) + r, max(a.y, b.y) + r)

    return cols, rows, blocked, near_wire, cell_of, center_of


def _astar(cols, rows, blocked, near_wire, start, goal):
    """Search over (cell, heading) states rather than bare cells, so each
    step can only continue straight or turn 45° either way — no direct 90°
    corners. The very first step is unconstrained (heading -1), since
    there's no incoming direction yet to turn from.

    Stepping into a cell near an existing wire (`near_wire`) is discounted
    slightly, biasing the route to bundle alongside wires already on the
    board instead of spreading out to use empty space."""
    def passable(c, r):
        return 0 <= c < cols and 0 <= r < rows and not blocked[c][r]

    open_heap = [(0.0, start, -1)]
    g_score = {(start, -1): 0.0}
    came_from = {}
    visited = set()

    while open_heap:
        _, cur, d = heapq.heappop(open_heap)
        if (cur, d) in visited:
            continue
        visited.add((cur, d))
        if cur == goal:
            path = [cur]
            key = (cur, d)
            while key in came_from:
                key = came_from[key]
                path.append(key[0])
            path.reverse()
            return path

        cx, cy = cur
        g = g_score[(cur, d)]
        candidate_dirs = range(8) if d == -1 else ((d - 1) % 8, d, (d + 1) % 8)
        for di in candidate_dirs:
            dx, dy = _DIRS[di]
            nx, ny = cx + dx, cy + dy
            if not passable(nx, ny):
                continue
            if dx != 0 and dy != 0 and (not passable(cx + dx, cy) or not passable(cx, cy + dy)):
                continue    # no cutting a diagonal across a blocked corner
            step_cost = math.sqrt(2) if dx != 0 and dy != 0 else 1.0
            if near_wire[nx][ny]:
                step_cost *= WIRE_ATTRACT_DISCOUNT
            ng = g + step_cost
            key = ((nx, ny), di)
            if key not in g_score or ng < g_score[key]:
                g_score[key] = ng
                came_from[key] = (cur, d)
                dx_h, dy_h = abs(nx - goal[0]), abs(ny - goal[1])
                h = (dx_h + dy_h) - (2 - math.sqrt(2)) * min(dx_h, dy_h)   # octile
                heapq.heappush(open_heap, (ng + h, (nx, ny), di))
    return None


def _simplify(points):
    """Drop points that fall on a straight run — keep only the turns."""
    if len(points) < 3:
        return points[:]
    out = [points[0]]
    for i in range(1, len(points) - 1):
        a, b, c = points[i - 1], points[i], points[i + 1]
        if (b.x - a.x, b.y - a.y) != (c.x - b.x, c.y - b.y):
            out.append(b)
    out.append(points[-1])
    return out


def route(pos_a: Vector2, pos_b: Vector2, components, vias, existing_wires) -> Wire | None:
    """Connect two points with a simple grid A*, avoiding every component,
    every via, and every wire already placed. A tight local search area can
    box a route in with nowhere left to go, so this retries with more room
    a couple of times before giving up."""
    for pad in (PAD, PAD * 3, PAD * 8):
        cols, rows, blocked, near_wire, cell_of, center_of = _build_grid(pos_a, pos_b, components, vias, existing_wires, pad)
        start, goal = cell_of(pos_a), cell_of(pos_b)
        blocked[start[0]][start[1]] = False   # a start/end point is always legal,
        blocked[goal[0]][goal[1]] = False     # even if it lands on an obstacle's edge

        path = _astar(cols, rows, blocked, near_wire, start, goal)
        if path is not None:
            poly = [center_of(cell) for cell in path]
            poly[0] = pos_a
            poly[-1] = pos_b
            return Wire(_simplify(poly))

    print(f'route(): no path found for {pos_a} -> {pos_b}; dropping this connection')
    return None


# ===========================================================================
# Grid-based cable growth. Step 1, per explicit instruction: a whole-board
# grid (same idea as the router's grid, just sized to the whole board
# instead of local to two points), and a cable that grows as a solid block
# of cells -- its own full width, one whole row/column at a time -- in a
# single fixed direction. No turning yet, and nothing at the far end yet:
# both are separate, later steps.
# ===========================================================================


def _box_cells(x, y, w, h, cell_of, cols, rows, clearance=0):
    """Every grid cell a w x h world-space box covers, optionally grown by
    `clearance` cells on all sides (clipped to the board).

    The far corner is pulled back a hair before cell_of() -- otherwise,
    whenever it lands EXACTLY on a cell boundary (any box whose size and
    position are both nice round multiples of `cell`, e.g. size 16 at
    (400,300)), cell_of() attributes that boundary to the cell just
    OUTSIDE the box, and the range() below includes it, marking one extra
    row/column beyond the box's real edge every time that happens."""
    c0, r0 = cell_of(Vector2(x + 1e-6, y + 1e-6))
    c1, r1 = cell_of(Vector2(x + w - 1e-6, y + h - 1e-6))
    return [(c, r)
            for c in range(max(0, c0 - clearance), min(cols - 1, c1 + clearance) + 1)
            for r in range(max(0, r0 - clearance), min(rows - 1, r1 + clearance) + 1)]


def build_board_grid(width, height, components, cell=CELL, clearance=0):
    """A whole-board occupancy grid: every existing component rasterised
    as blocked cells, same idea as the router's own _build_grid, just
    sized to the whole board instead of local to two points.

    `clearance` is a keepout margin, in cells, marked around every
    component (unless it has its own `clearance` attribute) on top of its own footprint -- so traces and later
    components have to stand off rather than running flush against a
    component's edge. The component still DRAWS at its real size; this
    only makes its collision footprint bigger.

    Cells hold a COUNT, not a bool, since keepout margins routinely
    overlap each other (and a component's own body): a cable that frees
    its cells again has to leave any other claim on them standing, which
    a bool can't express. Every read still just tests truthiness."""
    cols = math.ceil(width / cell)
    rows = math.ceil(height / cell)
    blocked = [[0] * rows for _ in range(cols)]

    def cell_of(p: Vector2):
        c = int(p.x // cell)
        r = int(p.y // cell)
        return max(0, min(cols - 1, c)), max(0, min(rows - 1, r))

    for comp in components:
        # a component may carry its own `clearance` attribute (e.g. small pads
        # want a tighter margin than big components); otherwise the default
        own = getattr(comp, 'clearance', clearance)
        for c, r in _box_cells(comp.pos.x, comp.pos.y, comp.w, comp.h, cell_of, cols, rows, own):
            blocked[c][r] += 1

    return cols, rows, blocked, cell_of


def grow_cable(component: Component, direction: Direction, cols, rows, blocked, cell_of, cell=CELL,
               max_cells=None, turn_chance=0.0, bias=0.5, turn90_chance=0.0, max_turns90=None, new_size=None,
               min_cells=0, width=None, offset=None, ends_in_via=False, clearance=0,
               max_backups=0):
    """Grow a cable as a solid block of grid cells out of one face of
    `component`.

    `width` is how many wires the cable itself has -- independent of how
    many the face could physically fit (`component`'s span along that
    face, in cells). Defaults to that full span (the old behaviour: one
    wire per available slot). A smaller `width` centres that many wires
    within the face rather than using its near edge, so a strip doesn't
    have to use every stub a component offers. Requesting a `width`
    bigger than the face can hold raises ValueError -- a cable can never
    have more wires than the component it leaves from can carry.

    `offset` places that `width`-wide band at a specific position within
    the face (0 = flush with the near/low side) instead of centring it --
    for picking out one particular leftover stub rather than however many
    happen to sit in the middle. Must leave the band inside the face
    (`offset + width <= ` the face's own span) or ValueError.

    `ends_in_via`: for a single-wire (`width` must be 1) walk that ends
    at a via instead of a new component -- no placement search, no
    backing up, since a via is just a point and wherever the walk stops
    is always a legal spot for one. `min_cells` is reused here as a
    minimum walk length instead of its normal cable-scrapping role
    (still at least 1 even if left at the 0 default, since a via at the
    very stub it started from isn't a wire at all). Returns
    `([lane], via_pos)`, or `([], None)` if it never reached that
    minimum (including the very first step already being blocked) --
    same "just drop it" shape as a scrapped normal cable, so a caller
    can handle both the same way.

    `max_backups`: how many times the walk may retreat when it's blocked
    on every side. Instead of stopping dead, it undoes its last step
    (freeing those cells) and tries a different option from the earlier
    position -- depth-first, remembering what it already tried from each
    position so it never repeats itself. Once it's stuck it also tries
    the diagonals it would normally never pick, so it can sidestep an
    obstacle rather than only ending against it. It only retreats within
    the current straight segment, never back through a 90° turn. 0 (the
    default) keeps the plain greedy walk, unchanged.

    `clearance` is the keepout margin, in cells, that build_board_grid
    marked around every component -- pass the SAME value here. This
    cable is exempted from `component`'s own margin (it has to leave
    that face, so its origin keeps its plain footprint as far as this
    cable is concerned) but respects every other component's, and the
    component it plants at the far end gets a margin of its own.

    `new_size` (the component planted at the far end) is checked the
    same way: it must be big enough, in cells, to carry `width` wires,
    since a strip can't plug into a component with fewer wire-slots than
    it's carrying. Left as None, it defaults to exactly `width` cells (the
    old default), so nothing changes for callers that never touch it.

    Two kinds of turning, both optional:

    - `turn_chance`: a 45° lateral wiggle, checked every step. The cable
      has a current lateral heading -- left, right, or straight -- and
      mostly just repeats it, since several diagonal shifts in the same
      direction in a row are one straight 45° line, not a sequence of
      turns. On the `turn_chance` roll it switches to an ADJACENT
      heading only (straight to a diagonal, or a diagonal back to
      straight) -- never directly from one diagonal to the other, which
      would skip over straight and be a 90° turn in one step. Whenever
      that roll picks a new diagonal (from straight), `bias` is the
      probability it leans toward this cable's own `pref_dir` -- fixed
      once, from the STARTING direction rotated 90° clockwise (N->E,
      E->S, S->W, W->N), not recomputed as the cable turns. 0.5 (the
      default) is an even coin flip, which drifts randomly side to side
      over a long walk; closer to 1 makes it lean consistently toward
      pref_dir instead, reading as a natural, gentle curve rather than a
      symmetric zigzag. (A 90° turn always ends up rotating onto the
      SAME axis pref_dir lies on, so there's no lateral option left that
      means "toward pref_dir" any more once that's happened -- so after a
      turn the wiggle leans, with the same `bias`, along the direction
      the cable STARTED in instead: lateral drift then carries it on
      away from where it left its origin rather than curling back
      toward the origin's own row, which is what used to land strips
      right in front of the origin's other faces.)

    - `turn90_chance`: an actual 90° turn onto the other axis, only
      attempted while heading straight. Rather than rotating the whole
      band around one pivot (self-crossing -- see below), each of the
      `width` lanes takes a DIFFERENT number of diagonal steps to reach
      the new axis: 1 for whichever lane already sits closest to the
      inside of the turn, up to `width` for the one on the far side.
      The near lane finishes almost immediately and then just waits
      (steps in place) until the far lane, still wiggling its way
      across, catches up -- so every lane's path is strictly nested
      inside the next one's, which can never cross. The whole manoeuvre
      spans a `width` x `width` square and is checked as a single atomic
      unit -- either every lane's every step in it is free, or none of
      it is applied and the cable just continues straight instead.
      `max_turns90` caps how many of these the cable is allowed to make
      in total (None, the default, means no cap).

      The turn's own last step is already a diagonal (old_forward +
      new_forward combined), so the very next step is forced straight
      before `turn_chance` gets to wiggle it again -- otherwise a
      diagonal wiggle picked immediately after could lean the opposite
      way from the turn's own diagonal with nothing straight between
      them, the same direct-diagonal-to-diagonal look `turn_chance`
      otherwise never produces on its own.

    An earlier version let the whole band rotate to any of 8 directions,
    pivoting around one corner. That needed a different pivot corner
    depending on which way it turned, was easy to get backwards, and
    even done right meant the far edge sweeping through an arc it had
    already occupied -- fragile. Per-lane nesting needs none of that.

    A step only succeeds if every cell it needs is free and in bounds.
    Marks every cell the cable claims as blocked, so it's a real
    obstacle for whatever grows next.

    Once growth stops (board edge, blocked, or max_cells), a new
    `new_size` x `new_size` Component (defaulting to the cable's own
    width) is planted immediately ahead of wherever the cable ended,
    centred on it and facing squarely into it -- the cable's current
    travel axis is always cardinal even mid-wiggle (only the perpendicular
    offset drifts, never the band's own orientation), so this needs no
    special-casing for whichever heading it stopped on. If that spot's
    blocked, it backs into the cable's own tail (see below) until one
    fits. Each lane's last point is then snapped onto the new component's
    facing edge so it reads as actually plugged in, not just stopping
    nearby.

    Backing up can only shrink the cable so far before `min_cells` -- if
    even giving up the whole way back to the last 90° turn (or the very
    start, if there wasn't one) still leaves nothing that fits without
    dropping below `min_cells` total length, the WHOLE cable is scrapped
    rather than kept as a stub shorter than that -- returns ([], None)
    in that case instead of (lanes, new_component).

    Returns (lanes, new_component). `lanes` is a list of `width` lanes --
    one per stub on `direction`, in order -- each a list of Vector2
    world-space cell-centre points along that lane's own path. Each lane
    is a single, continuous, already-simplified polyline (see _simplify:
    only the turns are kept, not every intermediate straight-run point)
    -- a real line a caller can hand straight to Wire(lane), not a pile
    of independent cell rectangles to approximate one from."""
    c0, r0 = cell_of(component.pos)
    span_cols = round(component.w / cell)
    span_rows = round(component.h / cell)

    vertical = direction in ('N', 'S')
    face_span = span_cols if vertical else span_rows
    if width is None:
        width = face_span
    elif width > face_span:
        raise ValueError(f"grow_cable(): requested width {width} exceeds the "
                          f"{face_span}-wire capacity of this component's {direction} face")
    if ends_in_via and width != 1:
        raise ValueError('grow_cable(): ends_in_via is only for single-wire (width=1) walks')
    if offset is None:
        face_offset = (face_span - width) // 2   # centre a narrower strip within the face
    elif offset < 0 or offset + width > face_span:
        raise ValueError(f'grow_cable(): offset {offset} with width {width} does not fit '
                          f'within the {face_span}-wire face')
    else:
        face_offset = offset
    fc, fr = {'N': (0, -1), 'S': (0, 1), 'W': (-1, 0), 'E': (1, 0)}[direction]
    pref_dir = (-fr, fc)   # this cable's OWN fixed bias direction: the starting
                            # direction rotated 90° clockwise (N->E, E->S, S->W,
                            # W->N), set once here and never recomputed, even
                            # after a 90° turn -- see bias's use below
    start_dir = (fc, fr)   # the direction it left the origin in; what the
                            # wiggle leans along once pref_dir stops applying
    # N/W grow off the NEAR edge, where r0/c0 (from cell_of on component.pos
    # directly) is already exact regardless of alignment -- one cell back
    # from that is always the first free cell outside. S/E grow off the FAR
    # edge instead (pos.y+h / pos.x+w), and r0+span_rows / c0+span_cols is
    # only that same first-outside cell when component.pos itself sits on a
    # cell boundary -- for a component that doesn't (e.g. the hub, placed
    # directly rather than through grow_cable), it can land on the cell the
    # far edge actually cuts through, which build_board_grid correctly
    # marks blocked as part of the component -- so the far edge is instead
    # found the same way build_board_grid finds it: cell_of on the true
    # edge coordinate, pulled back by an epsilon so landing exactly on a
    # boundary attributes to the inside cell, then step one further out.
    if vertical:
        if direction == 'N':
            first_outside = r0 - 1
        else:
            first_outside = cell_of(Vector2(component.pos.x, component.pos.y + component.h - 1e-6))[1] + 1
    else:
        if direction == 'W':
            first_outside = c0 - 1
        else:
            first_outside = cell_of(Vector2(component.pos.x + component.w - 1e-6, component.pos.y))[0] + 1

    # the main loop's first iteration always advances `along` by `forward`
    # before recording anything, so the STARTING along has to be set one
    # cell short of `first_outside` -- subtracting forward here cancels
    # that first advance out (see the earlier fix for this gap).
    if vertical:
        perp, along = c0 + face_offset, first_outside - fr
    else:
        perp, along = r0 + face_offset, first_outside - fc

    def band_at(perp, along):
        return [(perp + k, along) for k in range(width)] if vertical else [(along, perp + k) for k in range(width)]

    def cell_at(p, a):
        return (p, a) if vertical else (a, p)

    def in_bounds(cells):
        return all(0 <= c < cols and 0 <= r < rows for c, r in cells)

    def center_of(c, r):
        return Vector2(c * cell + cell / 2, r * cell + cell / 2)

    # this cable has to leave `component`'s own face, so it can't be held
    # off by `component`'s own keepout margin -- discount that one
    # component's contribution to the count (rather than clearing those
    # cells, which would drop the margin for everyone else too, and for
    # good). Cells the margin shares with anything real stay blocked,
    # since their count doesn't reach zero.
    origin_margin = set()
    if clearance:
        body = set(_box_cells(component.pos.x, component.pos.y, component.w, component.h,
                              cell_of, cols, rows))
        origin_margin = {rc for rc in _box_cells(component.pos.x, component.pos.y, component.w, component.h,
                                                 cell_of, cols, rows, clearance)
                         if rc not in body}

    def is_blocked(c, r):
        n = blocked[c][r]
        if (c, r) in origin_margin:
            n -= 1
        return n > 0

    def blocked_by_other(c, r):
        # like is_blocked, but this cable's own cells don't count -- for the
        # corner check on a 90° turn, where a lane's neighbours are its own
        if not (0 <= c < cols and 0 <= r < rows):
            return False
        n = blocked[c][r] - ((c, r) in all_marked)
        if (c, r) in origin_margin:
            n -= 1
        return n > 0

    lanes = [[] for _ in range(width)]
    all_marked = set()   # every cell this cable currently holds, across every
                          # segment and turn -- so scrapping it for min_cells
                          # can unmark all of it, not just the final segment's
                          # own `history` (which only covers since the last
                          # turn). Backing up discards from this as it frees
                          # cells, since blocked[] now counts claims rather
                          # than just recording "occupied" -- releasing the
                          # same cell twice would drive its count negative and
                          # punch a hole through whatever else claimed it.
    # lane_order[k] = which physical wire (lanes[] index, fixed for that
    # wire's whole life) currently sits at position k along the perp axis.
    # band_at()/perp+k always addresses cells by POSITION, not identity --
    # a reversing turn (below) swaps which identity is at which position,
    # but must never make a wire's own output list jump to a different
    # wire, or the polyline stitches together two different physical
    # traces at the join.
    lane_order = list(range(width))
    heading = 0   # current lateral shift: -1 left, 0 straight, +1 right
    steps = 0
    turns90_done = 0
    just_turned = True    # forces one straight step right after a 90° turn (and at the very start) --
                           # the turn's own geometry already ends on a diagonal
                           # (old_forward + new_forward combined), so wiggling
                           # into a new diagonal immediately after, with no
                           # straight step between them, would produce the same
                           # sharp direct-diagonal-to-diagonal look the heading
                           # state machine otherwise always avoids -- it just
                           # isn't governed by that state machine, since a turn
                           # resets to heading 0 without ever passing through it.
                           # Starting True forces the FIRST step straight too:
                           # a wiggle or turn on step 0 puts the first recorded
                           # cell a cell sideways of the nub, and the start snap
                           # takes its position from that cell -- so the whole
                           # strip would leave its face one nub out of place
    # every committed step on the CURRENT axis, as (perp, along, band) --
    # lets the end-of-growth placement back into the cable's own tail if
    # the spot immediately ahead turns out to be blocked, by popping
    # entries off (unmarking their cells) until a placement fits. Reset
    # whenever the axis changes, since a 90° turn's own cells have
    # per-lane, not per-step, history and aren't safe to unwind this way.
    history = []
    segment_start = (perp, along)
    backups = 0
    best = None       # deepest state seen when retreat began, so a failed search can put it back
    best_steps = -1
    tried = {}   # (perp, along, heading) -> shifts already taken from there, for retreat
    while max_cells is None or steps < max_cells:
        if (heading == 0 and not just_turned and turn90_chance > 0 and random() < turn90_chance
                and (max_turns90 is None or turns90_done < max_turns90)):
            side = choice((-1, 1))                       # -1 left, +1 right
            nfc, nfr = (-fr, fc) if side == 1 else (fr, -fc)   # rotate (fc,fr) 90°

            # lane i sits at perp+i along a fixed axis, always the SAME
            # physical direction regardless of which way the cable is
            # currently facing -- compare that axis to the new travel
            # direction to find which end of the band is already leaning
            # toward this turn (fewest wiggles) versus away from it (most)
            lane_axis = (1, 0) if vertical else (0, 1)
            leaning_high = lane_axis[0] * nfc + lane_axis[1] * nfr > 0
            wiggles = [(width - i if leaning_high else i + 1) for i in range(width)]

            trial = band_at(perp, along)
            gained = [[] for _ in range(width)]
            ok = True
            for t in range(1, width + 1):
                for i in range(width):
                    if t > wiggles[i]:
                        continue   # this lane already finished turning -- holds in place
                    c, r = trial[i]
                    nc, nr = c + fc + nfc, r + fr + nfr
                    if (not (0 <= nc < cols and 0 <= nr < rows) or is_blocked(nc, nr)
                            or blocked_by_other(nc, r) or blocked_by_other(c, nr)):
                        # (the last two are the corner cells this diagonal step cuts
                        # across -- same rule as an ordinary diagonal step below)
                        ok = False
                        break
                    trial[i] = (nc, nr)
                    gained[i].append((nc, nr))
                if not ok:
                    break

            if ok:
                for k in range(width):
                    for c, r in gained[k]:
                        blocked[c][r] += 1
                        all_marked.add((c, r))
                        lanes[lane_order[k]].append(center_of(c, r))

                # band_at()/perp+k always assumes position 0 sits at the
                # SMALLEST coordinate along the perp axis. leaning_high
                # predicts which end that'll be from the turn direction
                # alone, but that prediction doesn't always hold -- what
                # actually matters is where trial[0]/trial[-1] really
                # ended up, so check the real result instead of trusting
                # the prediction. If they swapped sides, position order
                # is now backwards relative to wire identity, and
                # lane_order has to flip so each wire's own output list
                # keeps receiving only its own points.
                vertical = not vertical
                coord = (lambda cell: cell[0]) if vertical else (lambda cell: cell[1])
                swapped = coord(trial[0]) > coord(trial[-1])
                if swapped:
                    lane_order.reverse()

                fc, fr = nfc, nfr
                first = trial[-1] if swapped else trial[0]
                perp, along = first if vertical else (first[1], first[0])
                steps += width
                turns90_done += 1
                best, best_steps = None, steps   # a snapshot from before the turn no longer fits
                history = []
                segment_start = (perp, along)
                just_turned = True
                continue   # heading is still 0 -- straight on the new axis

        forward = fr if vertical else fc
        if just_turned:
            # one forced straight step right after a 90° turn -- see
            # just_turned's own comment for why this needs to be separate
            # from the ordinary heading state machine below
            wanted = 0
        elif turn_chance > 0 and random() < turn_chance:
            # a turn can only step to an ADJACENT heading -- straight to
            # either diagonal, or a diagonal back to straight -- never
            # left-diagonal directly to right-diagonal or vice versa,
            # since that skips over straight and is really a 90° turn in
            # one step, not a 45° one
            if heading == 0:
                # +1 means "toward +lane_axis", which is a fixed world
                # direction (not "right relative to current travel") --
                # bias is stated in terms of pref_dir instead, so work out
                # whether +1 or -1 is the one that actually points toward
                # pref_dir before applying it. After a 90° turn pref_dir
                # ends up parallel to the new travel direction (rotating
                # 90° from the start and rotating 90° again land on the
                # same axis as forward, not perpendicular to it any more)
                # -- there's no lateral option that means "pref_dir" any
                # more at that point, so lean along start_dir instead,
                # which IS lateral then: it keeps the cable moving away
                # from its origin's row instead of wandering back to it.
                lane_axis = (1, 0) if vertical else (0, 1)
                alignment = lane_axis[0] * pref_dir[0] + lane_axis[1] * pref_dir[1]
                if alignment == 0:
                    alignment = lane_axis[0] * start_dir[0] + lane_axis[1] * start_dir[1]
                effective_bias = bias if alignment > 0 else (1 - bias)
                wanted = 1 if random() < effective_bias else -1
            else:
                wanted = 0
        else:
            wanted = heading

        # try the wanted heading first, then fall back to whatever it was
        # already doing, then straight as a last resort -- in that order,
        # skipping duplicates
        candidates = []
        for s in (wanted, heading, 0):
            if s not in candidates:
                candidates.append(s)
        if max_backups:
            # once retreat is on, every legal option is fair game after the
            # preferred ones -- a diagonal is only legal from straight, and
            # straight-only right after a turn (or at the very start)
            for s in ([0] if just_turned else [0, 1, -1] if heading == 0 else [heading, 0]):
                if s not in candidates:
                    candidates.append(s)
            tried_here = tried.setdefault((perp, along, heading), set())
            candidates = [s for s in candidates if s not in tried_here]
        prev_state = (perp, along, heading, just_turned)

        moved = False
        for shift in candidates:
            next_perp, next_along = perp + shift, along + forward
            band = band_at(next_perp, next_along)
            if not in_bounds(band) or any(is_blocked(c, r) for c, r in band):
                continue
            if shift != 0:
                # a lateral+forward step is a genuine diagonal -- the two
                # cells at the exposed trailing/leading edge (belonging to
                # neither the old band nor the new one) are the "corners"
                # this diagonal cuts across. If another cable already
                # occupies one, its own line runs through that same corner
                # point, and this step would cross it even though the two
                # cables never share an actual cell -- same corner-cutting
                # rule _astar already applies elsewhere in this file.
                if shift > 0:
                    corners = [cell_at(perp, next_along), cell_at(next_perp + width - 1, along)]
                else:
                    corners = [cell_at(perp + width - 1, next_along), cell_at(next_perp, along)]
                if any(0 <= cc < cols and 0 <= cr < rows and is_blocked(cc, cr) for cc, cr in corners):
                    continue
            for c, r in band:
                blocked[c][r] += 1
                all_marked.add((c, r))
            for k, (c, r) in enumerate(band):
                lanes[lane_order[k]].append(center_of(c, r))
            if max_backups:
                tried_here.add(shift)
            perp, along = next_perp, next_along
            history.append((perp, along, band, prev_state))
            heading = shift
            moved = True
            just_turned = False
            break
        if not moved:
            if max_backups and backups < max_backups and history:
                if steps > best_steps:
                    # about to start unwinding from a new deepest point -- keep it,
                    # because if the search finds nothing better the walk must
                    # end here, not wherever the budget happened to run out
                    best_steps = steps
                    best = (steps, perp, along, heading, just_turned,
                            [lane[:] for lane in lanes], list(history), set(all_marked))
                backups += 1
                popped_band, prev_state = history.pop()[2:]
                for c, r in popped_band:
                    blocked[c][r] -= 1
                    all_marked.discard((c, r))
                for lane in lanes:
                    lane.pop()
                perp, along, heading, just_turned = prev_state
                steps -= 1
                continue
            break
        steps += 1

    if best is not None and steps < best_steps:
        (steps, perp, along, heading, just_turned, lanes, history, saved_marked) = best
        for c, r in all_marked - saved_marked:
            blocked[c][r] -= 1
        for c, r in saved_marked - all_marked:
            blocked[c][r] += 1
        all_marked = saved_marked

    if ends_in_via:
        if steps < max(1, min_cells):
            for c, r in all_marked:
                blocked[c][r] -= 1
            return [], None
        start_vertical = direction in ('N', 'S')
        start_edge = {'N': component.pos.y, 'S': component.pos.y + component.h,
                      'W': component.pos.x, 'E': component.pos.x + component.w}[direction]
        lanes = [_simplify(lane) for lane in lanes]
        lane = lanes[0]
        first = lane[0]
        start_touch = Vector2(first.x, start_edge) if start_vertical else Vector2(start_edge, first.y)
        lane.insert(0, start_touch)
        return lanes, lane[-1]

    if new_size is None:
        new_size = width * cell
    else:
        # every placement below assumes new_size is a whole number of
        # cells, same as the board itself -- otherwise the component's
        # FAR edge (pos + new_size) can land mid-cell instead of exactly
        # on a boundary, and that cell then has to be marked blocked for
        # real (part of it genuinely is the component), silently eating
        # the one cell of clearance a cable growing from it later expects
        # to find immediately outside -- round it here so that's never
        # the caller's problem to get right
        new_size = round(new_size / cell) * cell
        if new_size < width * cell:
            raise ValueError(f"grow_cable(): new_size {new_size} can't hold this cable's "
                              f"{width} wires -- needs to be at least {width * cell}")
    half = new_size / 2

    def component_box(perp_h, along_h):
        band = band_at(perp_h, along_h)
        centers = [center_of(c, r) for c, r in band]
        cx = sum(p.x for p in centers) / width
        cy = sum(p.y for p in centers) / width
        if fc != 0:   # horizontal travel -- component sits east or west of the band
            fx0 = (along_h + 1) * cell if fc > 0 else along_h * cell - new_size
            # the OTHER axis (perpendicular to travel) is centred on the
            # band's own lane centres, which aren't necessarily a whole
            # number of cells from the grid origin -- snap it to the
            # nearest cell boundary for the same reason as new_size above
            fy0 = round((cy - half) / cell) * cell
        else:         # vertical travel -- component sits south or north of it
            fy0 = (along_h + 1) * cell if fr > 0 else along_h * cell - new_size
            fx0 = round((cx - half) / cell) * cell
        return fx0, fy0

    def box_fits(fx0, fy0):
        if fx0 < 0 or fy0 < 0 or fx0 + new_size > cols * cell or fy0 + new_size > rows * cell:
            return False
        if any(is_blocked(c, r) for c, r in
               _box_cells(fx0, fy0, new_size, new_size, cell_of, cols, rows)):
            return False
        # the keepout margin has to stand clear of everything EXCEPT this
        # cable's own cells -- the cable is what plugs into this component,
        # so it's expected to run right up to it (and, having just been
        # marked, would otherwise block every placement outright)
        own = all_marked
        return not any(is_blocked(c, r) for c, r in
                       _box_cells(fx0, fy0, new_size, new_size, cell_of, cols, rows, clearance)
                       if (c, r) not in own)

    # the spot immediately ahead of the last band is usually free (growth
    # more often stops on max_cells running out than on a real
    # obstruction) but when it isn't, back up along the cable's own tail
    # -- unmarking each popped step's cells and un-appending its points --
    # until a placement actually fits, rather than planting a component on
    # top of whatever it just grew into. But backing up shrinks the cable,
    # and it's only allowed to shrink so far: if even giving up the whole
    # way back still leaves nothing that fits without dropping below
    # min_cells, the cable was never going to be worth keeping, so scrap
    # it entirely -- unmarking EVERY cell it ever claimed (not just this
    # segment's `history`, which forgets anything before the last 90°
    # turn) so it doesn't leave phantom obstacles behind for later cables.
    fx0, fy0 = component_box(perp, along)
    backed_off = 0
    while not box_fits(fx0, fy0):
        if not history or steps - backed_off <= min_cells:
            for c, r in all_marked:
                blocked[c][r] -= 1
            return [], None
        popped_band = history.pop()[2]
        backed_off += 1
        for c, r in popped_band:
            blocked[c][r] -= 1
            all_marked.discard((c, r))
        for lane in lanes:
            if lane:
                lane.pop()
        perp, along = history[-1][0:2] if history else segment_start
        fx0, fy0 = component_box(perp, along)

    # if nothing along the whole tail fit (e.g. the board's simply too
    # narrow here for a box this size), that's a real placement failure,
    # not something backing up further would fix -- clamp to the board so
    # it at least isn't drawn off-canvas, rather than leaving coordinates
    # that go negative or past the edge
    fx0 = max(0.0, min(fx0, cols * cell - new_size))
    fy0 = max(0.0, min(fy0, rows * cell - new_size))

    new_component = Component(Vector2(fx0, fy0), new_size, new_size)

    # mark the new component's own footprint blocked -- plus its keepout
    # margin, exactly as build_board_grid does for the components it's
    # given up front -- otherwise nothing stops some OTHER cable from
    # later growing straight through this one's body, since the grid has
    # no idea it's there until this happens
    for c, r in _box_cells(fx0, fy0, new_size, new_size, cell_of, cols, rows, clearance):
        blocked[c][r] += 1

    edge_x = (fx0 if fc > 0 else fx0 + new_size) if fc != 0 else None
    edge_y = (fy0 if fr > 0 else fy0 + new_size) if fc == 0 else None

    # same idea at the start: the first recorded point is already a grid
    # cell centre up to half a cell from the component's real edge (using
    # the ORIGINAL `direction`, not `vertical`, which a 90° turn may have
    # since flipped) -- snap it to the exact edge instead of leaving that
    # small but real gap, matching how the far end already connects exactly
    start_vertical = direction in ('N', 'S')
    start_edge = {'N': component.pos.y, 'S': component.pos.y + component.h,
                  'W': component.pos.x, 'E': component.pos.x + component.w}[direction]

    lanes = [_simplify(lane) for lane in lanes]
    for lane in lanes:
        if not lane:
            continue
        first = lane[0]
        start_touch = Vector2(first.x, start_edge) if start_vertical else Vector2(start_edge, first.y)
        lane.insert(0, start_touch)
        last = lane[-1]
        touch = Vector2(edge_x, last.y) if edge_x is not None else Vector2(last.x, edge_y)
        lane.append(touch)

    return lanes, new_component