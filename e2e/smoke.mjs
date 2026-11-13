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
    engine.paint(1, [0, 150], [255, 150], 3); // wall floor
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
  check(after.wall === before.wall && after.stone === before.stone, "solids do not move or vanish");

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
    engine.paint(1, [0, 150], [255, 150], 3);
    engine.paint(9, [100, 110], [140, 110], 10); // a log
    const before = await engine.census();
    engine.paint(8, [95, 125], [145, 125], 6); // fire under it
    for (let i = 0; i < 400; i++) engine.tick(2, false);
    await engine.idle();
    return { before, after: await engine.census() };
  });
  console.log("fire", JSON.stringify(fire.after));
  check(fire.after.wood < fire.before.wood * 0.5, `fire burns wood (${fire.before.wood} → ${fire.after.wood})`);
  check(fire.after.ash > 0, "burnt wood leaves ash");

  // Lava fuses sand into glass, and glass lets light through.
  const glass = await page.evaluate(async () => {
    const { engine } = window.lume;
    engine.clear();
    engine.paint(1, [0, 150], [255, 150], 3);
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
