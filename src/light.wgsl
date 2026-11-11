// Real-time 2D global illumination with radiance cascades.
//
// 1. scene:   the cell grid at half resolution -> emission, and absorption
//             per texel (rgb, so water can tint); solids are opaque. Every
//             non-empty texel seeds a jump-flood distance field.
// 2. jfa:     jump flooding; each texel learns the nearest non-empty texel,
//             which lets rays leap across empty air. Through water, smoke
//             and fire they step one texel at a time, absorbing and
//             gathering light as they go.
// 3. cascade: cascade n has probes every B = 2^(n+1) texels, each with B*B
//             rays laid out as a BxB block, tracing the interval
//             [start, end). Rays that hit nothing take the light the four
//             matching rays of cascade n+1 saw beyond, interpolated between
//             the four nearest upper probes, dimmed and tinted by what the
//             ray passed through. Run from the top cascade down. A cascade
//             texel packs radiance and transmittance (both rgb) as halves.
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
@group(0) @binding(10) var<uniform> time: u32; // frame counter, for flicker

// ---- 1. scene --------------------------------------------------------------

@group(0) @binding(1) var<storage, read> cells: array<u32>;
@group(0) @binding(2) var sceneOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var seedOut: texture_storage_2d<rg32float, write>;
@group(0) @binding(11) var mediumOut: texture_storage_2d<rgba16float, write>;

const NO_SEED = vec2f(-1e6, -1e6);

fn emission(c: u32) -> vec3f {
  let shade = f32((c >> 8u) & 0xffu) / 255.0;
  let life = f32((c >> 16u) & 0xffu) / 255.0;
  switch c & 0xffu {
    case 4u: { // lava, slowly pulsing hot spots
      let pulse = 0.85 + 0.15 * sin(f32(time) * 0.05 + shade * 40.0);
      return vec3f(2.4, 0.75, 0.18) * (0.75 + 0.5 * shade) * pulse;
    }
    case 7u: { return vec3f(2.2, 1.9, 1.4); }                         // lamp
    case 8u: { return vec3f(1.6, 0.6, 0.12) * (0.4 + 2.0 * life); }   // fire
    default: { return vec3f(0.0); }
  }
}

// Absorption per texel of travel. Water drinks red first, so light under
// water turns blue-green; smoke greys light out as it thickens.
fn absorption(c: u32) -> vec3f {
  let life = f32((c >> 16u) & 0xffu) / 255.0;
  switch c & 0xffu {
    case 3u: { return vec3f(0.16, 0.05, 0.025); }  // water
    case 5u: { return vec3f(0.08 * life + 0.01); } // smoke
    case 8u: { return vec3f(0.02); }               // fire
    default: { return vec3f(0.0); }
  }
}

// Sand, ash, solids and light sources block light.
fn opaque(c: u32) -> bool {
  let m = c & 0xffu;
  return m == 1u || m == 2u || m == 4u || m == 6u || m == 7u || m == 9u || m == 10u;
}

@compute @workgroup_size(8, 8)
fn scene(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= L.size.x || id.y >= L.size.y) { return; }
  var e = vec3f(0.0);
  var a = vec3f(0.0);
  var solid = 0u;
  for (var k = 0u; k < 4u; k++) {
    let c = id.xy * 2u + vec2u(k & 1u, k >> 1u);
    if (c.x >= L.grid.x || c.y >= L.grid.y) { continue; }
    let cell = cells[c.y * L.grid.x + c.x];
    e += emission(cell);
    a += absorption(cell);
    if (opaque(cell)) { solid++; }
  }
  let blocked = solid >= 2u;
  // A solid texel's colour is the average of its emitting cells; in a
  // medium, emission and absorption are averaged over the four cells.
  let color = select(e * 0.25, e / max(f32(solid), 1.0), blocked);
  let filled = blocked || any(e > vec3f(0.0)) || any(a > vec3f(0.0));
  textureStore(sceneOut, id.xy, vec4f(color, 0.0));
  textureStore(mediumOut, id.xy, vec4f(a * 0.25, select(0.0, 1.0, blocked)));
  textureStore(seedOut, id.xy, vec4f(select(NO_SEED, vec2f(id.xy) + 0.5, filled), 0.0, 0.0));
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
@group(0) @binding(7) var upper: texture_2d<u32>;
@group(0) @binding(8) var cascadeOut: texture_storage_2d<rgba32uint, write>;
@group(0) @binding(12) var mediumIn: texture_2d<f32>;

struct Ray {
  radiance: vec3f,
  transmittance: vec3f,
}

fn pack(r: Ray) -> vec4u {
  return vec4u(
    pack2x16float(r.radiance.rg),
    pack2x16float(vec2f(r.radiance.b, r.transmittance.r)),
    pack2x16float(r.transmittance.gb),
    0u,
  );
}

fn unpackRadiance(v: vec4u) -> vec3f {
  return vec3f(unpack2x16float(v.x), unpack2x16float(v.y).x);
}

const TAU = 6.283185307;
// What a ray that leaves through the top cascade sees: a dim night sky.
const SKY = vec3f(0.16, 0.19, 0.27);

// Light gathered along one ray interval, and how much of what lies beyond
// still gets through (zero once the ray hits something solid).
fn march(origin: vec2f, dir: vec2f, start: f32, end: f32) -> Ray {
  var ray = Ray(vec3f(0.0), vec3f(1.0));
  var t = start;
  for (var i = 0; i < 64; i++) {
    if (t >= end || all(ray.transmittance < vec3f(0.01))) { break; }
    let p = origin + dir * t;
    if (any(p < vec2f(0.0)) || any(p >= vec2f(L.size))) { break; }
    let s = textureLoad(seedIn, vec2i(p), 0).xy;
    let d = distance(p, s);
    if (d < 0.75) {
      let texel = vec2i(p);
      let medium = textureLoad(mediumIn, texel, 0);
      let e = textureLoad(sceneIn, texel, 0).rgb;
      if (medium.a > 0.5) {
        ray.radiance += ray.transmittance * e;
        ray.transmittance = vec3f(0.0);
        break;
      }
      let dt = min(1.0, end - t);
      ray.radiance += ray.transmittance * e * dt;
      ray.transmittance *= exp(-medium.rgb * dt);
      t += dt;
      continue;
    }
    t += max(d - 0.5, 0.5);
  }
  return ray;
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

  var traced = march(center, dir, L.start, L.end);
  if (any(traced.transmittance > vec3f(0.0))) {
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
          acc += unpackRadiance(textureLoad(upper, q * UB + vec2u(ur % UB, ur / UB), 0));
        }
        beyond += acc * 0.25 * wx * wy;
      }
    }
    traced.radiance += beyond * traced.transmittance;
  }
  textureStore(cascadeOut, id.xy, pack(traced));
}

// ---- 4. resolve ------------------------------------------------------------

@group(0) @binding(9) var fluenceOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn resolve(@builtin(global_invocation_id) id: vec3u) {
  if (id.x * 2u >= L.size.x || id.y * 2u >= L.size.y) { return; }
  var sum = vec3f(0.0);
  for (var k = 0u; k < 4u; k++) {
    sum += unpackRadiance(textureLoad(upper, id.xy * 2u + vec2u(k & 1u, k >> 1u), 0));
  }
  textureStore(fluenceOut, id.xy, vec4f(sum * 0.25, 1.0));
}
