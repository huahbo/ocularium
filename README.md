# Ocularium — Anatomy of vision, in 3D

An interactive 3D anatomy lab for the human eye: peel through 23 layered
structures, take guided tours and quizzes, compare clinical conditions, and
watch the aqueous humour flow — all in the browser.

> **Acknowledgement** — Ocularium grew out of the
> [thebuggeddev/anatomy](https://github.com/thebuggeddev/anatomy) 3D anatomy
> explorer (MIT-licensed Three.js project). We are grateful to the original
> author for the foundation: this project is a deep rework that narrows the
> scope to the human eye and adds interactive teaching features on top.

## Features

- **Layered 3D specimen** — the HRA eye model (23 structures) with per-layer
  peel, opacity control, and three view modes (Layered / Anatomy / Outflow).
- **Structure search** — find any structure and fly the camera to it.
- **Interactive 3D quiz** — 10 Identify/Find questions answered by clicking the
  model.
- **Guided anatomy tour** — a 10-stop light-path journey with narration.
- **Clinical conditions** — material + geometry simulations of cataract,
  glaucoma, macular degeneration, and retinal detachment, with a one-tap
  normal/condition A/B compare.
- **Aqueous flow animation** — the ciliary body → pupil → trabecular meshwork →
  Schlemm's canal path rendered as moving particles.
- **Viewer tools** — rotate, zoom, isolate, cross-section (draggable cut +
  angle), X-Ray see-through, wireframe layers, compare, reset.
- **Fast** — geometry is baked and Draco-compressed at build time: 1.2s load,
  2.3 MB model.

## Tech stack

- Next.js 16 / React 19 / vinext (Cloudflare Workers)
- Three.js 0.185 + GSAP
- Procedural anatomy textures (value noise, 1024px conjunctiva) + photoreal
  external maps
- gltf-transform build pipeline (`scripts/bake-eye.cjs`) — UV generation,
  Loop subdivision, and Draco compression happen at build time

## Development

```bash
npm install
npm run dev        # local dev server
npm run build      # production build (type-check + build)
npm test           # build + SSR render tests
node scripts/bake-eye.cjs   # regenerate the baked eye GLB (see HANDOFF.md)
```

## Attribution

The fine anatomical eye model (23 layered structures) is derived from the
**Human Reference Atlas (HRA)** 3D Reference Object Library, built from the US
National Library of Medicine's Visible Human Project dataset:

- **HRA 3D Reference Object Library** — Cyberinfrastructure for Network
  Science Center, Indiana University, funded by the National Institutes of
  Health (HuBMAP). Licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  Source: https://humanatlas.io/3d-reference-library

Model-based research aid, not clinical recommendation.

Texture attributions:

- **Sclera** vessels: RoboPoets/digital_human (MIT),
  https://github.com/RoboPoets/digital_human
- **Retina** fundus photograph: Augenarztpraxis Dr. med. Stephan Kaut, CC0,
  Wikimedia Commons (derived from `Fundus-photograph-left.jpg`)

## License

Project code and UI: original work. Model and textures remain under their
respective licenses above. See `HANDOFF.md` for development notes.
