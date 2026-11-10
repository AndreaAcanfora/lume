# lume

Falling sand on the GPU. Every cell of a ~1 million cell world is simulated in
WebGPU compute shaders and drawn straight from the same buffer, in the browser,
with nothing to install.

**Demo:** https://andreaacanfora.github.io/lume/ (needs a browser with WebGPU:
recent Chrome, Edge or Safari)

> v0.1 is the simulation. Next comes the light: real-time 2D global
> illumination with radiance cascades, so lava lights up caves and smoke
> casts soft shadows.

## Materials

| Key | Material | Behaviour |
| --- | --- | --- |
| 1 | Sand | falls, piles up at its angle of repose, sinks through water |
| 2 | Water | falls and levels out |
| 3 | Lava | a slow, heavy liquid; turns into stone when it touches water |
| 4 | Smoke | rises, drifts and fades; water boils into it on lava |
| 5 | Wall | fixed |
| 6 | Stone | fixed; what lava leaves behind |
| 0 | Erase | |

Drag to paint. Space pauses, R reloads the opening scene.

## How it works

The update uses a [Margolus neighbourhood](https://en.wikipedia.org/wiki/Block_cellular_automaton):
the grid is cut into 2×2 blocks and one GPU thread owns one block. It reads
four cells, moves matter inside the block (down, then diagonally, then
sideways for fluids) and writes them back. Blocks never overlap, so the update
runs in place with no locks, no atomics and no second buffer. Each step runs
twice, with blocks shifted by one cell the second time, so that matter can
cross block borders.

Every rule is a swap, so matter is never created or lost; only reactions
(lava + water) and fading smoke change the counts. One density order handles
both falling and rising: smoke is lighter than air, so "air falls through
smoke" is how smoke goes up.

A cell is one `u32`: material in bits 0–7, a per-cell shade in 8–15 (grain
and ripple texture) and a lifetime in 16–23.

| File | |
| --- | --- |
| [`src/sim.wgsl`](src/sim.wgsl) | the simulation step |
| [`src/tools.wgsl`](src/tools.wgsl) | brush and per-material census |
| [`src/render.wgsl`](src/render.wgsl) | one pixel per cell |
| [`src/engine.ts`](src/engine.ts) | buffers, pipelines and dispatch |

URL parameters: `?w=1920&h=1080` sets the grid size, `?steps=4` the steps per
frame (up to 4).

## Development

```sh
npm install
npm run dev        # http://localhost:5173
npm run build
npm run test:e2e   # headless Chromium on SwiftShader's WebGPU
```

The end-to-end test paints sand and water into a box, runs 300 steps and
checks that not a single cell of either was created or lost, that the sand
fell and that the water spread out.

## License

MIT
