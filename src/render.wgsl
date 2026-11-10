// Draws one pixel per cell. The canvas has the grid's size and CSS scales it.

struct View {
  size: vec2u,
  _pad0: u32,
  _pad1: u32,
}

@group(0) @binding(0) var<storage, read> cells: array<u32>;
@group(0) @binding(1) var<uniform> V: View;

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
    default: { return BACKGROUND; }
  }
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let c = vec2u(pos.xy);
  let cell = cells[c.y * V.size.x + c.x];
  let m = cell & 0xffu;
  if (m == 0u) { return vec4f(BACKGROUND, 1.0); }

  // Per-cell shade so that sand reads as grains and water as ripples.
  let shade = f32((cell >> 8u) & 0xffu) / 255.0;
  var color = palette(m) * (0.86 + 0.22 * shade);
  if (m == 4u) {
    color = mix(color, vec3f(1.0, 0.85, 0.3), shade * shade * 0.6);
  }
  if (m == 5u) {
    let life = f32((cell >> 16u) & 0xffu) / 255.0;
    color = mix(BACKGROUND, color, clamp(life * 1.4, 0.0, 0.85));
  }
  return vec4f(color, 1.0);
}
