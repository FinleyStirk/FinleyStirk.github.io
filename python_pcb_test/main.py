from collections import deque

from my_code import Component, route, pair_stubs, distribute_vias, build_board_grid, grow_cable, CELL
from utils import Vector2
from renderer import render_svg


def main(width, height):
    comp1 = Component(Vector2(60, 60), 30, 30)      # top-left
    comp2 = Component(Vector2(340, 340), 30, 30)     # centre — the hub
    comp3 = Component(Vector2(600, 60), 30, 30)      # top-right
    comp4 = Component(Vector2(600,140), 30, 30)     # top-right, below comp3
    comp5 = Component(Vector2(460, 440), 30, 30)      # bottom-right
    comp6 = Component(Vector2(140, 140), 30, 30)
    components = [comp1, comp2, comp3, comp4, comp5, comp6]

    # comp2 as a hub, one face-to-face connection out to each of the other
    # four — each pair of faces used at most once, so no pin is asked to
    # carry two wires. Face choice matters: a pair of PERPENDICULAR faces
    # (one vertical, one horizontal — e.g. S-W) gets a clean natural route
    # for two diagonally-placed components; a pair of PARALLEL faces (e.g.
    # E-W) only makes sense when the two components are actually aligned
    # on that axis. All four neighbours here sit diagonally from the hub,
    # so every pair below is perpendicular, matching that diagonal.
    connections = [
        (comp2.faces['W'], comp1.faces['S']),   # comp1 is up-left of the hub
        (comp2.faces['N'], comp3.faces['W']),   # comp3 is up-right
        (comp2.faces['E'], comp4.faces['S']),   # comp4 is up-right, closer in
        (comp2.faces['S'], comp5.faces['W']),   # comp5 is down-right
    ]
    # route each stub pair on every face-to-face connection one at a time,
    # passing along the wires placed so far as obstacles so later routes
    # avoid earlier ones.
    wires = []
    for face_a, face_b in connections:
        for stub_a, stub_b in pair_stubs(face_a, face_b):
            w = route(stub_a.pos, stub_b.pos, components, [], wires)
            if w is not None:
                wires.append(w)

    # vias are dropped in afterwards, once the wires are already down, so
    # they're excluded from landing on top of a component or a trace
    # instead of being routed around
    vias = list(distribute_vias(width, height, 400, components, wires, spread=10.0))

    render_svg(components, wires, vias, width, height)


def main_walk(width, height):
    """Grid-based cable growth, populating the whole board: start with one
    hub, put it in a queue, and repeatedly take the component off the
    front, grow a cable out of each of ITS 4 faces, and push whatever new
    component each one plants onto the back of the queue -- breadth-first,
    so the board fills out ring by ring from the hub rather than one
    branch running away with all the space. All of it shares the same
    `blocked` grid, so every cable and every already-placed component
    (including the ones grown just steps ago) is a real obstacle to
    whichever grows next.

    A component with no room left simply produces four scrapped
    attempts (see grow_cable's min_cells) and contributes nothing further
    -- no separate "stop" condition needed, the queue just drains as the
    board fills up.

    Rendering: each lane grow_cable() returns is a real, continuous,
    already-simplified polyline -- drawn as one SVG polyline per lane,
    not reconstructed from a pile of independent cell rectangles. Every
    component grow_cable() plants is drawn the same way as the hub."""
    # snapped to the cell grid, or its faces span one more cell than the wires laid out from them
    hub = Component(Vector2(round((width / 2 - 15) / CELL) * CELL, round((height / 2 - 15) / CELL) * CELL), 30, 30)
    cols, rows, blocked, cell_of = build_board_grid(width, height, [hub])

    components = [hub]
    all_lanes = []
    queue = deque([hub])
    while queue:
        current = queue.popleft()
        for direction in ('N', 'E', 'S', 'W'):
            lanes, far_component = grow_cable(current, direction, cols, rows, blocked, cell_of, turn_chance=0.02,
                                               bias=0.9, turn90_chance=0.02, max_turns90=1,
                                               max_cells=98, min_cells=40)
            if far_component is None:
                continue   # too short to place a component without shrinking below min_cells -- scrapped
            all_lanes.extend(lanes)
            components.append(far_component)
            queue.append(far_component)

    print(f'main_walk(): populated {len(components)} components, {len(all_lanes)} wires')

    lines = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}">']
    lines.append(f'<rect x="0" y="0" width="{width}" height="{height}" fill="black"/>')
    for comp in components:
        lines.append(f'<rect x="{comp.pos.x}" y="{comp.pos.y}" width="{comp.w}" height="{comp.h}" '
                     f'fill="none" stroke="lime"/>')

    for lane in all_lanes:
        points = ' '.join(f'{p.x},{p.y}' for p in lane)
        lines.append(f'<polyline points="{points}" fill="none" stroke="white" stroke-width="0.5"/>')

    lines.append('</svg>')
    with open('out_walk.svg', 'w') as f:
        f.write('\n'.join(lines))


if __name__ == '__main__':
    main(800, 600)
    main_walk(800, 600)
