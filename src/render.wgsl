// Draws one pixel per cell. The canvas has the grid's size and CSS scales it.

struct View {
  size: vec2u,
  cover: vec2u, // cells covered by the fluence texture (4 per texel)
  lit: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

@group(0) @binding(0) var<storage, read> cells: array<u32>;
@group(0) @binding(1) var<uniform> V: View;
@group(0) @binding(2) var fluence: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  // One triangle that covers the screen.
  let uv = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(uv * 2.0 - 1.0, 0.0, 1.0);
}

const BACKGROUND = vec3f(0.035, 0.035, 0.05);

fn palette(m: u32) -> vec3f {
  switch m {
    case 1u: { return vec3f(0.42, 0.42, 0.46); } // wall
    case 2u: { return vec3f(0.86, 0.70, 0.42); } // sand
    case 3u: { return vec3f(0.16, 0.42, 0.85); } // water
    case 4u: { return vec3f(1.00, 0.36, 0.08); } // lava
    case 5u: { return vec3f(0.62, 0.62, 0.66); } // smoke
    case 6u: { return vec3f(0.26, 0.22, 0.22); } // stone
    case 7u: { return vec3f(1.00, 0.92, 0.75); } // lamp
    default: { return BACKGROUND; }
  }
}

fn fluenceAt(pos: vec2f) -> vec3f {
  return textureSampleLevel(fluence, linearSampler, pos / vec2f(V.cover), 0.0).rgb;
}

// Light probes inside a solid see only the solid itself, so they read black.
// A solid cell instead takes the brightest light found in the open just
// outside it, fading with distance: surfaces light up, interiors stay dark.
fn surfaceLight(pos: vec2f) -> vec3f {
  var best = fluenceAt(pos);
  for (var k = 0; k < 8; k++) {
    let a = f32(k) * 0.785398163;
    let dir = vec2f(cos(a), sin(a));
    for (var j = 0; j < 3; j++) {
      let d = array<f32, 3>(3.0, 6.0, 10.0)[j];
      best = max(best, fluenceAt(pos + dir * d) * (1.0 - d / 14.0));
    }
  }
  return best;
}

// Light the flat colour with the fluence from the radiance cascades.
// Emitters glow at full strength; air shows a faint haze of the light that
// crosses it, which is what makes the light visible around a source.
fn shade(color: vec3f, m: u32, pos: vec2f) -> vec3f {
  if (V.lit == 0u) { return color; }
  var c: vec3f;
  if (m == 4u || m == 7u) {
    c = color * 1.6;
  } else if (m == 0u) {
    c = color * 0.4 + fluenceAt(pos) * 0.12;
  } else if (m == 1u || m == 2u || m == 6u) {
    c = color * (0.04 + surfaceLight(pos) * 2.5);
  } else {
    c = color * (0.04 + fluenceAt(pos) * 2.5);
  }
  return 1.0 - exp(-c * 1.6); // tone map
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let c = vec2u(pos.xy);
  let cell = cells[c.y * V.size.x + c.x];
  let m = cell & 0xffu;
  if (m == 0u) { return vec4f(shade(BACKGROUND, 0u, pos.xy), 1.0); }

  // Per-cell shade so that sand reads as grains and water as ripples.
  let grain = f32((cell >> 8u) & 0xffu) / 255.0;
  var color = palette(m) * (0.86 + 0.22 * grain);
  if (m == 4u) {
    color = mix(color, vec3f(1.0, 0.85, 0.3), grain * grain * 0.6);
  }
  if (m == 5u) {
    let life = f32((cell >> 16u) & 0xffu) / 255.0;
    color = mix(BACKGROUND, color, clamp(life * 1.4, 0.0, 0.85));
  }
  return vec4f(shade(color, m, pos.xy), 1.0);
}
