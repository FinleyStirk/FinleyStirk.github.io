// Tracks the pointer position into --mx/--my custom properties, which the
// background glow in style.css reads to light up the nearby grid/trace
// lines. Throttled to one update per frame; skipped entirely for users who
// prefer reduced motion, and hidden once the pointer leaves the window.
//
// Also tracks scroll position into --scroll-y. The glow layer is
// position: fixed (so its mask stays viewport-relative to the cursor),
// which means its own background can't scroll the way body's real grid
// does — left alone, it'd show a frozen copy of whatever pattern was
// visible before you scrolled. Feeding --scroll-y into its
// background-position (see style.css) shifts the glow's pattern to match
// wherever the page has actually scrolled to, so it stays locked to the
// real grid lines instead of drifting away from them.
(() => {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const root = document.documentElement;
  let moveFrame = null;
  let scrollFrame = null;

  window.addEventListener('mousemove', (event) => {
    if (moveFrame) return;
    moveFrame = requestAnimationFrame(() => {
      // viewport coords for the fixed body::after grid glow
      root.style.setProperty('--mx', `${event.clientX}px`);
      root.style.setProperty('--my', `${event.clientY}px`);
      // document coords for the absolutely-positioned #circuit-board-glow
      // layer, whose mask is relative to the top of the page, not the viewport
      root.style.setProperty('--cb-mx', `${event.pageX}px`);
      root.style.setProperty('--cb-my', `${event.pageY}px`);
      moveFrame = null;
    });
  });

  window.addEventListener('mouseleave', () => {
    root.style.setProperty('--mx', '-9999px');
    root.style.setProperty('--my', '-9999px');
    root.style.setProperty('--cb-mx', '-9999px');
    root.style.setProperty('--cb-my', '-9999px');
  });

  const updateScroll = () => {
    root.style.setProperty('--scroll-y', `${window.scrollY}px`);
    scrollFrame = null;
  };

  window.addEventListener('scroll', () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(updateScroll);
  }, { passive: true });

  updateScroll();
})();
