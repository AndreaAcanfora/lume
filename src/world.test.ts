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
