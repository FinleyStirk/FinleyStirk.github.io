// Tracks the pointer position into --mx/--my custom properties, which the
// background glow in style.css reads to light up the nearby grid/trace
// lines. Throttled to one update per frame; skipped entirely for users who
// prefer reduced motion, and hidden once the pointer leaves the window.
(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const root = document.documentElement;
  let frame = null;

  window.addEventListener('mousemove', (event) => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      root.style.setProperty('--mx', `${event.clientX}px`);
      root.style.setProperty('--my', `${event.clientY}px`);
      frame = null;
    });
  });

  window.addEventListener('mouseleave', () => {
    root.style.setProperty('--mx', '-9999px');
    root.style.setProperty('--my', '-9999px');
  });
})();
