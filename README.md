# lume

Falling sand on the GPU. Every cell of a ~1 million cell world is simulated in
WebGPU compute shaders and drawn straight from the same buffer, in the browser,
with nothing to install.

**Demo:** https://andreaacanfora.github.io/lume/ (needs a browser with WebGPU:
recent Chrome, Edge or Safari)

Since v0.2 the world is lit by real-time 2D global illumination with
[radiance cascades](https://github.com/Raikiri/RadianceCascadesPaper): lava
and lamps light up caves, sand and walls cast soft shadows, light under water
turns blue-green, smoke dims it and fire flickers through it. Press L to
compare with flat colours.

## Materials

| Key | Material | Behaviour |
| --- | --- | --- |
| 1 | Sand | falls, piles up at its angle of repose, sinks through water |
| 2 | Water | falls and levels out |
| 3 | Lava | a slow, heavy liquid; turns into stone when it touches water |
| 4 | Smoke | rises, drifts and fades; water boils into it on lava |
| 5 | Wall | fixed |
| 6 | Stone | fixed; what lava leaves behind |
| 7 | Lamp | fixed; gives off warm light |
| 8 | Fire | rises, flickers and burns out into smoke; sets wood alight, goes out in water |
| 9 | Wood | fixed; burns down to ash when fire or lava touches it |
| | Ash | what burnt wood leaves; a light powder |
| G | Glass | fixed and clear: lets light through with a faint green tint; lava fuses sand into it |
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
| [`src/light.wgsl`](src/light.wgsl) | radiance cascades: scene, jump flood, cascades, resolve |
| [`src/render.wgsl`](src/render.wgsl) | one pixel per cell, lit by the fluence |
| [`src/engine.ts`](src/engine.ts) | buffers, pipelines and dispatch |

URL parameters: `?w=1920&h=1080` sets the grid size, `?steps=4` the steps per
frame (up to 4).

### Light

Light runs at half the grid's resolution in four compute stages:

1. **Scene**: each texel records what it emits and how much light it
   absorbs per texel of travel, per colour channel. Sand, ash, wood, walls,
   stone, lava and lamps are opaque. Water absorbs red first, so light
   under water turns blue-green; smoke greys light out by its density; glass
   lets it through with a faint green tint; fire glows and barely absorbs.
2. **Jump flood**: every texel learns where the nearest non-empty texel is,
   so rays leap across empty air; through water, smoke and fire they step
   one texel at a time, gathering light and losing some as they go.
3. **Cascades**: cascade 0 has a probe every 2 texels casting 4 short rays.
   Each cascade above has probes twice as far apart, 4 times as many rays
   and rays 4 times as long. They are traced from the top down: whatever a
   ray does not block, it takes from the matching rays one cascade up,
   blended between the four nearest upper probes and tinted by what the ray
   passed through. A cascade texel packs radiance and transmittance (both
   RGB) into half floats. Rays that leave the
   world see a dim night sky.
4. **Resolve**: the 4 rays of each cascade-0 probe are averaged into the
   light that reaches it, which the renderer samples smoothly.

The cost is the same for one light or a thousand.

## Development

```sh
npm install
npm run dev        # http://localhost:5173
npm run build
npm run test:e2e   # headless Chromium on SwiftShader's WebGPU
```

The end-to-end test paints sand and water into a box, runs 300 steps and
checks that not a single cell of either was created or lost, that the sand
fell and that the water spread out. It then places a lamp beside a wall and
checks that its light fades with distance and that the wall casts a shadow,
that the same lamp seen through water is dimmer and bluer and through smoke
dimmer, that fire burns a log down to ash, that lava fuses sand into glass
and that light passes through glass but not through a wall.

## License

MIT
