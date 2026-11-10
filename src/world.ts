import { Material } from "./engine";

/** Small deterministic PRNG so the opening scene is the same on every load. */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The opening scene: rolling stone hills, a basin of water with lava about
 * to drop into it, and a block of sand on a ledge that collapses and pours
 * off the edge.
 */
export function openingScene(width: number, height: number, seed = 7): Uint32Array {
  const rand = mulberry32(seed);
  const cells = new Uint32Array(width * height);
  const cell = (m: number) => m | (Math.floor(rand() * 256) << 8);
  const set = (x: number, y: number, m: number) => {
    if (x >= 0 && y >= 0 && x < width && y < height) cells[y * width + x] = cell(m);
  };

  // Hills.
  const ground: number[] = [];
  for (let x = 0; x < width; x++) {
    const t = x / width;
    const h =
      0.18 +
      0.06 * Math.sin(t * Math.PI * 2.2 + 0.6) +
      0.03 * Math.sin(t * Math.PI * 7.1 + 1.3) +
      0.01 * Math.sin(t * Math.PI * 23.0);
    // A basin in the middle for the water.
    const basin = Math.max(0, 1 - Math.abs(t - 0.52) / 0.12);
    ground.push(Math.floor(height * (1 - h + 0.1 * basin * basin)));
  }
  for (let x = 0; x < width; x++) {
    for (let y = ground[x]; y < height; y++) set(x, y, Material.Stone);
  }

  // Water fills the basin up to the lower of its two rims (larger y is lower).
  const rim = Math.max(ground[Math.floor(width * 0.4)], ground[Math.floor(width * 0.64)]);
  for (let x = Math.floor(width * 0.4); x < Math.floor(width * 0.64); x++) {
    for (let y = rim; y < ground[x]; y++) set(x, y, Material.Water);
  }

  // A blob of lava hanging over the right end of the basin.
  const lx = Math.floor(width * 0.6);
  const ly = Math.floor(height * 0.35);
  const lr = Math.floor(height * 0.04);
  for (let y = -lr; y <= lr; y++) {
    for (let x = -lr * 2; x <= lr * 2; x++) {
      if ((x / 2) ** 2 + y ** 2 <= lr * lr) set(lx + x, ly + y, Material.Lava);
    }
  }

  // A wall ledge on the left with a dune of sand on top.
  const ledgeY = Math.floor(height * 0.42);
  const ledgeX0 = Math.floor(width * 0.08);
  const ledgeX1 = Math.floor(width * 0.3);
  for (let x = ledgeX0; x < ledgeX1; x++) {
    for (let y = ledgeY; y < ledgeY + 4; y++) set(x, y, Material.Wall);
  }
  // A tall block of sand on it, far steeper than sand can stand.
  const blockH = Math.floor(height * 0.22);
  for (let x = ledgeX0 + Math.floor((ledgeX1 - ledgeX0) * 0.3); x < ledgeX1; x++) {
    for (let y = ledgeY - blockH; y < ledgeY; y++) set(x, y, Material.Sand);
  }

  return cells;
}
