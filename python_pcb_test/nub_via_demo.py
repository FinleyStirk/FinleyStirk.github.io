import random
from collections import deque
from my_code import Component, build_board_grid, grow_cable, CELL
from utils import Vector2

MIN_WIRES, MAX_WIRES = 2, 25            # wires per strip
COMP_MIN, COMP_MAX = 6, 50              # smallest / largest a strip's destination component may be (stubs per side)
COMP_RATIO = (1.2, 2.0)                 # destination size as a multiple of the strip feeding it, picked at random
HUB_SIZE = 100                          # hub is 50 stubs per side
CLEARANCE = 5   # keepout margin in cells -- components collide bigger than they draw
MAX_STRIPS_PER_FACE = 3    # strips (attempts) a single face may carry
EXTRA_STRIP_CHANCE = 0.6   # chance of trying each further strip once the first is down
STRIP_GAP = 2              # nubs kept clear between two strips on the same face
MAX_BACKUPS = 200          # retreats a blocked strip may make before giving up (0 = off)
POUR_COUNT = 0             # copper pours put down first; everything routes around them
POUR_SIZE = (30, 80)       # pour side range in cells
POUR_CLEARANCE = 2         # keepout margin around a pour, in cells
PAD_CLUSTERS = 40          # groups of exposed pads scattered before anything grows
PAD_SIZES = (4, 6)         # pad side in world units (2 or 3 cells)
PAD_CLEARANCE = 2          # pads keep a tighter margin than full components
PAD_LEAD_CHANCE = 0.7      # chance a pad gets a short lead ending in a via
VIA_BACKUPS = 0            # same for via walks -- off on purpose: they sit one nub apart, so a walk that
                           # retreats and sidesteps steals the next nub's lane (survival drops from 95% to 56%)


def free_runs(face_span, covered):
    """Runs of nubs, as (start, length), that are clear of every strip already on this face by at
    least STRIP_GAP and long enough to hold a minimum strip."""
    taken = {n + d for n in covered for d in range(-STRIP_GAP, STRIP_GAP + 1)}
    runs, start = [], None
    for n in range(face_span + 1):
        if n < face_span and n not in taken:
            if start is None:
                start = n
        elif start is not None:
            if n - start >= MIN_WIRES:
                runs.append((start, n - start))
            start = None
    return runs


def rect_gap(a, b):
    """Distance between two components' rectangles (0 if they touch or overlap)."""
    dx = max(a.pos.x - (b.pos.x + b.w), b.pos.x - (a.pos.x + a.w), 0)
    dy = max(a.pos.y - (b.pos.y + b.h), b.pos.y - (a.pos.y + a.h), 0)
    return (dx * dx + dy * dy) ** 0.5


def make_pads(hub, avoid=(), board_w=800, board_h=600):
    """Clusters of small square pads -- a single, a row, a column or a 2x2 block, like the little
    groups of exposed pads on a real board. Kept clear of the hub's surroundings (so the hub's own
    strips aren't smothered) and of each other's clusters."""
    pads, clusters, tries = [], 0, 0
    while clusters < PAD_CLUSTERS and tries < 2000:
        tries += 1
        size = random.choice(PAD_SIZES)
        pitch = size + 4
        shape = random.choice(('single', 'row', 'col', 'block'))
        n = random.randint(2, 4)
        offsets = {'single': [(0, 0)], 'row': [(i, 0) for i in range(n)], 'col': [(0, i) for i in range(n)],
                   'block': [(0, 0), (1, 0), (0, 1), (1, 1)]}[shape]
        x0, y0 = random.randrange(10, board_w - 10, 2), random.randrange(10, board_h - 10, 2)
        group = [Component(Vector2(x0 + dx * pitch, y0 + dy * pitch), size, size) for dx, dy in offsets]
        if any(p.pos.x + p.w > board_w - 10 or p.pos.y + p.h > board_h - 10 for p in group):
            continue
        if any(rect_gap(p, hub) < CLEARANCE * CELL + 24 for p in group):
            continue
        if any(rect_gap(p, q) < 12 for p in group for q in pads):
            continue
        if any(rect_gap(p, q) < 12 for p in group for q in avoid):
            continue
        pads.extend(group)
        clusters += 1
    for p in pads:
        p.clearance = PAD_CLEARANCE
    return pads


class Pour:
    """A copper pour: a rectangle with each corner cut off at 45 degrees by its own amount, in cell units.
    `pos`/`w`/`h` are the world-space bounding box (so it can be tested like a component); `contains`
    is the exact shape, and `keepout_cells` is what it occupies on the grid, margin included."""

    def __init__(self, cx, cy, wc, hc, cuts):
        self.cx, self.cy, self.wc, self.hc = cx, cy, wc, hc      # top-left cell and size in cells
        self.cuts = cuts                                          # (top-left, top-right, bottom-left, bottom-right)
        self.pos = Vector2(cx * CELL, cy * CELL)
        self.w, self.h = wc * CELL, hc * CELL

    def contains(self, i, j, margin=0.0):
        """Is the cell at (i, j) -- relative to the top-left cell -- inside, at least `margin` cells from the edge?"""
        x, y = i + 0.5, j + 0.5
        tl, tr, bl, br = self.cuts
        d = 1.4142 * margin   # 45-degree edges are further away along the axes than they look
        return (margin <= x <= self.wc - margin and margin <= y <= self.hc - margin
                and x + y >= tl + d and (self.wc - x) + y >= tr + d
                and x + (self.hc - y) >= bl + d and (self.wc - x) + (self.hc - y) >= br + d)

    def polygon(self):
        """Corner points in world units, clockwise from the top edge."""
        x0, y0, x1, y1 = self.pos.x, self.pos.y, self.pos.x + self.w, self.pos.y + self.h
        tl, tr, bl, br = (c * CELL for c in self.cuts)
        pts = [(x0 + tl, y0), (x1 - tr, y0), (x1, y0 + tr), (x1, y1 - br), (x1 - br, y1), (x0 + bl, y1), (x0, y1 - bl), (x0, y0 + tl)]
        return [Vector2(px, py) for px, py in dict.fromkeys(pts)]

    def keepout_cells(self, cols, rows):
        cells = set()
        m = POUR_CLEARANCE
        for i in range(-m, self.wc + m):
            for j in range(-m, self.hc + m):
                # a cell is kept out if any cell within m of it is inside the pour
                if any(self.contains(i + di, j + dj) for di in range(-m, m + 1) for dj in range(-m, m + 1)):
                    c, r = self.cx + i, self.cy + j
                    if 0 <= c < cols and 0 <= r < rows:
                        cells.add((c, r))
        return cells


def make_pours(hub, board_w=800, board_h=600):
    """Random chamfered pours, kept away from the hub's surroundings (or its strips would be smothered),
    the board edge, and each other."""
    pours, tries = [], 0
    while len(pours) < POUR_COUNT and tries < 500:
        tries += 1
        wc, hc = random.randint(*POUR_SIZE), random.randint(*POUR_SIZE)
        cap = min(wc, hc) // 2
        cuts = tuple(random.randint(0, cap) if random.random() < 0.85 else 0 for _ in range(4))
        cx = random.randint(6, int(board_w / CELL) - wc - 6)
        cy = random.randint(6, int(board_h / CELL) - hc - 6)
        pour = Pour(cx, cy, wc, hc, cuts)
        if rect_gap(pour, hub) < CLEARANCE * CELL + 40:
            continue
        if any(rect_gap(pour, q) < 16 for q in pours):
            continue
        pours.append(pour)
    return pours


# hub must sit on the cell grid, or its faces span one more cell than the wires laid out from them
hub = Component(Vector2(round((400 - HUB_SIZE / 2) / CELL) * CELL, round((300 - HUB_SIZE / 2) / CELL) * CELL), HUB_SIZE, HUB_SIZE)
pours = make_pours(hub)
pads = make_pads(hub, avoid=pours)
cols, rows, blocked, cell_of = build_board_grid(800, 600, [hub] + pads, clearance=CLEARANCE)
for pour in pours:   # pours go down first and occupy the grid, so everything else has to route around them
    for c, r in pour.keepout_cells(cols, rows):
        blocked[c][r] += 1

components = [hub]
all_lanes = []
via_lanes = []
vias = []
strips = []   # (origin, direction, offset, width, destination) for every strip that grew
queue = deque([hub])
while queue:
    current = queue.popleft()
    # random face order per component, so no face is always the last to grow and left with whatever room remains
    faces = ['N', 'E', 'S', 'W']
    random.shuffle(faces)
    for direction in faces:
        face_span = round((current.w if direction in ('N', 'S') else current.h) / CELL)

        # a face can carry several strips: the first sits centred, and while there's spare room
        # left over (which would otherwise just be vias) it may try further strips in the free runs
        covered = set()   # nubs used by a strip that actually grew
        for attempt in range(MAX_STRIPS_PER_FACE):
            if attempt > 0 and random.random() > EXTRA_STRIP_CHANCE:
                break
            runs = free_runs(face_span, covered)
            if not runs:
                break
            run_start, run_len = random.choice(runs)
            strip_wires = random.randint(MIN_WIRES, min(MAX_WIRES, run_len))
            if attempt == 0:
                offset = run_start + (run_len - strip_wires) // 2
            else:
                offset = run_start + random.randint(0, run_len - strip_wires)
            comp_wires = round(strip_wires * random.uniform(*COMP_RATIO))
            comp_wires = max(strip_wires, COMP_MIN, min(comp_wires, COMP_MAX))

            lanes, far = grow_cable(current, direction, cols, rows, blocked, cell_of, turn_chance=0.02,
                                     bias=0.9, turn90_chance=0.02, max_turns90=1, max_cells=98, min_cells=40,
                                     width=strip_wires, offset=offset, new_size=comp_wires * CELL,
                                     clearance=CLEARANCE, max_backups=MAX_BACKUPS)
            if far is None:
                continue   # scrapped -- those nubs stay free for vias (or a later strip)
            covered.update(range(offset, offset + strip_wires))
            strips.append((current, direction, offset, strip_wires, far))
            all_lanes.extend(lanes)
            components.append(far)
            queue.append(far)

        # every leftover nub on this same face gets its own single-wire
        # random walk ending in a via -- dropped silently if blocked
        # random order, not nub by nub: in order, each walk is boxed in by the one before it and neighbours
        # settle into repeating patterns
        nubs = [n for n in range(face_span) if n not in covered]
        random.shuffle(nubs)
        for nub in nubs:
            via_wire, via_pos = grow_cable(current, direction, cols, rows, blocked, cell_of, turn_chance=0.1,
                                            bias=0.7, max_cells=random.randint(20, 50), min_cells=2, width=1,
                                            offset=nub, ends_in_via=True, clearance=CLEARANCE,
                                            max_backups=VIA_BACKUPS)
            if via_pos is None:
                continue
            via_lanes.extend(via_wire)
            vias.append(via_pos)

# pads get a short lead of their own ending in a via, grown last so they only use whatever room is left
leads = []   # (pad, lane)
for pad in pads:
    if random.random() > PAD_LEAD_CHANCE:
        continue
    face_span = round(pad.w / CELL)
    lead, via_pos = grow_cable(pad, random.choice('NESW'), cols, rows, blocked, cell_of, turn_chance=0.1,
                               bias=0.7, max_cells=random.randint(10, 30), min_cells=2, width=1,
                               offset=random.randrange(face_span), ends_in_via=True, clearance=PAD_CLEARANCE)
    if via_pos is None:
        continue
    leads.append((pad, lead[0]))
    via_lanes.extend(lead)
    vias.append(via_pos)

print(f'populated {len(components)} components, {len(all_lanes)} strip wires, {len(via_lanes)} via wires, '
      f'{len(pads)} pads ({len(leads)} with leads), {len(pours)} pours')

# blue-PCB colour scheme: dark navy board, lighter blue copper traces,
# a gold via pad, grey component silkscreen
BOARD_BG = '#0a2342'
TRACE_COLOR = '#1d4f86'
VIA_COLOR = '#8fbfee'
COMPONENT_COLOR = '#9098a0'
PAD_COLOR = '#c8d1dc'
POUR_COLOR = TRACE_COLOR      # same copper as the wires
BODY_COLOR = '#1f4f94'      # component body (matte blue)
BODY_EDGE = '#5b8fd0'
BEVEL_LIGHT = '#5b93d6'     # lit top/left edge
BEVEL_DARK = '#0f2b57'      # shaded bottom/right edge
DIMPLE_COLOR = '#0c2245'    # pin-1 indent
PIN_COLOR = '#86b6ea'       # metal leads
DIMPLE_CHANCE = 0.6         # chance a component gets a pin-1 dimple at all
PIN_W, PIN_LEN = 1.0, 1.6   # lead size in world units (nubs are CELL apart)


def component_svg(comp):
    """A chip-like component: matte grainy body with a bevelled edge, a pin-1 dimple in one corner, and a
    metal lead at every nub on every face -- the same positions wires start from."""
    x, y, w, h = comp.pos.x, comp.pos.y, comp.w, comp.h
    out = []
    for k in range(round(w / CELL)):
        px = x + k * CELL + CELL / 2 - PIN_W / 2
        out.append(f'<rect x="{px}" y="{y - PIN_LEN}" width="{PIN_W}" height="{PIN_LEN}" fill="{PIN_COLOR}"/>')
        out.append(f'<rect x="{px}" y="{y + h}" width="{PIN_W}" height="{PIN_LEN}" fill="{PIN_COLOR}"/>')
    for k in range(round(h / CELL)):
        py = y + k * CELL + CELL / 2 - PIN_W / 2
        out.append(f'<rect x="{x - PIN_LEN}" y="{py}" width="{PIN_LEN}" height="{PIN_W}" fill="{PIN_COLOR}"/>')
        out.append(f'<rect x="{x + w}" y="{py}" width="{PIN_LEN}" height="{PIN_W}" fill="{PIN_COLOR}"/>')
    out.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{BODY_COLOR}" stroke="{BODY_EDGE}" '
               f'stroke-width="0.4" filter="url(#grain)"/>')
    b = 0.6   # bevel: light along the top/left inside edge, dark along the bottom/right
    out.append(f'<polyline points="{x + b},{y + h - b} {x + b},{y + b} {x + w - b},{y + b}" fill="none" '
               f'stroke="{BEVEL_LIGHT}" stroke-width="0.6"/>')
    out.append(f'<polyline points="{x + w - b},{y + b} {x + w - b},{y + h - b} {x + b},{y + h - b}" fill="none" '
               f'stroke="{BEVEL_DARK}" stroke-width="0.6"/>')
    if random.random() < DIMPLE_CHANCE:   # pin-1 dimple: only on some components, in a random corner
        r = max(0.8, min(3.0, min(w, h) * 0.05))
        inset = 2.2 * r + 1
        cx = x + inset if random.random() < 0.5 else x + w - inset
        cy = y + inset if random.random() < 0.5 else y + h - inset
        out.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{DIMPLE_COLOR}" '
                   f'stroke="{BEVEL_LIGHT}" stroke-width="0.25"/>')
    return out

lines = [f'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">']
lines.append(f'<rect x="0" y="0" width="800" height="600" fill="{BOARD_BG}"/>')
lines.append('<defs><filter id="grain" x="0" y="0" width="100%" height="100%">'
             '<feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="7" result="noise"/>'
             '<feColorMatrix in="noise" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.16 -0.03" result="speckle"/>'
             '<feComposite in="speckle" in2="SourceAlpha" operator="in" result="clipped"/>'
             '<feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="clipped"/></feMerge>'
             '</filter></defs>')
for pour in pours:
    pts = ' '.join(f'{p.x},{p.y}' for p in pour.polygon())
    lines.append(f'<polygon points="{pts}" fill="{POUR_COLOR}"/>')
for comp in components:
    lines.extend(component_svg(comp))
for lane in all_lanes:
    points = ' '.join(f'{p.x},{p.y}' for p in lane)
    lines.append(f'<polyline points="{points}" fill="none" stroke="{TRACE_COLOR}" stroke-width="0.5"/>')
for lane in via_lanes:
    points = ' '.join(f'{p.x},{p.y}' for p in lane)
    lines.append(f'<polyline points="{points}" fill="none" stroke="{TRACE_COLOR}" stroke-width="0.5"/>')
for via in vias:
    lines.append(f'<circle cx="{via.x}" cy="{via.y}" r="0.7" fill="{BOARD_BG}" stroke="{VIA_COLOR}" stroke-width="0.3"/>')
for pad in pads:
    lines.append(f'<rect x="{pad.pos.x}" y="{pad.pos.y}" width="{pad.w}" height="{pad.h}" fill="{PAD_COLOR}"/>')
lines.append('</svg>')
with open('out_walk_vias.svg', 'w') as f:
    f.write('\n'.join(lines))
print('wrote out_walk_vias.svg')
