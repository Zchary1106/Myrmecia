# Myrmecia demo video

A reproducible pipeline that captures the live, seeded Myrmecia dashboard with
Playwright and composes a polished product demo with Remotion.

Output: [`docs/demo/myrmecia-demo.mp4`](../docs/demo/myrmecia-demo.mp4) — 1280×720, ~37s, h264.

## Pipeline

1. **Seed + boot** — seeds the deterministic demo database and starts the API
   (`:3000`) and dashboard (`:5173`).
2. **Capture** — Playwright clicks through key dashboard pages (Command Center,
   Work Queue, Pipelines, Teams, Memory, Costs, Audit) and screenshots each into
   `public/frames/`.
3. **Render** — Remotion composes an intro, per-page scenes (browser card + Ken
   Burns + caption lower-thirds), and an outro into `out/myrmecia-demo.mp4`.

The captioned scenes are defined in [`shots.json`](shots.json).

## Run it

```bash
cd demo-video
npm install
npx playwright install chromium   # if the headless shell isn't present

# Boot the seeded demo, capture screenshots, then tear the servers down.
bash run.sh

# Render the video from the captured frames.
npm run render
# -> out/myrmecia-demo.mp4
```

## Notes

- The capture/render reuse the repo's already-installed Playwright Chromium.
- If a system HTTP proxy intercepts loopback, the scripts strip proxy env vars
  and pass `--no-proxy-server` so the browser loads `localhost` directly.
- `public/frames/`, `out/`, and `demo.db*` are gitignored; only the pipeline
  source and the final committed mp4 under `docs/demo/` are tracked.
