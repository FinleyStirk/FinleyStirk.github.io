// Site navigation bar: same-page anchor links jump instantly rather than via the page's own smooth scroll-behavior --
// see below. About and Projects are separate pages, so the current one is marked in each page's own HTML (is-active).
(() => {
  const nav = document.querySelector('.site-nav');
  if (!nav) return;

  // pcb-board.js corrects the scroll position on every 'scroll' event to track its own progress along the board's
  // cables, and that correction is deliberately instant (see steer() there -- an animated one lets the real scroll
  // position fall behind). A native smooth scroll-behavior anchor jump fires a 'scroll' event on every one of ITS
  // OWN animation frames too, so our instant correction interrupts it before it can get anywhere -- the two fight
  // and the jump can stall completely instead of reaching its target. One single instant jump doesn't have that
  // problem: it's just the same kind of big, one-off jump pcb-board.js already resyncs to correctly on its own
  // (see the fallback path in its onLineScroll) -- like a scrollbar drag or keyboard Home/End, not an animation to fight.
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    const id = a.getAttribute('href').slice(1);
    const el = id && document.getElementById(id);
    if (!el) return;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const top = Math.max(0, el.getBoundingClientRect().top + window.scrollY - nav.offsetHeight);
      window.scrollTo({ top, left: 0, behavior: 'instant' });
      history.pushState(null, '', '#' + id);
    });
  });
})();
