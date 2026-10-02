# site-tools

Scripts that capture the media of the landing site in `docs/` (served by
GitHub Pages from `main` `/docs` at https://bendechrai.github.io/agentboard/).
They have their own `package.json`, so Puppeteer is never a dependency of
agentboard itself. Install once with `npm ci` in this directory; ffmpeg must
be on the PATH.

Preview the site with
`python3 -m http.server 8765 --bind 127.0.0.1 --directory docs` from the
repository root, then:

- `node page.mjs http://127.0.0.1:8765/ shot.png [width] [height] [light|dark] [fullPage 0|1] [waitMs]`:
  a screenshot of the page.
- `node og.mjs http://127.0.0.1:8765/ og.png <t>`: the share image, with the
  diorama frozen at loop time `t` (`docs/og.png` uses 4.7, mid claim race;
  pass `light 1440 900 hero` for the plain hero, as in `docs/media/hero.jpg`).
- `node timeline.mjs http://127.0.0.1:8765/`: the diorama's story as the
  event tape lists it, and any script warnings (a card picked up before it
  has landed).
- `AB=<agentboard> TASKS=add-search-tasks.md node record.mjs <scratch dir> serve.mp4`:
  builds a fresh board in `<scratch dir>` (deleted first), drives a scripted
  session through the real CLI against `agentboard serve`, and records it
  (`docs/media/serve.mp4`). `AB` is the agentboard command to run, for
  example a script that runs `node <repo>/dist/cli.js "$@"`.
- `node icons.mjs ../docs/favicon.svg ../docs`: the PNG favicons.
