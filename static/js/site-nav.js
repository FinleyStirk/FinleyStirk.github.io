// Site navigation bar: marks the link for the section in view, and keeps the placeholder links from jumping the
// page to the top when clicked (an href of "#" would). Same-page anchor links (#about, #projects, and anything
// else on the page like the "robotics" mention in the about text) jump instantly rather than via the page's own
// smooth scroll-behavior -- see below.
(() => {
  const nav = document.querySelector('.site-nav');
  if (!nav) return;

  nav.querySelectorAll('[data-filler]').forEach((a) => {
    a.addEventListener('click', (e) => e.preventDefault());
  });

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

  const about = nav.querySelector('[data-nav="about"]');
  const projects = nav.querySelector('[data-nav="projects"]');
  const target = document.getElementById('projects');
  if (!about || !projects || !target) return;

  let frame = null;
  function update() {
    frame = null;
    // "Projects" becomes current once its heading has come up into the top part of the window
    const inProjects = target.getBoundingClientRect().top < window.innerHeight * 0.5;
    projects.classList.toggle('is-active', inProjects);
    about.classList.toggle('is-active', !inProjects);
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  update();
})();
