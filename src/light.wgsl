// Real-time 2D global illumination with radiance cascades.
//
// 1. scene:   the cell grid at half resolution -> emission + occupancy, and
//             the seeds of a jump-flood distance field.
// 2. jfa:     jump flooding; each texel learns the nearest occupied texel,
//             which lets rays skip empty space.
// 3. cascade: cascade n has probes every B = 2^(n+1) texels, each with B*B
//             rays laid out as a BxB block, tracing the interval
//             [start, end). Rays that hit nothing take the light the four
//             matching rays of cascade n+1 saw beyond, interpolated between
//             the four nearest upper probes. Run from the top cascade down.
// 4. resolve: average the 4 rays of each cascade-0 probe into fluence.

struct Light {
  size: vec2u,      // padded light-texture size (half the grid, rounded up)
  grid: vec2u,      // cell grid size
  n: u32,           // cascade index, or jump-flood step
  count: u32,       // number of cascades
  start: f32,       // ray interval, in texels
  end: f32,
}

@group(0) @binding(0) var<uniform> L: Light;

// ---- 1. scene --------------------------------------------------------------

@group(0) @binding(1) var<storage, read> cells: array<u32>;
@group(0) @binding(2) var sceneOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var seedOut: texture_storage_2d<rg32float, write>;

const NO_SEED = vec2f(-1e6, -1e6);

fn emission(c: u32) -> vec3f {
  let shade = f32((c >> 8u) & 0xffu) / 255.0;
  switch c & 0xffu {
    case 4u: { return vec3f(2.4, 0.75, 0.18) * (0.75 + 0.5 * shade); } // lava
    case 7u: { return vec3f(2.2, 1.9, 1.4); }                           // lamp
    default: { return vec3f(0.0); }
  }
}

// Sand, solids and light sources block light. Water and smoke let it through.
fn opaque(c: u32) -> bool {
  let m = c & 0xffu;
  return m == 1u || m == 2u || m == 4u || m == 6u || m == 7u;
}

@compute @workgroup_size(8, 8)
fn scene(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= L.size.x || id.y >= L.size.y) { return; }
  var e = vec3f(0.0);
  var solid = 0u;
  for (var k = 0u; k < 4u; k++) {
    let c = id.xy * 2u + vec2u(k & 1u, k >> 1u);
    if (c.x >= L.grid.x || c.y >= L.grid.y) { continue; }
    let cell = cells[c.y * L.grid.x + c.x];
    e += emission(cell);
    if (opaque(cell)) { solid++; }
  }
  let hit = solid >= 2u;
  // An occupied texel's colour is the average of its emitting cells.
  textureStore(sceneOut, id.xy, vec4f(e / max(f32(solid), 1.0), select(0.0, 1.0, hit)));
  textureStore(seedOut, id.xy, vec4f(select(NO_SEED, vec2f(id.xy) + 0.5, hit), 0.0, 0.0));
}

// ---- 2. jump flooding ------------------------------------------------------

@group(0) @binding(4) var seedIn: texture_2d<f32>;
@group(0) @binding(5) var seedNext: texture_storage_2d<rg32float, write>;

@compute @workgroup_size(8, 8)
fn jfa(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= L.size.x || id.y >= L.size.y) { return; }
  let p = vec2f(id.xy) + 0.5;
  var best = NO_SEED;
  var bestD = 1e12;
  let step = i32(L.n);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let q = vec2i(id.xy) + vec2i(dx, dy) * step;
      if (any(q < vec2i(0)) || any(q >= vec2i(L.size))) { continue; }
      let s = textureLoad(seedIn, q, 0).xy;
      let d = dot(s - p, s - p);
      if (d < bestD) { bestD = d; best = s; }
    }
  }
  textureStore(seedNext, id.xy, vec4f(best, 0.0, 0.0));
}

// ---- 3. cascades -----------------------------------------------------------

@group(0) @binding(6) var sceneIn: texture_2d<f32>;
@group(0) @binding(7) var upper: texture_2d<f32>;
@group(0) @binding(8) var cascadeOut: texture_storage_2d<rgba16float, write>;

const TAU = 6.283185307;
// What a ray that leaves through the top cascade sees: a dim night sky.
const SKY = vec3f(0.16, 0.19, 0.27);

// Radiance along one ray interval; alpha is 1 if nothing was hit.
fn march(origin: vec2f, dir: vec2f, start: f32, end: f32) -> vec4f {
  var t = start;
  for (var i = 0; i < 48; i++) {
    if (t >= end) { break; }
    let p = origin + dir * t;
    if (any(p < vec2f(0.0)) || any(p >= vec2f(L.size))) { break; }
    let s = textureLoad(seedIn, vec2i(p), 0).xy;
    let d = distance(p, s);
    if (d < 0.75) {
      return vec4f(textureLoad(sceneIn, vec2i(s), 0).rgb, 0.0);
    }
    t += max(d - 0.5, 0.5);
  }
  return vec4f(0.0, 0.0, 0.0, 1.0);
}

@compute @workgroup_size(8, 8)
fn cascade(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= L.size.x || id.y >= L.size.y) { return; }
  let B = 2u << L.n;
  let probe = id.xy / B;
  let local = id.xy % B;
  let ray = local.x + local.y * B;
  let angle = (f32(ray) + 0.5) / f32(B * B) * TAU;
  let dir = vec2f(cos(angle), sin(angle));
  let center = (vec2f(probe) + 0.5) * f32(B);

  var rad = march(center, dir, L.start, L.end);
  if (rad.a > 0.0) {
    var beyond = SKY;
    if (L.n + 1u < L.count) {
      // The same direction one cascade up: rays 4r..4r+3, bilinear between
      // the four upper probes around this one.
      let UB = B * 2u;
      let f = center / f32(UB) - 0.5;
      let q0 = vec2i(floor(f));
      let w = fract(f);
      let maxQ = vec2i(L.size / UB) - 1;
      beyond = vec3f(0.0);
      for (var k = 0u; k < 4u; k++) {
        let corner = vec2i(i32(k & 1u), i32(k >> 1u));
        let q = vec2u(clamp(q0 + corner, vec2i(0), maxQ));
        let wx = select(1.0 - w.x, w.x, corner.x == 1);
        let wy = select(1.0 - w.y, w.y, corner.y == 1);
        var acc = vec3f(0.0);
        for (var j = 0u; j < 4u; j++) {
          let ur = ray * 4u + j;
          acc += textureLoad(upper, q * UB + vec2u(ur % UB, ur / UB), 0).rgb;
        }
        beyond += acc * 0.25 * wx * wy;
      }
    }
    rad = vec4f(rad.rgb + beyond * rad.a, 0.0);
  }
  textureStore(cascadeOut, id.xy, rad);
}

// ---- 4. resolve ------------------------------------------------------------

@group(0) @binding(9) var fluenceOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn resolve(@builtin(global_invocation_id) id: vec3u) {
  if (id.x * 2u >= L.size.x || id.y * 2u >= L.size.y) { return; }
  var sum = vec3f(0.0);
  for (var k = 0u; k < 4u; k++) {
    sum += textureLoad(upper, id.xy * 2u + vec2u(k & 1u, k >> 1u), 0).rgb;
  }
  textureStore(fluenceOut, id.xy, vec4f(sum * 0.25, 1.0));
}
