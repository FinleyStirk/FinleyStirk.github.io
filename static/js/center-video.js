// Controls how project-card videos start playing. Chosen per card via data
// attributes on the <video> — a hover mode, and a scroll mode with two
// independent knobs:
//
//   data-hover-trigger    Plays on mouseenter, pauses in place on
//                         mouseleave (no seeking either way — resumes
//                         wherever it left off). The card starts on its
//                         poster image (never autoplayed by scroll), and
//                         since these clips aren't looped, reaching the end
//                         just holds the last frame — calling play() again
//                         from an already-ended video has nothing left to
//                         advance, so re-hovering after the end is a no-op.
//
//   (default)             Plays when the card crosses the vertical centre
//                         of the viewport (on scroll, not hover). Two
//                         independent attributes control seeking:
//                           data-start-time="4"  if present, seek to this
//                                                 time on the very first
//                                                 time the card ever enters
//                                                 centre, then play — for a
//                                                 clip that should skip an
//                                                 uninteresting intro once
//                                                 (add the `loop` attribute
//                                                 too if it should keep
//                                                 looping for as long as it
//                                                 stays centred). Every
//                                                 later entry — after
//                                                 leaving and scrolling
//                                                 back, say — just resumes
//                                                 from wherever it paused,
//                                                 same as if the attribute
//                                                 were absent.
//                           data-rest-time="4"    if present, seek to this
//                                                 time (and pause) on
//                                                 leaving centre. "end"
//                                                 means the video's own
//                                                 last frame. If absent,
//                                                 leaving just pauses in
//                                                 place — no seeking — so
//                                                 a later re-entry resumes
//                                                 from the same spot
//                                                 rather than restarting.
//
// rootMargin of -45% top/bottom shrinks the observed area down to a thin
// band across the middle ~10% of the viewport — a card only counts as
// "intersecting" while some part of it is passing through that centre
// strip, not just anywhere on screen.
(() => {
  const cards = document.querySelectorAll('.project-card');
  if (!cards.length) return;

  const startTimeFor = (video) => parseFloat(video.dataset.startTime);

  const restTimeFor = (video) => {
    const rest = video.dataset.restTime;
    if (rest === 'end') return video.duration || 0;
    return parseFloat(rest);
  };

  const goToRest = (video) => {
    video.pause();
    const apply = () => {
      video.currentTime = restTimeFor(video);
    };
    if (video.readyState >= 1) {
      apply(); // HAVE_METADATA or better — duration/seeking already available
    } else {
      video.addEventListener('loadedmetadata', apply, { once: true });
    }
  };

  const play = (video) => {
    video.play().catch(() => {
      // Autoplay-with-sound restrictions don't apply (muted), but ignore
      // any rejection anyway rather than throw on it.
    });
  };

  const scrollCards = [];

  cards.forEach((card) => {
    const video = card.querySelector('video');
    if (!video) return;

    if (video.dataset.hoverTrigger !== undefined) {
      card.addEventListener('mouseenter', () => play(video));
      card.addEventListener('mouseleave', () => video.pause());
      return;
    }

    scrollCards.push(card);
  });

  if (!scrollCards.length) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const video = entry.target.querySelector('video');
        if (!video) return;

        if (entry.isIntersecting) {
          if (video.dataset.startTime !== undefined && video.dataset.everPlayed === undefined) {
            video.currentTime = startTimeFor(video);
          }
          video.dataset.everPlayed = 'true';
          play(video);
        } else if (video.dataset.restTime !== undefined) {
          goToRest(video);
        } else {
          video.pause();
        }
      });
    },
    { rootMargin: '-45% 0px -45% 0px', threshold: 0 }
  );

  scrollCards.forEach((card) => observer.observe(card));
})();
