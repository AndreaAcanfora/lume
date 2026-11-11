import "./style.css";
import { Engine, Material, MAX_STEPS, MATERIAL_NAMES } from "./engine";
import { openingScene } from "./world";

const PALETTE: { material: Material; label: string; key: string }[] = [
  { material: Material.Sand, label: "Sand", key: "1" },
  { material: Material.Water, label: "Water", key: "2" },
  { material: Material.Lava, label: "Lava", key: "3" },
  { material: Material.Smoke, label: "Smoke", key: "4" },
  { material: Material.Wall, label: "Wall", key: "5" },
  { material: Material.Stone, label: "Stone", key: "6" },
  { material: Material.Lamp, label: "Lamp", key: "7" },
  { material: Material.Fire, label: "Fire", key: "8" },
  { material: Material.Wood, label: "Wood", key: "9" },
  { material: Material.Glass, label: "Glass", key: "g" },
  { material: Material.Empty, label: "Erase", key: "0" },
];

const canvas = document.querySelector<HTMLCanvasElement>("#world")!;
const toolbar = document.querySelector<HTMLDivElement>("#tools")!;
const sizeInput = document.querySelector<HTMLInputElement>("#size")!;
const pauseButton = document.querySelector<HTMLButtonElement>("#pause")!;
const lightButton = document.querySelector<HTMLButtonElement>("#light")!;
const resetButton = document.querySelector<HTMLButtonElement>("#reset")!;
const clearButton = document.querySelector<HTMLButtonElement>("#clear")!;
const hud = document.querySelector<HTMLSpanElement>("#hud")!;

// Grid size: ?w=…&h=… for benchmarks, otherwise ~1M cells on desktop and
// fewer on small screens.
const query = new URLSearchParams(location.search);
const small = Math.min(innerWidth, innerHeight) < 600;
const width = Number(query.get("w")) || (small ? 640 : 1280);
const height = Number(query.get("h")) || (small ? 400 : 800);
const steps = Math.min(MAX_STEPS, Number(query.get("steps")) || 2);
// ?draw=0 runs the simulation without presenting it. Headless Chromium can
// run WebGPU compute but loses the device when it presents a canvas.
const draw = query.get("draw") !== "0";

let engine: Engine;
try {
  engine = await Engine.create(canvas, width, height);
} catch (error) {
  document.body.classList.add("no-gpu");
  document.querySelector("#no-gpu-reason")!.textContent = String((error as Error).message ?? error);
  throw error;
}

let material: Material = Material.Sand;
let paused = false;

for (const item of PALETTE) {
  const button = document.createElement("button");
  button.textContent = item.label;
  button.title = `${item.label} (${item.key})`;
  button.dataset.material = String(item.material);
  button.addEventListener("click", () => select(item.material));
  toolbar.append(button);
}

function select(m: Material): void {
  material = m;
  for (const b of toolbar.querySelectorAll<HTMLButtonElement>("button")) {
    b.setAttribute("aria-pressed", String(Number(b.dataset.material) === m));
  }
}
select(material);

function setPaused(value: boolean): void {
  paused = value;
  pauseButton.textContent = paused ? "Play" : "Pause";
}

function reset(): void {
  engine.load(openingScene(engine.width, engine.height));
}
reset();

function toggleLight(): void {
  engine.lighting = !engine.lighting;
  lightButton.setAttribute("aria-pressed", String(engine.lighting));
}

pauseButton.addEventListener("click", () => setPaused(!paused));
lightButton.addEventListener("click", toggleLight);
resetButton.addEventListener("click", reset);
clearButton.addEventListener("click", () => engine.clear());

addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  const item = PALETTE.find((p) => p.key === e.key);
  if (item) select(item.material);
  else if (e.key === " ") {
    setPaused(!paused);
    e.preventDefault();
  } else if (e.key === "r") reset();
  else if (e.key === "l") toggleLight();
});

// Pointer → cell coordinates. The canvas keeps its aspect ratio with
// object-fit: contain, so account for the letterbox.
function toCell(e: PointerEvent): [number, number] {
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(rect.width / engine.width, rect.height / engine.height);
  const offsetX = (rect.width - engine.width * scale) / 2;
  const offsetY = (rect.height - engine.height * scale) / 2;
  return [(e.clientX - rect.left - offsetX) / scale, (e.clientY - rect.top - offsetY) / scale];
}

let last: [number, number] | null = null;
let current: [number, number] | null = null;

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  current = toCell(e);
  last = current;
});
canvas.addEventListener("pointermove", (e) => {
  if (current) current = toCell(e);
});
const stop = () => {
  current = null;
  last = null;
};
canvas.addEventListener("pointerup", stop);
canvas.addEventListener("pointercancel", stop);

let frames = 0;
let fpsTime = performance.now();

function loop(): void {
  if (current && last) {
    engine.paint(material, last, current, Number(sizeInput.value));
    last = current;
  }
  engine.tick(paused ? 0 : steps, draw);

  frames++;
  const now = performance.now();
  if (now - fpsTime >= 500) {
    const fps = (frames * 1000) / (now - fpsTime);
    hud.textContent = `${(engine.cellCount / 1e6).toFixed(2)}M cells · ${fps.toFixed(0)} fps`;
    frames = 0;
    fpsTime = now;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// A small handle for the end-to-end tests and for poking around in devtools.
declare global {
  interface Window {
    lume: {
      engine: Engine;
      materials: typeof MATERIAL_NAMES;
      pause(value: boolean): void;
    };
  }
}
window.lume = { engine, materials: MATERIAL_NAMES, pause: setPaused };
