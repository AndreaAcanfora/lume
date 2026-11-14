// End-to-end check in headless Chromium: the page boots on WebGPU, the
// simulation moves matter without creating or losing any, and nothing logs
// an error. Run after `npm run build`. Drawing is switched off (?draw=0):
// headless Chromium loses the WebGPU device when it presents a canvas.
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT) || 4317;
const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
  stdio: ["ignore", "pipe", "inherit"],
  detached: true, // own process group, so stopping it also stops vite under npx
});
const stopServer = () => {
  try {
    process.kill(-server.pid);
  } catch {}
};
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => String(d).includes(String(PORT)) && resolve());
  server.on("exit", reject);
});

// CHROMIUM_PATH lets a machine reuse a browser it already has.
const browser = await chromium
  .launch({
    // Full Chromium in new headless mode; the headless shell has no WebGPU.
    channel: process.env.CHROMIUM_PATH ? undefined : "chromium",
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=swiftshader", "--use-webgpu-adapter=swiftshader"],
  })
  .catch((error) => {
    stopServer();
    throw error;
  });
let failed = false;
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failed = true;
};

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  // Brush strokes draw their per-cell dice from Math.random: seed it so every
  // run simulates the same world and the thresholds below are not luck.
  await page.addInitScript(() => {
    let seed = 0x1ce;
    Math.random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  });
  await page.goto(`http://localhost:${PORT}/?w=256&h=160&draw=0`);
  await page.waitForFunction(() => window.lume, null, { timeout: 20000 });

  const result = await page.evaluate(async () => {
    const { engine, pause } = window.lume;
    pause(true);
    engine.clear();
    // A box with a floor and a pillar, with sand and water poured in.
    engine.paint(1, [0, 157], [255, 157], 3); // wall floor
    engine.paint(1, [2, 0], [2, 150], 2); // left wall
    engine.paint(1, [253, 0], [253, 150], 2); // right wall
    engine.paint(6, [128, 60], [128, 100], 4); // stone pillar
    for (let i = 0; i < 8; i++) engine.paint(2, [60, 10], [100, 30], 12);
    for (let i = 0; i < 8; i++) engine.paint(3, [150, 10], [210, 30], 12);
    // Mean height (row) of a material and how wide it lies.
    const shape = async (m) => {
      const cells = await engine.read();
      let n = 0, sumY = 0, minX = Infinity, maxX = -Infinity;
      for (let i = 0; i < cells.length; i++) {
        if ((cells[i] & 0xff) !== m) continue;
        const x = i % engine.width, y = Math.floor(i / engine.width);
        n++; sumY += y; minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      }
      return { meanY: sumY / n, span: maxX - minX };
    };
    const before = await engine.census();
    const sandBefore = await shape(2), waterBefore = await shape(3);
    for (let i = 0; i < 300; i++) engine.tick(2, false);
    await engine.idle();
    const after = await engine.census();
    const sandAfter = await shape(2), waterAfter = await shape(3);
    return { before, after, sandBefore, sandAfter, waterBefore, waterAfter };
  });

  const { before, after, sandBefore, sandAfter, waterBefore, waterAfter } = result;
  console.log("before", before);
  console.log("after ", after);
  check(before.sand > 500 && before.water > 500, "the brush painted sand and water");
  check(after.sand === before.sand, `sand is conserved (${before.sand} → ${after.sand})`);
  check(after.water === before.water, `water is conserved (${before.water} → ${after.water})`);
  check(sandAfter.meanY > sandBefore.meanY + 50, `sand fell (mean row ${sandBefore.meanY.toFixed(0)} → ${sandAfter.meanY.toFixed(0)})`);
  check(waterAfter.span > waterBefore.span + 20, `water spread out (width ${waterBefore.span} → ${waterAfter.span})`);
  check(after.wall === before.wall && after.stone === before.stone, "walls and stone are conserved");

  // Light: a lamp in an empty world lights its surroundings, less with
  // distance, and a wall casts a shadow.
  const light = await page.evaluate(async () => {
    const { engine } = window.lume;
    engine.clear();
    engine.paint(7, [60, 80], [60, 80], 4); // lamp
    engine.paint(1, [120, 40], [120, 120], 3); // wall to its right
    const lum = async (x, y) => (await engine.lightAt(x, y)).reduce((a, b) => a + b, 0);
    const points = { near: [76, 80], far: [60, 20], lit: [110, 80], shadow: [140, 80] };
    const sample = async () => {
      engine.light();
      const out = {};
      for (const [k, [x, y]] of Object.entries(points)) out[k] = await lum(x, y);
      return out;
    };
    // The lamp's own contribution: with it minus without it (the sky).
    const withLamp = await sample();
    engine.paint(0, [60, 80], [60, 80], 5);
    const withoutLamp = await sample();
    return Object.fromEntries(Object.keys(points).map((k) => [k, withLamp[k] - withoutLamp[k]]));
  });
  console.log("light", light);
  check(light.near > light.far && light.far > 0, "light fades with distance");
  check(light.lit > light.shadow * 2, "a wall casts a shadow");

  // Media: the same lamp seen through water turns blue-green and dimmer;
  // seen through smoke it is dimmer.
  const media = await page.evaluate(async () => {
    const { engine } = window.lume;
    const at = (x, y) => engine.lightAt(x, y);
    const contribution = async (fill) => {
      engine.clear();
      fill();
      engine.paint(7, [128, 80], [128, 80], 4);
      engine.light();
      const right = await at(170, 80); // across the medium
      const left = await at(86, 80); // same distance, open air
      engine.paint(0, [128, 80], [128, 80], 5);
      engine.light();
      const r0 = await at(170, 80);
      const l0 = await at(86, 80);
      return { through: right.map((v, i) => v - r0[i]), open: left.map((v, i) => v - l0[i]) };
    };
    const fillRect = (m) => {
      for (let i = 0; i < 16; i++) for (let y = 66; y <= 94; y += 2) engine.paint(m, [138, y], [175, y], 2);
    };
    return { water: await contribution(() => fillRect(3)), smoke: await contribution(() => fillRect(5)) };
  });
  console.log("media", JSON.stringify(media));
  const sum = (v) => v[0] + v[1] + v[2];
  const { water, smoke } = media;
  check(
    sum(water.through) < sum(water.open) && water.through[2] / water.through[0] > 1.5 * (water.open[2] / water.open[0]),
    "light through water is dimmer and bluer",
  );
  check(sum(smoke.through) < 0.8 * sum(smoke.open), "smoke dims light");

  // Fire burns wood down to ash and smoke.
  const fire = await page.evaluate(async () => {
    const { engine } = window.lume;
    engine.clear();
    engine.paint(1, [0, 157], [255, 157], 3);
    engine.paint(1, [102, 120], [102, 155], 2); // two posts (wood falls now)
    engine.paint(1, [138, 120], [138, 155], 2);
    engine.paint(9, [100, 110], [140, 110], 10); // a log on them
    const before = await engine.census();
    engine.paint(8, [95, 125], [145, 125], 6); // fire under it
    for (let i = 0; i < 800; i++) engine.tick(2, false); // fire runs at half speed per step
    await engine.idle();
    return { before, after: await engine.census() };
  });
  console.log("fire", JSON.stringify(fire.after));
  // Burnt-through pieces now drop below the flames and go out, so less of the
  // log burns than when wood was fixed in place.
  check(fire.after.wood < fire.before.wood * 0.6, `fire burns wood (${fire.before.wood} → ${fire.after.wood})`);
  check(fire.after.ash > 0, "burnt wood leaves ash");

  // Lava fuses sand into glass, and glass lets light through.
  const glass = await page.evaluate(async () => {
    const { engine } = window.lume;
    engine.clear();
    engine.paint(1, [0, 157], [255, 157], 3);
    for (let i = 0; i < 12; i++) engine.paint(4, [80, 140], [170, 140], 6); // lava pool
    for (let i = 0; i < 12; i++) engine.paint(2, [90, 110], [160, 110], 8); // sand on it
    for (let i = 0; i < 300; i++) engine.tick(2, false);
    await engine.idle();
    const fused = (await engine.census()).glass;

    const behind = async (m) => {
      engine.clear();
      engine.paint(m, [120, 40], [120, 120], 3);
      engine.paint(7, [60, 80], [60, 80], 4);
      engine.light();
      const lit = (await engine.lightAt(140, 80)).reduce((a, b) => a + b, 0);
      engine.paint(0, [60, 80], [60, 80], 5);
      engine.light();
      return lit - (await engine.lightAt(140, 80)).reduce((a, b) => a + b, 0);
    };
    return { fused, throughGlass: await behind(11), throughWall: await behind(1) };
  });
  console.log("glass", JSON.stringify(glass));
  check(glass.fused > 0, `lava fuses sand into glass (${glass.fused} cells)`);
  check(glass.throughGlass > 0.02 && glass.throughWall === 0, "glass lets light through, a wall does not");

  // Water levels out flat; glass and stone fall in one piece.
  const gravity = await page.evaluate(async () => {
    const { engine } = window.lume;
    const W = engine.width;
    const run = async (ticks) => {
      for (let i = 0; i < ticks; i++) engine.tick(2, false);
      await engine.idle();
      return engine.read();
    };
    // A tall block of water dropped at one end of a box.
    engine.clear();
    engine.paint(1, [0, 157], [255, 157], 3);
    engine.paint(1, [6, 0], [6, 150], 2);
    engine.paint(1, [249, 0], [249, 150], 2);
    for (let i = 0; i < 10; i++) engine.paint(3, [30, 20], [70, 60], 14);
    let cells = await run(800);
    const tops = [];
    for (let x = 10; x < 246; x++) {
      let top = -1;
      for (let y = 0; y < 150; y++) if ((cells[y * W + x] & 0xff) === 3) { top = y; break; }
      tops.push(top);
    }
    const wet = tops.filter((t) => t >= 0);
    const water = { columns: wet.length, of: tops.length, bumps: Math.max(...wet) - Math.min(...wet) };

    // A glass slab and a stone slab in mid-air; the stone one over a pool.
    const box = (m) => {
      let n = 0, top = 999, bottom = 0, left = 999, right = 0;
      cells.forEach((c, i) => {
        if ((c & 0xff) !== m) return;
        const x = i % W, y = Math.floor(i / W);
        n++; top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x);
      });
      return { n, top, bottom, left, right };
    };
    engine.clear();
    engine.paint(1, [0, 157], [255, 157], 3);
    for (let i = 0; i < 6; i++) engine.paint(2, [20, 146], [90, 146], 4); // a bed of sand under the glass
    engine.paint(11, [40, 40], [70, 40], 5);
    for (let i = 0; i < 12; i++) engine.paint(3, [150, 140], [230, 140], 8); // a pool under the stone
    engine.paint(6, [180, 30], [200, 30], 4);
    cells = await engine.read();
    const glassBefore = box(11), stoneBefore = box(6);
    cells = await run(150);
    return { water, glassBefore, glassAfter: box(11), stoneBefore, stoneAfter: box(6), sandTop: box(2).top };
  });
  console.log("gravity", JSON.stringify(gravity));
  const { water: pool, glassBefore, glassAfter, stoneBefore, stoneAfter, sandTop } = gravity;
  check(pool.columns === pool.of && pool.bumps <= 2, `water levels out across the box (${pool.columns}/${pool.of} columns, ${pool.bumps} rows of bumps)`);
  check(
    glassAfter.n === glassBefore.n && glassAfter.left === glassBefore.left && glassAfter.right === glassBefore.right &&
      glassAfter.top > glassBefore.top + 80,
    `glass falls straight down without breaking up (top row ${glassBefore.top} → ${glassAfter.top})`,
  );
  check(glassAfter.bottom <= sandTop + 4, "glass comes to rest on sand instead of sinking through it");
  check(
    stoneAfter.n === stoneBefore.n && stoneAfter.bottom >= 145,
    `stone sinks through the pool to the floor (bottom row ${stoneBefore.bottom} → ${stoneAfter.bottom})`,
  );

  // Walls fall unless something holds them; wood floats; a crown hangs from its trunk.
  const solids = await page.evaluate(async () => {
    const { engine } = window.lume;
    const W = engine.width;
    const run = async (ticks) => {
      for (let i = 0; i < ticks; i++) engine.tick(2, false);
      await engine.idle();
      return engine.read();
    };
    const box = (cells, m, x0 = 0, x1 = W) => {
      let n = 0, top = 999, bottom = 0;
      cells.forEach((c, i) => {
        const x = i % W, y = Math.floor(i / W);
        if ((c & 0xff) !== m || x < x0 || x >= x1) return;
        n++; top = Math.min(top, y); bottom = Math.max(bottom, y);
      });
      return { n, top, bottom };
    };
    engine.clear();
    engine.paint(1, [0, 157], [255, 157], 3); // floor
    engine.paint(1, [20, 30], [60, 30], 2); // a wall in mid-air
    engine.paint(1, [90, 60], [90, 152], 3); // a pillar on the floor...
    engine.paint(1, [90, 60], [150, 60], 2); // ...with a shelf out from it
    engine.paint(1, [165, 100], [165, 155], 2); // a tank...
    engine.paint(1, [252, 100], [252, 155], 2);
    for (let i = 0; i < 12; i++) engine.paint(3, [172, 125], [246, 125], 12); // ...of water
    engine.paint(9, [195, 145], [225, 145], 3); // a log at the bottom of it
    let cells = await run(300);
    const result = {
      loose: box(cells, 1, 0, 70),
      shelf: box(cells, 1, 100, 160),
      log: box(cells, 9),
      water: box(cells, 3, 170, 248),
    };
    // Floating: in every column of the log, nothing but air above it.
    result.submerged = 0;
    for (let x = 170; x < 248; x++) {
      let wood = -1;
      for (let y = 0; y < 160; y++) if ((cells[y * W + x] & 0xff) === 9) { wood = y; break; }
      if (wood < 0) continue;
      for (let y = 0; y < wood; y++) if ((cells[y * W + x] & 0xff) === 3) { result.submerged++; break; }
    }
    // A tree: cut the trunk and the crown comes down.
    engine.clear();
    engine.paint(1, [0, 157], [255, 157], 3);
    engine.paint(9, [128, 100], [128, 152], 2); // trunk
    engine.paint(9, [128, 85], [128, 85], 14); // crown
    cells = await run(100);
    result.crown = box(cells, 9);
    engine.paint(0, [128, 130], [128, 140], 4); // saw through the trunk
    cells = await run(300);
    result.felled = box(cells, 9);
    return result;
  });
  console.log("solids", JSON.stringify(solids));
  check(solids.loose.top > 140, `a wall in mid-air falls to the floor (top row ${solids.loose.top})`);
  check(solids.shelf.top <= 60 && solids.shelf.n > 50, "a shelf hangs from its pillar");
  check(
    solids.log.n > 0 && solids.submerged === 0 && solids.log.top < solids.water.top,
    `wood floats up to the surface (log ${solids.log.top}-${solids.log.bottom}, water from row ${solids.water.top}, ${solids.submerged} columns under water)`,
  );
  check(solids.crown.top <= 72, `a crown stays up on its trunk (top row ${solids.crown.top})`);
  // The cut is about 18 rows tall: the tree drops by that much onto the stump.
  check(solids.felled.top >= solids.crown.top + 15, `cutting the trunk brings the crown down onto the stump (top row ${solids.crown.top} → ${solids.felled.top})`);

  // The opening scene should run at full size without errors.
  await page.goto(`http://localhost:${PORT}/?draw=0`);
  await page.waitForFunction(() => window.lume, null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  const scene = await page.evaluate(() => window.lume.engine.census());
  check(scene.sand > 0 && scene.water > 0 && scene.lava > 0, "the opening scene has sand, water and lava");
  check(errors.length === 0, `no page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
} finally {
  await browser.close();
  stopServer();
}
process.exit(failed ? 1 : 0);
