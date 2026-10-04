The footage for /automate: the page scrubs through these frames as you scroll.

  frame_0001.webp, frame_0002.webp, ...  the frames, numbered from 1, no gaps
  manifest.json                           "count" (how many frames) and "fps"
  markers.json                            caption timings: marker name -> frame number

To swap in a new render (e.g. the final Cycles one): replace everything in this
folder with the new frames (renamed to frame_NNNN.webp), the new render's
markers.json, and update "count" and "fps" in manifest.json. Nothing else needs
changing -- the scroll length follows the footage's duration (count / fps).

The frames come from render/render.py --frames in the Chess Robot repo; it
writes them as <name>/<name>_NNNN.webp with markers.json alongside.

Phones get ../frames_mobile/ instead: the same layout, but at most 24 fps and
1280 px wide. After swapping this folder, rebuild it from the Chess Robot repo:

  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
      -P render/make_mobile_frames.py -- \
      ~/Documents/FinleyStirk06.github.io/automate/frames \
      ~/Documents/FinleyStirk06.github.io/automate/frames_mobile

(If frames_mobile/ is missing, phones just use this folder.)
