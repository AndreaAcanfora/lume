// Falling sand on a Margolus neighbourhood.
//
// The grid is split into 2x2 blocks. One invocation owns one block, reads its
// four cells, rearranges them and writes them back. Blocks never overlap, so
// the update runs in place with no races and no second buffer. Alternating the
// block offset between (0,0) and (1,1) lets matter cross block borders.
//
// A cell is a u32: bits 0-7 material, 8-15 shade, 16-23 life (smoke, fire),
// bit 24 flips the direction a liquid flows in (see flow()).

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
const LAMP = 7u;
const FIRE = 8u;
const WOOD = 9u;
const ASH = 10u;
const GLASS = 11u;

fn mat(c: u32) -> u32 { return c & 0xffu; }

// Heavier matter sinks through lighter matter. Smoke is lighter than air, so
// "air falls through smoke" is how smoke rises: one rule covers both.
fn density(m: u32) -> i32 {
  switch m {
    case 5u: { return 0; }   // smoke
    case 8u: { return 5; }   // fire
    case 0u: { return 10; }  // empty
    case 3u: { return 20; }  // water
    case 10u: { return 25; } // ash
    case 4u: { return 30; }  // lava
    case 2u: { return 40; }  // sand
    default: { return 100; } // wall, stone, lamp, wood, glass
  }
}

// Walls, lamps and wood stay where they are drawn (wood is what trees are
// made of). Everything else falls.
fn movable(m: u32) -> bool { return m != WALL && m != LAMP && m != WOOD; }

// Glass and stone are solid and heavy: they drop straight down through air,
// gas and liquids but never slide or pile up, so a slab falls in one piece
// and comes to rest on whatever is under it.
fn rigid(m: u32) -> bool { return m == GLASS || m == STONE; }

fn liquid(m: u32) -> bool { return m == WATER || m == LAVA; }

// Cells that flow sideways: liquids, gas and the air they flow into.
fn fluid(m: u32) -> bool { return m == EMPTY || m == WATER || m == LAVA || m == SMOKE || m == FIRE; }

// Lava is viscous: it moves on only some of the passes.
fn mobility(m: u32) -> u32 {
  if (m == LAVA) { return 96u; }
  if (m == FIRE) { return 160u; } // flickers upward rather than shooting
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
  if (rigid(ma)) { return fluid(mb); }
  if (rigid(mb)) { return false; }
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

  // Lava fuses the sand it touches into glass.
  let hasSand = mat(tl) == SAND || mat(tr) == SAND || mat(bl) == SAND || mat(br) == SAND;
  if (hasLava && hasSand && (r & 15u) == 0u) {
    tl = fuse(tl);
    tr = fuse(tr);
    bl = fuse(bl);
    br = fuse(br);
  }
  r = pcg(r);

  // Fire and lava set wood alight, a little at a time, so it burns down
  // over a second or two. Fire touching water goes out in a puff of steam.
  let hasHeat = hasLava || mat(tl) == FIRE || mat(tr) == FIRE || mat(bl) == FIRE || mat(br) == FIRE;
  if (hasHeat) {
    tl = burn(tl, hasWater, r);
    tr = burn(tr, hasWater, r >> 8u);
    bl = burn(bl, hasWater, r >> 16u);
    br = burn(br, hasWater, r >> 24u);
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
    let slideL = !rigid(mat(tl));
    let slideR = !rigid(mat(tr));
    if (leftFirst && slideL && density(mat(bl)) >= density(mat(tl)) && sinks(tl, br, r >> 1u)) {
      let t = tl; tl = br; br = t; moved = true;
    }
    if (!moved && slideR && density(mat(br)) >= density(mat(tr)) && sinks(tr, bl, r >> 9u)) {
      let t = tr; tr = bl; bl = t; moved = true;
    }
    if (!moved && !leftFirst && slideL && density(mat(bl)) >= density(mat(tl)) && sinks(tl, br, r >> 1u)) {
      let t = tl; tl = br; br = t; moved = true;
    }

    // 3. Sideways, for liquids and gas that could not move down.
    if (!moved) {
      r = pcg(r);
      let bottom = flow(bl, br, r);
      bl = bottom.x;
      br = bottom.y;
      let top = flow(tl, tr, r >> 8u);
      tl = top.x;
      tr = top.y;
    }
  }

  cells[itl] = tl;
  cells[itr] = tr;
  cells[ibl] = bl;
  cells[ibr] = br;
}

// A liquid keeps flowing the way it was going and turns round only when
// something blocks it. A drop on a flat surface crosses it in a straight line
// until it finds a lower spot, so a pool levels in a time proportional to its
// width; a random walk would need the square of it. The direction is bit 24
// XORed with a shade bit, so freshly painted liquid sets off both ways.
fn flowsRight(c: u32) -> bool { return (((c >> 24u) ^ (c >> 8u)) & 1u) == 1u; }
fn turn(c: u32) -> u32 { return c ^ (1u << 24u); }
fn open(m: u32) -> bool { return m == EMPTY || m == SMOKE || m == FIRE; }

// a is left of b. Returns the pair after one sideways move.
fn flow(a: u32, b: u32, roll: u32) -> vec2u {
  let ma = mat(a);
  let mb = mat(b);
  if (!liquid(ma) && !liquid(mb)) {
    if (spreads(a, b, roll)) { return vec2u(b, a); }
    return vec2u(a, b);
  }
  var na = a;
  var nb = b;
  if (liquid(ma) && flowsRight(a)) {
    if (open(mb)) {
      if ((roll & 0xffu) < mobility(ma)) { return vec2u(b, a); }
      return vec2u(a, b);
    }
    na = turn(a);
  }
  if (liquid(mb) && !flowsRight(b)) {
    if (open(ma)) {
      if (((roll >> 8u) & 0xffu) < mobility(mb)) { return vec2u(b, a); }
      return vec2u(na, b);
    }
    nb = turn(b);
  }
  return vec2u(na, nb);
}

// Air, smoke and fire side by side swap at random, which lets smoke drift.
fn spreads(a: u32, b: u32, roll: u32) -> bool {
  let ma = mat(a);
  let mb = mat(b);
  if (ma == mb || !fluid(ma) || !fluid(mb)) { return false; }
  let open = ma == EMPTY || mb == EMPTY || ma == SMOKE || mb == SMOKE || ma == FIRE || mb == FIRE;
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

fn fuse(c: u32) -> u32 {
  if (mat(c) == SAND) { return GLASS | (c & 0xff00u); }
  return c;
}

fn withLife(m: u32, c: u32, life: u32) -> u32 {
  return m | (c & 0xff00u) | (min(life, 255u) << 16u);
}

fn burn(c: u32, wet: bool, roll: u32) -> u32 {
  let m = mat(c);
  if (m == WOOD && (roll & 31u) == 0u) {
    // Most of the wood goes up in flames; some is left as ash.
    if (((roll >> 5u) & 3u) == 0u) { return ASH | (c & 0xff00u); }
    return withLife(FIRE, c, 60u + ((roll >> 7u) & 63u));
  }
  if (m == FIRE && wet) { return withLife(SMOKE, c, 100u + ((roll >> 7u) & 63u)); }
  return c;
}

// Smoke thins out and disappears; fire burns out into smoke or nothing.
fn age(c: u32, roll: u32) -> u32 {
  let m = mat(c);
  let life = (c >> 16u) & 0xffu;
  if (m == SMOKE) {
    if ((roll & 3u) != 0u) { return c; }
    if (life <= 1u) { return EMPTY | (c & 0xff00u); }
    return withLife(SMOKE, c, life - 1u);
  }
  if (m == FIRE) {
    if ((roll & 1u) != 0u) { return c; }
    if (life <= 1u) {
      if (((roll >> 1u) & 1u) == 0u) { return withLife(SMOKE, c, 80u + ((roll >> 2u) & 63u)); }
      return EMPTY | (c & 0xff00u);
    }
    return withLife(FIRE, c, life - 1u);
  }
  return c;
}
