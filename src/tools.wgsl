// Brush and statistics kernels. They share the grid binding with sim.wgsl.

struct Brush {
  start: vec2f,
  end: vec2f,
  radius: f32,
  material: u32,
  seed: u32,
  size_x: u32,
  size_y: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

@group(0) @binding(0) var<storage, read_write> cells: array<u32>;
@group(0) @binding(1) var<uniform> B: Brush;
@group(0) @binding(2) var<storage, read_write> counts: array<atomic<u32>, 8>;

const EMPTY = 0u;
const WALL = 1u;
const SMOKE = 5u;
const STONE = 6u;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

fn segmentDistance(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return length(p - (a + ab * t));
}

// Paints a thick line from the previous pointer position to the current one,
// so fast strokes have no gaps. Loose matter is sprayed, solids are filled.
@compute @workgroup_size(8, 8)
fn paint(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= B.size_x || id.y >= B.size_y) { return; }
  let p = vec2f(id.xy) + 0.5;
  if (segmentDistance(p, B.start, B.end) > B.radius) { return; }

  let i = id.y * B.size_x + id.x;
  let r = pcg(i ^ pcg(B.seed));
  let old = cells[i] & 0xffu;
  let m = B.material;
  let solid = m == WALL || m == STONE;

  if (m != EMPTY && !solid) {
    if (old != EMPTY && old != SMOKE) { return; }
    if ((r & 3u) != 0u) { return; }
  }
  var life = 0u;
  if (m == SMOKE) { life = 120u + ((r >> 16u) & 127u); }
  cells[i] = m | (((r >> 8u) & 0xffu) << 8u) | (life << 16u);
}

@compute @workgroup_size(64)
fn count(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= B.size_x * B.size_y) { return; }
  atomicAdd(&counts[min(cells[i] & 0xffu, 7u)], 1u);
}
