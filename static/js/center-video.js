// Plays a project card's video when the card crosses the vertical centre
// of the viewport (on scroll, not hover); pauses once it's no longer
// there. Where a video rests (both before its first play and after
// leaving centre) is configurable per-video via data attributes, since
// different clips want different behaviour:
//   data-start-time="4"      time to jump to and play from on entering
//                             centre (default: 0, i.e. play from the top)
//   data-rest-time="4"       time to hold on while not centred (default:
//                             same as data-start-time). The special value
//                             "end" means the video's own last frame —
//                             for a clip that plays once and should stay
//                             finished rather than snapping back.
//
// rootMargin of -45% top/bottom shrinks the observed area down to a thin
// band across the middle ~10% of the viewport — a card only counts as
// "intersecting" while some part of it is passing through that centre
// strip, not just anywhere on screen.
(() => {
  const cards = document.querySelectorAll('.project-card');
  if (!cards.length) return;

  const startTimeFor = (video) => parseFloat(video.dataset.startTime || '0');

  const restTimeFor = (video) => {
    const rest = video.dataset.restTime;
    if (rest === 'end') return video.duration || 0;
    if (rest !== undefined) return parseFloat(rest);
    return startTimeFor(video);
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

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const video = entry.target.querySelector('video');
        if (!video) return;

        if (entry.isIntersecting) {
          video.dataset.everPlayed = 'true';
          video.currentTime = startTimeFor(video);
          video.play().catch(() => {
            // Autoplay-with-sound restrictions don't apply (muted), but
            // ignore any rejection anyway rather than throw on it.
          });
        } else if (video.dataset.everPlayed === 'true') {
          // Only reset a video that has actually played — this callback
          // also fires once immediately for every card on page load
          // (regardless of scroll position), and a video that's never
          // been touched should just keep showing its native poster
          // image rather than have us force a seek onto it.
          goToRest(video);
        }
      });
    },
    { rootMargin: '-45% 0px -45% 0px', threshold: 0 }
  );

  cards.forEach((card) => {
    if (card.querySelector('video')) observer.observe(card);
  });
})();
