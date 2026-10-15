// Generative PCB page background: the board worker. Runs pcb-gen.js's generate(), toSvg() and buildNet() off the page's main
// thread, so building a board (100s of ms, seconds on a slow machine) never freezes scrolling or input. pcb-board.js sends it the
// page's measurements and gets back the board, its SVG and its power network; it falls back to building on the main thread if
// this fails. The page passes the exact pcb-gen.js URL it loaded (?gen=...), so the worker runs the same version.
importScripts(new URL(self.location.href).searchParams.get('gen'));

self.onmessage = ({ data }) => {
  const { id, els, width, height, seed, opts, grain, cellStep } = data;
  const { generate, toSvg, buildNet } = self.PCBGen;
  const g = generate(els, width, height, seed, opts);
  const net = buildNet(g, cellStep);
  // A wire is an array of points with fields of its own (src, dst, gsize, cable); posting an array keeps only its items, so
  // they travel alongside, in stripLanes-then-viaLanes order, and pcb-board.js puts them back. (cable is the same object the
  // board's cables list holds: one message keeps shared objects shared.) buildNet's per-wire metrics (cum, len, bb) are left
  // behind: the page works them out again only for the wires it needs them for.
  const laneProps = g.stripLanes.concat(g.viaLanes).map((l) => ({ src: l.src, dst: l.dst, gsize: l.gsize, cable: l.cable }));
  // the network's typed arrays are handed over, not copied
  const transfer = [...new Set(Object.values(net).filter(ArrayBuffer.isView).map((a) => a.buffer))];
  self.postMessage({ id, g, net, laneProps, svg: toSvg(g, grain) }, transfer);
};
