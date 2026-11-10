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
