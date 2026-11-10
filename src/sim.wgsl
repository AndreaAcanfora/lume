// Falling sand on a Margolus neighbourhood.
//
// The grid is split into 2x2 blocks. One invocation owns one block, reads its
// four cells, rearranges them and writes them back. Blocks never overlap, so
// the update runs in place with no races and no second buffer. Alternating the
// block offset between (0,0) and (1,1) lets matter cross block borders.
//
// A cell is a u32: bits 0-7 material, 8-15 shade, 16-23 life (for smoke).

struct Params {
  size: vec2u,
  offset: vec2u,
  frame: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

@group(0) @binding(0) var<storage, read_write> cells: array<u32>;
@group(0) @binding(1) var<uniform> P: Params;

const EMPTY = 0u;
const WALL = 1u;
const SAND = 2u;
const WATER = 3u;
const LAVA = 4u;
const SMOKE = 5u;
const STONE = 6u;

fn mat(c: u32) -> u32 { return c & 0xffu; }

// Heavier matter sinks through lighter matter. Smoke is lighter than air, so
// "air falls through smoke" is how smoke rises: one rule covers both.
fn density(m: u32) -> i32 {
  switch m {
    case 5u: { return 0; }   // smoke
    case 0u: { return 1; }   // empty
    case 3u: { return 2; }   // water
    case 4u: { return 3; }   // lava
    case 2u: { return 4; }   // sand
    default: { return 100; } // wall, stone
  }
}

fn movable(m: u32) -> bool { return m != WALL && m != STONE; }

// Cells that flow sideways: liquids, gas and the air they flow into.
fn fluid(m: u32) -> bool { return m == EMPTY || m == WATER || m == LAVA || m == SMOKE; }

// Lava is viscous: it moves on only some of the passes.
fn mobility(m: u32) -> u32 {
  if (m == LAVA) { return 96u; }
  return 256u;
}

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

// a above b: does a sink into b?
fn sinks(a: u32, b: u32, roll: u32) -> bool {
  let ma = mat(a);
  let mb = mat(b);
  if (!movable(ma) || !movable(mb)) { return false; }
  if (density(ma) <= density(mb)) { return false; }
  // The moving one is whichever is not air/smoke; use the slower of the two.
  return (roll & 0xffu) < min(mobility(ma), mobility(mb));
}

@compute @workgroup_size(8, 8)
fn step(@builtin(global_invocation_id) id: vec3u) {
  let x = id.x * 2u + P.offset.x;
  let y = id.y * 2u + P.offset.y;
  let w = P.size.x;
  if (x + 1u >= w || y + 1u >= P.size.y) { return; }

  let itl = y * w + x;
  let itr = itl + 1u;
  let ibl = itl + w;
  let ibr = ibl + 1u;
  var tl = cells[itl];
  var tr = cells[itr];
  var bl = cells[ibl];
  var br = cells[ibr];

  var r = pcg(itl ^ pcg(P.frame * 2u + P.offset.x));

  // Lava meeting water: the lava sets into stone and the water boils off.
  let hasLava = mat(tl) == LAVA || mat(tr) == LAVA || mat(bl) == LAVA || mat(br) == LAVA;
  let hasWater = mat(tl) == WATER || mat(tr) == WATER || mat(bl) == WATER || mat(br) == WATER;
  if (hasLava && hasWater && (r & 7u) == 0u) {
    tl = react(tl, r);
    tr = react(tr, r >> 3u);
    bl = react(bl, r >> 6u);
    br = react(br, r >> 9u);
  }
  r = pcg(r);

  tl = age(tl, r);
  tr = age(tr, r >> 8u);
  bl = age(bl, r >> 16u);
  br = age(br, r >> 24u);
  r = pcg(r);

  // 1. Straight down.
  let fellL = sinks(tl, bl, r);
  let fellR = sinks(tr, br, r >> 8u);
  if (fellL) { let t = tl; tl = bl; bl = t; }
  if (fellR) { let t = tr; tr = br; br = t; }

  // 2. Diagonally, when the cell below is taken. The order is random so that
  //    piles grow symmetric.
  if (!fellL && !fellR) {
    r = pcg(r);
    let leftFirst = (r & 1u) == 0u;
    var moved = false;
    if (leftFirst && density(mat(bl)) >= density(mat(tl)) && sinks(tl, br, r >> 1u)) {
      let t = tl; tl = br; br = t; moved = true;
    }
    if (!moved && density(mat(br)) >= density(mat(tr)) && sinks(tr, bl, r >> 9u)) {
      let t = tr; tr = bl; bl = t; moved = true;
    }
    if (!moved && !leftFirst && density(mat(bl)) >= density(mat(tl)) && sinks(tl, br, r >> 1u)) {
      let t = tl; tl = br; br = t; moved = true;
    }

    // 3. Sideways, for liquids and gas that could not move down.
    if (!moved) {
      r = pcg(r);
      if (spreads(bl, br, r)) { let t = bl; bl = br; br = t; }
      if (spreads(tl, tr, r >> 8u)) { let t = tl; tl = tr; tr = t; }
    }
  }

  cells[itl] = tl;
  cells[itr] = tr;
  cells[ibl] = bl;
  cells[ibr] = br;
}

// Two fluid neighbours swap at random when one of them is air or smoke, which
// levels water and lets smoke drift. Two liquids side by side do not mix.
fn spreads(a: u32, b: u32, roll: u32) -> bool {
  let ma = mat(a);
  let mb = mat(b);
  if (ma == mb || !fluid(ma) || !fluid(mb)) { return false; }
  let open = ma == EMPTY || mb == EMPTY || ma == SMOKE || mb == SMOKE;
  if (!open) { return false; }
  let speed = min(mobility(ma), mobility(mb)) / 2u;
  return (roll & 0xffu) < speed;
}

fn react(c: u32, roll: u32) -> u32 {
  let shade = c & 0xff00u;
  switch mat(c) {
    case 4u: { return STONE | shade; }
    case 3u: { return SMOKE | shade | ((160u + (roll & 63u)) << 16u); }
    default: { return c; }
  }
}

// Smoke thins out and disappears.
fn age(c: u32, roll: u32) -> u32 {
  if (mat(c) != SMOKE) { return c; }
  let life = (c >> 16u) & 0xffu;
  if ((roll & 3u) != 0u) { return c; }
  if (life <= 1u) { return EMPTY | (c & 0xff00u); }
  return (c & 0xff00ffffu) | ((life - 1u) << 16u);
}
