// Site navigation bar: marks the link for the section in view, and keeps the placeholder links from jumping the
// page to the top when clicked (an href of "#" would). The anchor links (#about, #projects) scroll on their own,
// smoothly, via CSS -- see the .site-nav rules in style.css.
(() => {
  const nav = document.querySelector('.site-nav');
  if (!nav) return;

  nav.querySelectorAll('[data-filler]').forEach((a) => {
    a.addEventListener('click', (e) => e.preventDefault());
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
