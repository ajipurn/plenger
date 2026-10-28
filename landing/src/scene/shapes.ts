/**
 * Target layouts for the particle field. Every function fills `count` xyz triples so
 * the vertex shader can blend between them per particle.
 */

/** The snippet the scan sweeps. Line numbers match the finding in the dashboard mock. */
export const CODE_LINES = [
  "from agents import Agent, tool",
  "import subprocess",
  "",
  "@tool",
  "def run_command(command: str) -> str:",
  '    """Run a shell command for the agent."""',
  "    result = subprocess.run(",
  "        command,",
  "        shell=True,",
  "        capture_output=True,",
  "    )",
  "    return result.stdout.decode()",
  "",
  "agent = Agent(tools=[run_command])",
  "reply = agent.run(user_message)",
];

/** Zero-based lines that light up as findings once the scan has passed them. */
const FLAGGED_LINES = new Set([7, 8, 14]);

export const STRIDE_SEGMENTS = 6;

type Random = () => number;

/** Small deterministic generator so the layout is the same on every load. */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A noisy shell with a sparse core: the repository before anyone has read it. */
export function sphere(count: number, radius: number, random: Random): Float32Array {
  const out = new Float32Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const ring = Math.sqrt(1 - y * y);
    const theta = golden * i;
    const core = random() < 0.1;
    const r = core ? radius * Math.cbrt(random()) * 0.92 : radius * (1 + (random() - 0.5) * 0.06);
    out[i * 3] = Math.cos(theta) * ring * r;
    out[i * 3 + 1] = y * r;
    out[i * 3 + 2] = Math.sin(theta) * ring * r;
  }
  return out;
}

/**
 * The emblem: a shield with a keyhole cut through it, in a 200 by 200 box centred on
 * (100, 100). The particle field samples these paths and the hero's static poster draws
 * them as SVG, so both show the same outline. Fill with the even-odd rule.
 */
export const SHIELD_PATH =
  "M30 42Q100 14 170 42L170 98C170 140 142 166 100 186C58 166 30 140 30 98Z";
export const KEYHOLE_PATH = "M92.5 99A15 15 0 1 1 107.5 99L111.3 125L88.7 125Z";

/** Half thickness in outline units at a point `depth` units inside the edge. */
const profile = (depth: number) => Math.min(3.2 * Math.sqrt(depth), 15);

/**
 * Samples the emblem and inflates it into a solid: each point gets a thickness from
 * `profile`, most particles sit on the front and back surfaces, and the edges,
 * including the keyhole, get a wall of their own so they read sharply.
 */
export function emblem(count: number, random: Random): Float32Array {
  const size = 220;
  const out = new Float32Array(count * 3);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return out;
  context.fillStyle = "#fff";
  context.translate(10, 10);
  context.fill(new Path2D(SHIELD_PATH + KEYHOLE_PATH), "evenodd");

  const { data } = context.getImageData(0, 0, size, size);
  // Chamfer distance from the nearest outside pixel, in two passes.
  const depth = new Float32Array(size * size);
  for (let i = 0; i < depth.length; i++) depth[i] = (data[i * 4 + 3] ?? 0) > 127 ? 1e6 : 0;
  const at = (x: number, y: number) =>
    x < 0 || y < 0 || x >= size || y >= size ? 0 : (depth[y * size + x] ?? 0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (depth[i] === 0) continue;
      depth[i] = Math.min(
        depth[i] ?? 0,
        at(x - 1, y) + 1,
        at(x, y - 1) + 1,
        at(x - 1, y - 1) + Math.SQRT2,
        at(x + 1, y - 1) + Math.SQRT2,
      );
    }
  }
  for (let y = size - 1; y >= 0; y--) {
    for (let x = size - 1; x >= 0; x--) {
      const i = y * size + x;
      if (depth[i] === 0) continue;
      depth[i] = Math.min(
        depth[i] ?? 0,
        at(x + 1, y) + 1,
        at(x, y + 1) + 1,
        at(x + 1, y + 1) + Math.SQRT2,
        at(x - 1, y + 1) + Math.SQRT2,
      );
    }
  }

  const inside: number[] = [];
  const edge: number[] = [];
  for (let i = 0; i < depth.length; i++) {
    if ((depth[i] ?? 0) > 0) inside.push(i);
    if ((depth[i] ?? 0) > 0 && (depth[i] ?? 0) < 1.5) edge.push(i);
  }
  if (inside.length === 0) return out;

  // 200 outline units span 3.8 world units, the old sphere's diameter.
  const scale = 3.8 / 200;
  for (let i = 0; i < count; i++) {
    const roll = random();
    const pool = roll < 0.16 && edge.length > 0 ? edge : inside;
    const pixel = pool[Math.floor(random() * pool.length)] ?? 0;
    const x = (pixel % size) - 10 + random() - 0.5;
    const y = Math.floor(pixel / size) - 10 + random() - 0.5;
    const half = profile(depth[pixel] ?? 0);
    let z: number;
    if (pool === edge) z = (random() * 2 - 1) * half;
    else if (roll < 0.88) z = (random() < 0.5 ? -1 : 1) * half * (1 + (random() - 0.5) * 0.06);
    else z = (random() * 2 - 1) * half * 0.9;
    out[i * 3] = (x - 100) * scale;
    out[i * 3 + 1] = -(y - 100) * scale;
    out[i * 3 + 2] = z * scale;
  }
  return out;
}

export type CodeLayout = { positions: Float32Array; flags: Float32Array };

/**
 * Renders the snippet to an offscreen canvas and samples lit pixels, so the particles
 * spell real, readable source. Line numbers are drawn fainter and receive fewer samples.
 */
export function code(count: number, random: Random, font: string): CodeLayout {
  const size = 30;
  const lineHeight = 44;
  const gutter = size * 2.6;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const positions = new Float32Array(count * 3);
  const flags = new Float32Array(count);
  if (!context) return { positions, flags };

  context.font = `500 ${size}px ${font}`;
  const textWidth = Math.max(...CODE_LINES.map((line) => context.measureText(line).width));
  canvas.width = Math.ceil(gutter + textWidth + size);
  canvas.height = Math.ceil(lineHeight * CODE_LINES.length + size);
  context.font = `500 ${size}px ${font}`;
  context.textBaseline = "top";
  context.fillStyle = "#fff";

  CODE_LINES.forEach((line, index) => {
    const y = size * 0.5 + index * lineHeight;
    context.globalAlpha = 0.28;
    context.fillText(String(index + 1).padStart(2, "0"), 0, y);
    context.globalAlpha = 1;
    context.fillText(line, gutter, y);
  });

  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
  const lit: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3] ?? 0;
      if (alpha > 90 && random() < alpha / 255) lit.push(x, y);
    }
  }
  if (lit.length === 0) return { positions, flags };

  // Fit the block inside 6.4 x 4.3 world units, centred on the origin.
  const scale = Math.min(6.4 / width, 4.3 / height);
  const pixels = lit.length / 2;
  for (let i = 0; i < count; i++) {
    const pick = Math.floor(random() * pixels) * 2;
    const px = (lit[pick] ?? 0) + random() - 0.5;
    const py = (lit[pick + 1] ?? 0) + random() - 0.5;
    const line = Math.floor((py - size * 0.5) / lineHeight);
    positions[i * 3] = (px - width / 2) * scale;
    positions[i * 3 + 1] = -(py - height / 2) * scale;
    positions[i * 3 + 2] = (random() - 0.5) * 0.04;
    flags[i] = FLAGGED_LINES.has(line) && px > gutter ? 1 : 0;
  }
  return { positions, flags };
}

export type RingLayout = { positions: Float32Array; segments: Float32Array };

/** Six arcs of a torus, one per STRIDE category, read clockwise from the top. */
export function ring(count: number, radius: number, random: Random): RingLayout {
  const positions = new Float32Array(count * 3);
  const segments = new Float32Array(count);
  const span = (Math.PI * 2) / STRIDE_SEGMENTS;
  const gap = 0.14;
  for (let i = 0; i < count; i++) {
    const segment = i % STRIDE_SEGMENTS;
    const theta = Math.PI / 2 - (segment * span + gap / 2 + random() * (span - gap));
    const halo = random() < 0.08;
    const tube = halo ? 0.25 + random() * 0.9 : 0.2 * Math.sqrt(random());
    const phi = random() * Math.PI * 2;
    const r = radius + Math.cos(phi) * tube;
    positions[i * 3] = Math.cos(theta) * r;
    positions[i * 3 + 1] = Math.sin(theta) * r;
    positions[i * 3 + 2] = Math.sin(phi) * tube;
    segments[i] = segment;
  }
  return { positions, segments };
}

/** A wide, shallow volume of dust that sits behind content. */
export function field(count: number, random: Random): Float32Array {
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    out[i * 3] = (random() - 0.5) * 18;
    out[i * 3 + 1] = (random() - 0.5) * 10;
    out[i * 3 + 2] = -7 + random() * 8;
  }
  return out;
}
