"""Very basic renderer for my_code.py's Stub/Component model. Not clever:
every component is a rectangle, every stub is a dot, and every Wire you
hand it is drawn as a plain polyline through its segments. No routing, no
collision avoidance — the wire's route is whatever my_code.py built it
with (currently: a straight line, or one bend via wire()).

Doesn't import my_code.py — it just expects things shaped like it:
component.pos (a Vector2, top-left corner) / .w / .h, component.faces
(dict of direction -> face), face.stubs (list of Stub), stub.pos (a
Vector2); wire.segments (a list of Vector2 points, drawn in order).

Usage, from your own script:

    from renderer import render_svg
    render_svg([comp1, comp2], [w], width=800, height=600)
"""


def render_svg(components, wires, vias, width, height, path='out.svg'):
    """Draw every component as a rectangle, every stub as a dot, and every
    wire as a polyline through its segments. `width`/`height` are the whole
    image's size in pixels; all coordinates are used as-is — same screen
    units. Writes an SVG file to `path` and also returns the SVG text.
    """
    stubs = [stub for c in components for face in c.faces.values() for stub in face.stubs]

    lines = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}">']
    lines.append(f'<rect x="0" y="0" width="{width}" height="{height}" fill="black"/>')

    for c in components:
        lines.append(
            f'<rect x="{c.pos.x}" y="{c.pos.y}" '
            f'width="{c.w}" height="{c.h}" fill="none" stroke="white"/>')

    for w in wires:
        points = ' '.join(f'{p.x},{p.y}' for p in w.segments)
        lines.append(f'<polyline points="{points}" fill="none" stroke="white"/>')

    for stub in stubs:
        lines.append(f'<circle cx="{stub.pos.x}" cy="{stub.pos.y}" r="1" fill="white"/>')

    for via in vias:
        lines.append(f'<circle cx="{via.x}" cy="{via.y}" r="1" fill="none" stroke="white"/>')

    lines.append('</svg>')
    svg = '\n'.join(lines)
    with open(path, 'w') as f:
        f.write(svg)
    return svg
