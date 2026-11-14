import { describe, expect, it } from "vitest";
import { Material } from "./engine";
import { openingScene } from "./world";

const W = 256;
const H = 160;
const mat = (c: number) => c & 0xff;

function cellsOf(cells: Uint32Array, width: number, m: number) {
  const out: { x: number; y: number }[] = [];
  cells.forEach((c, i) => {
    if (mat(c) === m) out.push({ x: i % width, y: Math.floor(i / width) });
  });
  return out;
}

describe("openingScene", () => {
  it("is the same for the same seed and different for another", () => {
    expect(openingScene(W, H, 7)).toEqual(openingScene(W, H, 7));
    expect(openingScene(W, H, 7)).not.toEqual(openingScene(W, H, 8));
  });

  it("fills exactly width × height cells with known materials", () => {
    for (const [w, h] of [[64, 40], [W, H], [512, 320], [333, 211]]) {
      const cells = openingScene(w, h);
      expect(cells.length).toBe(w * h);
      const known = new Set<number>(Object.values(Material));
      expect([...cells].every((c) => known.has(mat(c)))).toBe(true);
    }
  });

  it("has stone hills under everything, with a solid bottom row", () => {
    const cells = openingScene(W, H);
    for (let x = 0; x < W; x++) expect(mat(cells[(H - 1) * W + x]!)).toBe(Material.Stone);
  });

  it("puts lava above a basin of water, and the water stays inside the basin", () => {
    const cells = openingScene(W, H);
    const water = cellsOf(cells, W, Material.Water);
    const lava = cellsOf(cells, W, Material.Lava);
    expect(water.length).toBeGreaterThan(100);
    expect(lava.length).toBeGreaterThan(20);
    expect(Math.max(...lava.map((c) => c.y))).toBeLessThan(Math.min(...water.map((c) => c.y)));
    // Every water cell rests on water or stone, never on air.
    for (const { x, y } of water) {
      const below = mat(cells[(y + 1) * W + x]!);
      expect([Material.Water, Material.Stone]).toContain(below);
    }
  });

  it("has sand on a wall ledge on the left and two trees on the right, one burning", () => {
    const cells = openingScene(W, H);
    const sand = cellsOf(cells, W, Material.Sand);
    const wall = cellsOf(cells, W, Material.Wall);
    const wood = cellsOf(cells, W, Material.Wood);
    const fire = cellsOf(cells, W, Material.Fire);
    expect(Math.max(...sand.map((c) => c.x))).toBeLessThan(W / 2);
    expect(Math.max(...sand.map((c) => c.y))).toBeLessThan(Math.min(...wall.map((c) => c.y)));
    expect(Math.min(...wood.map((c) => c.x))).toBeGreaterThan(W / 2);
    expect(fire.length).toBeGreaterThan(0);
    // Fire only around the first tree, with a lifetime in the upper byte.
    const firstTree = Math.floor(W * 0.8);
    for (const { x } of fire) expect(Math.abs(x - firstTree)).toBeLessThanOrEqual(6);
    for (const c of cells) if (mat(c) === Material.Fire) expect(c >>> 16).toBeGreaterThanOrEqual(60);
  });
});

describe("openingScene solids", () => {
  const SOLIDS = new Set<number>([Material.Wall, Material.Stone, Material.Glass, Material.Wood]);
  const FLUIDS = new Set<number>([Material.Empty, Material.Water, Material.Lava, Material.Smoke, Material.Fire]);

  it("start fully supported", () => {
    const cells = openingScene(W, H);
    for (const c of cells) if (SOLIDS.has(mat(c))) expect(c >>> 16 & 0xff).toBe(255);
  });

  // The same rules as hold() in sim.wgsl, without the distance limit: a solid
  // is held by the ground, by a non-fluid under it, by a solid it stands on,
  // or by the same material beside or above it.
  it.each([[W, H], [1280, 800], [640, 400]])("nothing hangs in the air at %ix%i", (w, h) => {
    const cells = openingScene(w, h);
    const m = (x: number, y: number) => mat(cells[y * w + x]!);
    const held = new Uint8Array(w * h);
    const queue: number[] = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!SOLIDS.has(m(x, y))) continue;
        const below = y + 1 < h ? m(x, y + 1) : -1;
        if (y === h - 1 || (!SOLIDS.has(below) && !FLUIDS.has(below))) {
          held[y * w + x] = 1;
          queue.push(y * w + x);
        }
      }
    while (queue.length) {
      const i = queue.pop()!;
      const x = i % w, y = Math.floor(i / w);
      const here = m(x, y);
      const next: [number, number, boolean][] = [
        [x, y - 1, true], // anything solid standing on it
        [x - 1, y, false],
        [x + 1, y, false],
        [x, y + 1, false], // hanging from it
      ];
      for (const [nx, ny, anySolid] of next) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        const nm = m(nx, ny);
        if (held[j] || !SOLIDS.has(nm) || (!anySolid && nm !== here)) continue;
        held[j] = 1;
        queue.push(j);
      }
    }
    const loose = [...cells.keys()].filter((i) => SOLIDS.has(mat(cells[i]!)) && !held[i]);
    expect(loose.length, `loose solids, e.g. at ${loose.slice(0, 3).map((i) => `(${i % w},${Math.floor(i / w)})`).join(" ")}`).toBe(0);
  });
});
