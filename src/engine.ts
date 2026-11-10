import simCode from "./sim.wgsl?raw";
import toolsCode from "./tools.wgsl?raw";
import renderCode from "./render.wgsl?raw";

export const Material = {
  Empty: 0,
  Wall: 1,
  Sand: 2,
  Water: 3,
  Lava: 4,
  Smoke: 5,
  Stone: 6,
} as const;
export type Material = (typeof Material)[keyof typeof Material];

export const MATERIAL_NAMES = ["empty", "wall", "sand", "water", "lava", "smoke", "stone"] as const;

// Each step runs the two Margolus phases: blocks at (0,0) and at (1,1).
const OFFSETS: ReadonlyArray<[number, number]> = [
  [0, 0],
  [1, 1],
];

/** Most steps one tick can run. Each step needs its own parameter buffers. */
export const MAX_STEPS = 4;

export class Engine {
  readonly width: number;
  readonly height: number;
  frame = 0;

  private readonly device: GPUDevice;
  private readonly context: GPUCanvasContext;
  private readonly cells: GPUBuffer;
  private readonly brush: GPUBuffer;
  private readonly counts: GPUBuffer;
  private readonly countsRead: GPUBuffer;
  private readonly params: GPUBuffer[];
  private readonly stepPipeline: GPUComputePipeline;
  private readonly paintPipeline: GPUComputePipeline;
  private readonly countPipeline: GPUComputePipeline;
  private readonly renderPipeline: GPURenderPipeline;
  private readonly stepGroups: GPUBindGroup[];
  private readonly paintGroup: GPUBindGroup;
  private readonly countGroup: GPUBindGroup;
  private readonly renderGroup: GPUBindGroup;

  static async create(canvas: HTMLCanvasElement, width: number, height: number): Promise<Engine> {
    if (!navigator.gpu) throw new Error("WebGPU is not available in this browser.");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No WebGPU adapter was found.");
    const device = await adapter.requestDevice();
    device.lost.then((info) => console.error(`WebGPU device lost (${info.reason}): ${info.message}`));
    device.addEventListener("uncapturederror", (e) => console.error(`WebGPU error: ${e.error.message}`));
    return new Engine(device, canvas, width, height);
  }

  private constructor(device: GPUDevice, canvas: HTMLCanvasElement, width: number, height: number) {
    // Blocks are 2x2, so an even grid keeps the last row and column in play.
    this.width = width & ~1;
    this.height = height & ~1;
    this.device = device;
    canvas.width = this.width;
    canvas.height = this.height;

    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("Could not get a WebGPU canvas context.");
    this.context = context;
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });

    const S = GPUBufferUsage;
    this.cells = device.createBuffer({
      label: "cells",
      size: this.width * this.height * 4,
      usage: S.STORAGE | S.COPY_DST | S.COPY_SRC,
    });
    this.brush = device.createBuffer({ label: "brush", size: 48, usage: S.UNIFORM | S.COPY_DST });
    this.counts = device.createBuffer({ label: "counts", size: 32, usage: S.STORAGE | S.COPY_DST | S.COPY_SRC });
    this.countsRead = device.createBuffer({ label: "counts-read", size: 32, usage: S.MAP_READ | S.COPY_DST });
    this.params = Array.from({ length: MAX_STEPS * OFFSETS.length }, (_, i) =>
      device.createBuffer({ label: `params-${i}`, size: 32, usage: S.UNIFORM | S.COPY_DST }),
    );

    const sim = device.createShaderModule({ label: "sim", code: simCode });
    const tools = device.createShaderModule({ label: "tools", code: toolsCode });
    const render = device.createShaderModule({ label: "render", code: renderCode });

    this.stepPipeline = device.createComputePipeline({
      label: "step",
      layout: "auto",
      compute: { module: sim, entryPoint: "step" },
    });
    this.paintPipeline = device.createComputePipeline({
      label: "paint",
      layout: "auto",
      compute: { module: tools, entryPoint: "paint" },
    });
    this.countPipeline = device.createComputePipeline({
      label: "count",
      layout: "auto",
      compute: { module: tools, entryPoint: "count" },
    });
    this.renderPipeline = device.createRenderPipeline({
      label: "render",
      layout: "auto",
      vertex: { module: render, entryPoint: "vs" },
      fragment: { module: render, entryPoint: "fs", targets: [{ format }] },
    });

    this.stepGroups = this.params.map((params) =>
      device.createBindGroup({
        layout: this.stepPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.cells } },
          { binding: 1, resource: { buffer: params } },
        ],
      }),
    );
    this.paintGroup = device.createBindGroup({
      layout: this.paintPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cells } },
        { binding: 1, resource: { buffer: this.brush } },
      ],
    });
    this.countGroup = device.createBindGroup({
      layout: this.countPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cells } },
        { binding: 1, resource: { buffer: this.brush } },
        { binding: 2, resource: { buffer: this.counts } },
      ],
    });
    const view = device.createBuffer({ label: "view", size: 16, usage: S.UNIFORM | S.COPY_DST });
    device.queue.writeBuffer(view, 0, new Uint32Array([this.width, this.height, 0, 0]));
    this.renderGroup = device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cells } },
        { binding: 1, resource: { buffer: view } },
      ],
    });
  }

  get cellCount(): number {
    return this.width * this.height;
  }

  /** Replaces the whole grid with cells built on the CPU. */
  load(cells: Uint32Array): void {
    if (cells.length !== this.cellCount) throw new Error("Grid size mismatch.");
    this.device.queue.writeBuffer(this.cells, 0, cells);
  }

  clear(): void {
    this.load(new Uint32Array(this.cellCount));
  }

  /** Paints a stroke of the given radius from one cell position to another. */
  paint(material: Material, from: [number, number], to: [number, number], radius: number): void {
    this.writeBrush(from, to, radius, material);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.paintPipeline);
    pass.setBindGroup(0, this.paintGroup);
    pass.dispatchWorkgroups(Math.ceil(this.width / 8), Math.ceil(this.height / 8));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /** Advances the simulation by `steps` steps and draws the result. */
  tick(steps: number, draw = true): void {
    steps = Math.max(0, Math.min(MAX_STEPS, steps));
    const encoder = this.device.createCommandEncoder();
    const groupsX = Math.ceil(this.width / 16);
    const groupsY = Math.ceil(this.height / 16);
    for (let s = 0; s < steps; s++) {
      // Uniform writes all land before the submit, so every step and phase
      // reads its own buffer to get a fresh frame number for its dice.
      this.frame++;
      OFFSETS.forEach(([ox, oy], o) => {
        const i = s * OFFSETS.length + o;
        const data = new Uint32Array([this.width, this.height, ox, oy, this.frame, 0, 0, 0]);
        this.device.queue.writeBuffer(this.params[i], 0, data);
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.stepPipeline);
        pass.setBindGroup(0, this.stepGroups[i]);
        pass.dispatchWorkgroups(groupsX, groupsY);
        pass.end();
      });
    }
    if (draw) this.encodeDraw(encoder);
    this.device.queue.submit([encoder.finish()]);
  }

  draw(): void {
    const encoder = this.device.createCommandEncoder();
    this.encodeDraw(encoder);
    this.device.queue.submit([encoder.finish()]);
  }

  /** Counts the cells of each material. Used by the tests and the HUD. */
  async census(): Promise<Record<string, number>> {
    this.writeBrush([0, 0], [0, 0], 0, 0);
    const encoder = this.device.createCommandEncoder();
    encoder.clearBuffer(this.counts);
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.countPipeline);
    pass.setBindGroup(0, this.countGroup);
    pass.dispatchWorkgroups(Math.ceil(this.cellCount / 64));
    pass.end();
    encoder.copyBufferToBuffer(this.counts, 0, this.countsRead, 0, 32);
    this.device.queue.submit([encoder.finish()]);
    await this.countsRead.mapAsync(GPUMapMode.READ);
    const raw = new Uint32Array(this.countsRead.getMappedRange().slice(0));
    this.countsRead.unmap();
    return Object.fromEntries(MATERIAL_NAMES.map((name, i) => [name, raw[i]]));
  }

  /** Copies the whole grid back to the CPU. Slow; meant for tests and saving. */
  async read(): Promise<Uint32Array> {
    const size = this.cellCount * 4;
    const staging = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(this.cells, 0, staging, 0, size);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const cells = new Uint32Array(staging.getMappedRange().slice(0));
    staging.destroy();
    return cells;
  }

  /** Resolves when the GPU has finished everything submitted so far. */
  idle(): Promise<void> {
    return this.device.queue.onSubmittedWorkDone();
  }

  private writeBrush(from: [number, number], to: [number, number], radius: number, material: number): void {
    const data = new ArrayBuffer(48);
    new Float32Array(data, 0, 5).set([from[0], from[1], to[0], to[1], radius]);
    new Uint32Array(data, 20, 4).set([material, (Math.random() * 2 ** 32) >>> 0, this.width, this.height]);
    this.device.queue.writeBuffer(this.brush, 0, data);
  }

  private encodeDraw(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, this.renderGroup);
    pass.draw(3);
    pass.end();
  }
}
