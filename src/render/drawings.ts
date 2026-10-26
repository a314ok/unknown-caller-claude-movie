import { hashString, mulberry32 } from '../core/rng';

/**
 * Procedural "wax crayon" drawings. A drawing is a function of time that returns strokes in a
 * unit box [-1, 1]². The renderer draws them with a jittering brush (frame-by-frame boil) and
 * reveals them stroke by stroke, so nothing is a static image.
 */
export type Pt = [number, number];
export type Tone = 'w' | 'r' | 'R' | 'g' | 'd'; // white, red, hot red, grey, dark grey
export interface Stroke { pts: Pt[]; tone: Tone; width?: number }
export interface DrawCtx { t: number; spin: number; stress: number; level: number; rnd: () => number }
export type DrawFn = (c: DrawCtx) => Stroke[];

const TAU = Math.PI * 2;

// ------------------------------------------------------------------ geometry helpers
const arc = (cx: number, cy: number, rx: number, ry: number, a0 = 0, a1 = TAU, n = 28): Pt[] => {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
};
const circ = (cx: number, cy: number, r: number, n = 28, a0 = 0) => arc(cx, cy, r, r, a0, a0 + TAU, n);
const line = (...p: Pt[]): Pt[] => p;
const S = (pts: Pt[], tone: Tone = 'w', width = 1): Stroke => ({ pts, tone, width });
const rot = (p: Pt, a: number, cx = 0, cy = 0): Pt => {
  const dx = p[0] - cx, dy = p[1] - cy, c = Math.cos(a), s = Math.sin(a);
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
};
const move = (pts: Pt[], dx: number, dy: number, k = 1): Pt[] => pts.map(([x, y]) => [x * k + dx, y * k + dy]);
const zig = (a: Pt, b: Pt, n: number, amp: number): Pt[] => {
  const pts: Pt[] = [a];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  for (let i = 1; i < n; i++) {
    const k = i / n, s = i % 2 ? amp : -amp;
    pts.push([a[0] + dx * k + nx * s, a[1] + dy * k + ny * s]);
  }
  pts.push(b);
  return pts;
};
/** Diagonal scribble-fill of a convex-ish box — the way a kid shades with a crayon. */
const hatch = (x0: number, y0: number, x1: number, y1: number, gap: number, tone: Tone, width = 0.7, jag = 0.015): Stroke[] => {
  const out: Stroke[] = [];
  let flip = false;
  for (let y = y0; y < y1; y += gap) {
    const row: Pt[] = flip ? [[x1, y], [x0, y + gap * 0.6]] : [[x0, y], [x1, y + gap * 0.6]];
    out.push(S(zig(row[0], row[1], 6, jag), tone, width));
    flip = !flip;
  }
  return out;
};
const cross = (cx: number, cy: number, r: number, tone: Tone = 'R', width = 1.6): Stroke[] => [
  S(line([cx - r, cy - r], [cx + r, cy + r]), tone, width),
  S(line([cx + r, cy - r], [cx - r, cy + r]), tone, width),
];
const stick = (x: number, y: number, h: number, phase = 0, tone: Tone = 'w'): Stroke[] => {
  // little running figure: head, body, arms, legs (phase swings limbs)
  const s = Math.sin(phase), c = Math.cos(phase);
  const hd = h * 0.16;
  return [
    S(circ(x, y - h * 0.5, hd, 14), tone, 1),
    S(line([x, y - h * 0.5 + hd], [x, y + h * 0.1]), tone, 1),
    S(line([x, y - h * 0.3], [x + h * 0.28 * s, y - h * 0.12], [x + h * 0.4 * s, y - h * 0.28 + h * 0.1 * c]), tone, 1),
    S(line([x, y - h * 0.3], [x - h * 0.28 * s, y - h * 0.12], [x - h * 0.4 * s, y - h * 0.28 - h * 0.1 * c]), tone, 1),
    S(line([x, y + h * 0.1], [x + h * 0.26 * c, y + h * 0.32], [x + h * 0.34 * c + h * 0.1, y + h * 0.5]), tone, 1),
    S(line([x, y + h * 0.1], [x - h * 0.26 * c, y + h * 0.32], [x - h * 0.34 * c - h * 0.1, y + h * 0.5]), tone, 1),
  ];
};
const head = (x: number, y: number, r: number, tone: Tone = 'w'): Stroke[] => [
  S(circ(x, y, r, 22), tone, 1),
  S(arc(x, y + r * 3.1, r * 2.1, r * 1.9, Math.PI * 1.12, Math.PI * 1.88, 12), tone, 1),
];

// ------------------------------------------------------------------ the drawings
const D: Record<string, DrawFn> = {
  none: () => [],

  /** sound leaving the receiver */
  soundArcs: ({ t, level }) => {
    const out: Stroke[] = [];
    for (let i = 0; i < 4; i++) {
      const r = 0.35 + i * 0.2 + level * 0.05 * (i + 1) + Math.sin(t * 2 + i) * 0.015;
      out.push(S(arc(-0.1, 0, r, r, -0.9, 0.9, 14), i > 1 ? 'g' : 'w', 1.2 - i * 0.12));
    }
    out.push(S(line([-0.78, -0.18], [-0.52, -0.18], [-0.52, 0.18], [-0.78, 0.18], [-0.78, -0.18]), 'w', 1.2));
    return out;
  },

  /** a face with nothing in it */
  emptyFace: ({ t, stress }) => {
    const out: Stroke[] = [S(arc(0, 0, 0.62, 0.78, 0, TAU, 34), 'w', 1.3), S(arc(0, 0.02, 0.57, 0.74, 0.2, TAU + 0.35, 30), 'g', 0.8)];
    // two blank eye-holes, scribbled shut
    for (const x of [-0.24, 0.24]) {
      out.push(S(arc(x, -0.14, 0.11, 0.07, 0, TAU, 14), 'g', 0.8));
      const sc = zig([x - 0.13, -0.2], [x + 0.13, -0.06], 9, 0.03);
      out.push(S(sc, 'r', 1));
    }
    out.push(S(line([-0.2, 0.34], [0.2, 0.34 + Math.sin(t * 1.5) * 0.01]), 'g', 0.9));
    // the face is being rubbed out
    const k = 0.2 + stress * 0.4;
    for (let i = 0; i < 5; i++) out.push(S(zig([-0.5 + i * 0.1, 0.55], [0.4 - i * 0.07, -0.65], 10, 0.05 + k * 0.05), 'd', 2.2));
    return out;
  },

  /** the kid you used to be, standing in his own long shadow */
  boyShadow: ({ t }) => {
    const out: Stroke[] = [];
    out.push(...head(-0.35, -0.4, 0.13, 'w'));
    out.push(S(line([-0.35, -0.02], [-0.35, 0.5]), 'w'));
    out.push(S(line([-0.35, 0.1], [-0.55, 0.3]), 'w'), S(line([-0.35, 0.1], [-0.15, 0.3]), 'w'));
    out.push(S(line([-0.35, 0.5], [-0.45, 0.85]), 'w'), S(line([-0.35, 0.5], [-0.25, 0.85]), 'w'));
    out.push(...hatch(-0.2, 0.84, 0.95, 0.96, 0.05, 'd', 1.1)); // shadow on the floor
    // an empty gap where he walked away: red footprints fading right
    for (let i = 0; i < 6; i++) out.push(S(arc(0.1 + i * 0.16, 0.7 - i * 0.05 + Math.sin(t + i) * 0.01, 0.045, 0.02, 0, TAU, 8), i > 3 ? 'r' : 'g', 0.8));
    return out;
  },

  /** hamster-in-a-wheel */
  wheel: ({ t, spin }) => {
    const out: Stroke[] = [];
    const a0 = t * (0.6 + spin * 4.2);
    out.push(S(circ(0, 0, 0.78, 40), 'w', 1.5));
    out.push(S(circ(0, 0, 0.74, 40, 0.3), 'g', 0.7));
    for (let i = 0; i < 8; i++) {
      const a = a0 + (i * TAU) / 8;
      out.push(S(line([0, 0], [Math.cos(a) * 0.76, Math.sin(a) * 0.76]), i % 2 ? 'g' : 'w', 0.8));
    }
    out.push(S(circ(0, 0, 0.05, 8), 'w', 1.2));
    // runner at the bottom of the wheel — frantic
    const ph = t * (6 + spin * 10);
    out.push(...stick(Math.sin(ph * 0.15) * 0.04, 0.5, 0.52, ph, spin > 1 ? 'R' : 'r'));
    // motion ticks
    for (let i = 0; i < 3 + Math.round(spin * 3); i++) out.push(S(line([-0.95 - i * 0.07, 0.3 + i * 0.1], [-0.82 - i * 0.07, 0.3 + i * 0.1]), 'g', 0.7));
    out.push(S(line([-0.5, 0.95], [0, 0.78], [0.5, 0.95]), 'w', 1.2));
    return out;
  },

  /** parents as looming dictators */
  dictators: ({ t }) => {
    const out: Stroke[] = [];
    for (const [x, tone] of [[-0.5, 'w'], [0.5, 'g']] as [number, Tone][]) {
      out.push(S(line([x - 0.22, 0.95], [x - 0.15, -0.05], [x - 0.07, -0.25], [x + 0.07, -0.25], [x + 0.15, -0.05], [x + 0.22, 0.95]), tone, 1.3));
      out.push(S(circ(x, -0.45, 0.17, 18), tone, 1.2));
      out.push(S(line([x - 0.08, -0.5], [x - 0.03, -0.48]), 'r', 1), S(line([x + 0.08, -0.5], [x + 0.03, -0.48]), 'r', 1));
      const wag = Math.sin(t * 5 + x * 3) * 0.03;
      out.push(S(line([x + (x < 0 ? 0.12 : -0.12), -0.05], [x + (x < 0 ? 0.4 : -0.4), -0.2 + wag], [x + (x < 0 ? 0.6 : -0.6), -0.18 + wag]), 'R', 1.5));
    }
    out.push(...stick(0, 0.72, 0.28, 0, 'w').map((s) => ({ ...s, pts: s.pts.map(([x, y]) => [x * 0.6, y * 0.6 + 0.3] as Pt) })));
    return out;
  },

  gradeAPlus: ({ t }) => {
    const j = Math.sin(t * 9) * 0.01;
    const out: Stroke[] = [
      S(line([-0.7, 0.7], [-0.35, -0.7], [0, 0.7]), 'w', 2.2),
      S(line([-0.55, 0.15], [-0.15, 0.15 + j]), 'w', 2),
      S(line([0.2, 0], [0.7, 0], [0.45, 0]), 'w', 1.8),
      S(line([0.45, -0.25], [0.45, 0.25]), 'w', 1.8),
    ];
    out.push(S(zig([-0.85, 0.85], [0.85, -0.75], 14, 0.03), 'R', 2.2));
    out.push(S(zig([-0.85, -0.75], [0.85, 0.85], 14, 0.03), 'r', 1.4));
    return out;
  },

  gradeF: ({ t, stress }) => {
    const sh = stress * 0.04;
    const w = (a: number) => a + Math.sin(t * 40 + a * 9) * sh;
    const out: Stroke[] = [
      S(line([w(-0.4), 0.85], [w(-0.4), -0.85], [w(0.5), -0.85]), 'R', 3),
      S(line([w(-0.4), 0.0], [w(0.35), 0.0]), 'R', 3),
    ];
    for (let i = 0; i < 6; i++) out.push(S(zig([-0.9 + i * 0.05, -0.95], [-0.2 + i * 0.12, 0.95], 12, 0.05), 'r', 0.9));
    return out;
  },

  bottle: ({ t }) => {
    const tilt = Math.sin(t * 1.3) * 0.08;
    const P = (pts: Pt[]) => pts.map((p) => rot(p, tilt));
    const out: Stroke[] = [
      S(P(line([-0.14, -0.9], [-0.14, -0.45], [-0.42, -0.1], [-0.42, 0.85], [0.42, 0.85], [0.42, -0.1], [0.14, -0.45], [0.14, -0.9], [-0.14, -0.9])), 'w', 1.5),
      S(P(line([-0.42, 0.25], [-0.2, 0.2 + Math.sin(t * 3) * 0.02], [0, 0.26], [0.2, 0.2], [0.42, 0.25])), 'r', 1.3),
    ];
    out.push(...hatch(-0.4, 0.28, 0.4, 0.84, 0.07, 'r', 0.8).map((s) => ({ ...s, pts: P(s.pts) })));
    out.push(S(P(line([-0.1, -1.0], [0.1, -1.0], [0.1, -0.9], [-0.1, -0.9], [-0.1, -1.0])), 'g', 1));
    // a little glass beside it
    out.push(S(line([0.62, 0.35], [0.95, 0.35], [0.88, 0.85], [0.69, 0.85], [0.62, 0.35]), 'g', 1));
    return out;
  },

  cabin: ({ t }) => {
    const out: Stroke[] = [
      S(line([-0.35, 0.5], [-0.35, 0], [0, -0.35], [0.35, 0], [0.35, 0.5], [-0.35, 0.5]), 'w', 1.4),
      S(line([-0.08, 0.5], [-0.08, 0.2], [0.1, 0.2], [0.1, 0.5]), 'g', 1),
      S(line([0.15, -0.2], [0.15, -0.5], [0.25, -0.5], [0.25, -0.1]), 'w', 1.1),
    ];
    // smoke
    const smoke: Pt[] = [];
    for (let i = 0; i < 16; i++) smoke.push([0.2 + Math.sin(t * 1.4 + i * 0.7) * 0.08 + i * 0.012, -0.55 - i * 0.045]);
    out.push(S(smoke, 'r', 1.1));
    // woods — zigzag pines closing in
    const rnd = mulberry32(31);
    for (let i = 0; i < 9; i++) {
      const x = -0.95 + i * 0.24 + (rnd() - 0.5) * 0.08;
      const h = 0.5 + rnd() * 0.35, y = 0.62;
      if (Math.abs(x) < 0.4) continue;
      out.push(S(line([x, y], [x - 0.12, y - h * 0.4], [x - 0.05, y - h * 0.4], [x - 0.1, y - h * 0.8], [x, y - h], [x + 0.1, y - h * 0.8], [x + 0.05, y - h * 0.4], [x + 0.12, y - h * 0.4], [x, y]), i % 3 ? 'g' : 'w', 1));
    }
    out.push(S(line([-1, 0.62], [1, 0.62]), 'g', 0.9));
    return out;
  },

  pills: ({ t }) => {
    const out: Stroke[] = [];
    const caps: [number, number, number][] = [[-0.45, -0.3, 0.5], [0.3, -0.45, -0.35], [-0.1, 0.25, 0.9], [0.5, 0.35, 0.1], [-0.6, 0.55, -0.7]];
    caps.forEach(([x, y, a], i) => {
      const w = 0.3, h = 0.12, wob = Math.sin(t * 2 + i) * 0.05;
      const P = (pts: Pt[]) => pts.map((p) => rot(p, a + wob, x, y));
      const body = [...arc(x - w, y, h, h, Math.PI / 2, Math.PI * 1.5, 8), [x + w, y - h] as Pt, ...arc(x + w, y, h, h, -Math.PI / 2, Math.PI / 2, 8), [x - w, y + h] as Pt];
      out.push(S(P(body), 'w', 1.2), S(P(line([x, y - h], [x, y + h])), 'g', 1));
    });
    out.push(...cross(0, 0, 0.95, 'R', 2.4));
    return out;
  },

  puppets: ({ t }) => {
    const out: Stroke[] = [];
    // the control bar
    const sway = Math.sin(t * 1.1) * 0.06;
    out.push(S(line([-0.7 + sway, -0.92], [0.7 + sway, -0.92]), 'w', 1.5), S(line([sway, -1.0], [sway, -0.92]), 'w', 1));
    const floor = 0.82;
    out.push(S(line([-0.95, floor], [0.95, floor]), 'g', 0.9));
    const xs = [-0.58, -0.2, 0.2, 0.58];
    xs.forEach((x, i) => {
      const bob = Math.sin(t * 2.2 + i * 1.3) * 0.04;
      const hot = i === 1;
      const hy = floor - 0.78 + bob;
      const lh: Pt = [x - 0.16, hy], rh: Pt = [x + 0.16, hy - bob * 2];
      // strings go to the hands
      out.push(S(line([x - 0.06 + sway, -0.92], lh), hot ? 'R' : 'g', 0.6), S(line([x + 0.06 + sway, -0.92], rh), hot ? 'R' : 'g', 0.6));
      out.push(S(circ(x, floor - 0.62, 0.075, 12), hot ? 'r' : 'w', 1));
      out.push(S(line([x, floor - 0.545], [x, floor - 0.2]), 'w', 1));
      out.push(S(line([x, floor - 0.5], lh), 'w', 1), S(line([x, floor - 0.5], rh), 'w', 1));
      out.push(S(line([x, floor - 0.2], [x - 0.08, floor]), 'w', 1), S(line([x, floor - 0.2], [x + 0.08, floor]), 'w', 1));
    });
    return out;
  },

  /** parody mask of the listener — a grin that is far too wide */
  mask: ({ t, stress }) => {
    const out: Stroke[] = [S(arc(0, 0, 0.72, 0.8, 0, TAU, 36), 'w', 1.5)];
    for (const x of [-0.28, 0.28]) {
      const r = 0.1 + Math.sin(t * 8 + x) * 0.01 * stress * 6;
      out.push(S(arc(x, -0.2, r, r, 0, TAU * 2.4, 40), 'R', 1.1));
    }
    const grin: Pt[] = [];
    for (let i = 0; i <= 24; i++) {
      const a = Math.PI * (0.06 + 0.88 * (i / 24));
      grin.push([Math.cos(a) * 0.52, 0.12 + Math.sin(a) * (0.36 + Math.sin(t * 7) * 0.02 * stress * 6)]);
    }
    out.push(S(grin, 'R', 1.8));
    for (let i = 0; i < 9; i++) {
      const g = grin[3 + i * 2];
      out.push(S(line([g[0], g[1]], [g[0] + (i % 2 ? 0.02 : -0.02), g[1] - 0.16]), 'w', 1));
    }
    out.push(S(line([-0.15, -0.55], [0.1, -0.7], [0.3, -0.55]), 'g', 1), S(arc(0.62, -0.32, 0.18, 0.18, -1, 1, 8), 'g', 0.8));
    return out;
  },

  hearts: ({ t }) => {
    const out: Stroke[] = [];
    const heart = (x: number, y: number, s: number): Pt[] => {
      const pts: Pt[] = [];
      for (let i = 0; i <= 28; i++) {
        const a = (i / 28) * TAU;
        pts.push([x + (16 * Math.sin(a) ** 3) * s * 0.032, y - (13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)) * s * 0.032]);
      }
      return pts;
    };
    const spots: [number, number, number][] = [[-0.55, -0.45, 0.8], [0.1, -0.55, 0.7], [0.62, -0.3, 0.75], [-0.3, 0.2, 0.9], [0.4, 0.35, 0.8], [-0.7, 0.62, 0.6], [0.0, 0.8, 0.6]];
    spots.forEach(([x, y, s], i) => {
      const k = 1 + Math.sin(t * 2 + i) * 0.04;
      out.push(S(heart(x, y, s * k), i % 3 === 0 ? 'r' : 'w', 1.2));
      if (i % 2 === 0) out.push(S(zig([x - 0.18 * s, y - 0.2 * s], [x + 0.18 * s, y + 0.2 * s], 8, 0.025), 'R', 1.3));
      if (i % 3 === 1) out.push(S(zig([x, y - 0.18], [x + 0.03, y + 0.22], 5, 0.04), 'g', 0.9));
    });
    return out;
  },

  tally: ({ t }) => {
    const out: Stroke[] = [];
    const count = Math.min(60, Math.floor(t * 5.5) + 3);
    const rnd = mulberry32(8);
    for (let n = 0; n < count; n++) {
      const g = Math.floor(n / 5), k = n % 5;
      const gx = -0.85 + (g % 6) * 0.3, gy = -0.65 + Math.floor(g / 6) * 0.32;
      if (k < 4) out.push(S(line([gx + k * 0.055, gy + (rnd() - 0.5) * 0.02], [gx + k * 0.055 + (rnd() - 0.5) * 0.02, gy + 0.22]), 'w', 1.3));
      else out.push(S(line([gx - 0.04, gy + 0.2], [gx + 0.24, gy + 0.02]), 'R', 1.4));
    }
    return out;
  },

  /** the one he watched, sitting on someone else's lap */
  lap: ({ t }) => {
    const out: Stroke[] = [];
    // chair + seated man
    out.push(S(line([-0.1, 0.95], [-0.1, 0.45], [0.55, 0.45], [0.55, 0.95]), 'g', 1.2), S(line([-0.1, 0.45], [-0.1, -0.15]), 'g', 1.2));
    out.push(...head(0.2, -0.28, 0.1, 'g'));
    out.push(S(line([0.2, 0.0], [0.2, 0.4], [0.55, 0.42], [0.58, 0.9]), 'g', 1.2));
    // the woman on his lap, laughing
    const sway = Math.sin(t * 2.5) * 0.03;
    out.push(S(circ(0.02 + sway, -0.08, 0.1, 16), 'w', 1.2), S(line([0.02 + sway, 0.02], [0.1, 0.4]), 'w', 1.3), S(line([0.02, 0.1], [0.28, 0.0]), 'w', 1));
    out.push(S(arc(0.02 + sway, -0.05, 0.05, 0.04, 0.2, Math.PI - 0.2, 8), 'r', 1));
    // the watcher: only an eye in the dark corner
    out.push(S(arc(-0.65, -0.3, 0.2, 0.1, Math.PI, TAU, 12), 'R', 1.4), S(arc(-0.65, -0.3, 0.2, 0.1, 0, Math.PI, 12), 'R', 1.4), S(circ(-0.65, -0.3, 0.05, 8), 'R', 2));
    out.push(S(line([-0.65, -0.18], [-0.65, 0.3]), 'd', 1.3));
    return out;
  },

  veil: ({ t }) => {
    const out: Stroke[] = [];
    out.push(S(arc(0, 0.2, 0.62, 0.9, Math.PI, TAU, 24), 'w', 1.4), S(line([-0.62, 0.2], [-0.62, 0.95]), 'w', 1.4), S(line([0.62, 0.2], [0.62, 0.95]), 'w', 1.4));
    // flowers
    for (let i = 0; i < 7; i++) {
      const a = Math.PI + (i / 6) * Math.PI;
      const x = Math.cos(a) * 0.62, y = 0.2 + Math.sin(a) * 0.9;
      out.push(S(circ(x, y, 0.045, 8), i % 2 ? 'g' : 'w', 1));
    }
    // bride + veil blowing away from "your back"
    out.push(...head(-0.05, 0.1, 0.09, 'w'));
    const veil: Pt[] = [];
    for (let i = 0; i < 20; i++) veil.push([-0.05 + i * 0.045, 0.02 + Math.sin(t * 2 + i * 0.5) * 0.04 + i * 0.012]);
    out.push(S(veil, 'g', 1));
    out.push(S(line([-0.05, 0.4], [-0.2, 0.95], [0.1, 0.95], [-0.05, 0.4]), 'w', 1.2));
    // the crack separating the two
    out.push(S(zig([0.2, -0.75], [0.1, 0.95], 12, 0.04), 'R', 1.6));
    return out;
  },

  screamMouth: ({ t, stress }) => {
    const out: Stroke[] = [];
    const open = 0.55 + Math.sin(t * 24) * 0.05 * (0.4 + stress);
    out.push(S(arc(0, 0, 0.5, open, 0, TAU, 32), 'R', 2.4));
    out.push(S(arc(0, 0.05, 0.38, open * 0.7, 0, TAU, 28), 'd', 2.2));
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU + t * 0.2;
      out.push(S(zig([Math.cos(a) * 0.62, Math.sin(a) * (open + 0.12)], [Math.cos(a) * 1.0, Math.sin(a) * 1.0], 5, 0.04), i % 2 ? 'r' : 'w', 1));
    }
    return out;
  },

  laptop: ({ t }) => {
    const out: Stroke[] = [
      S(line([-0.6, -0.55], [0.6, -0.55], [0.6, 0.25], [-0.6, 0.25], [-0.6, -0.55]), 'w', 1.5),
      S(line([-0.8, 0.25], [0.8, 0.25], [0.7, 0.45], [-0.7, 0.45], [-0.8, 0.25]), 'w', 1.4),
      // </>
      S(line([-0.15, -0.35], [-0.35, -0.15], [-0.15, 0.05]), 'w', 1.4), S(line([0.15, -0.35], [0.35, -0.15], [0.15, 0.05]), 'w', 1.4), S(line([0.06, -0.38], [-0.06, 0.08]), 'r', 1.3),
    ];
    // the graph falling
    const g: Pt[] = [];
    for (let i = 0; i < 12; i++) g.push([-0.95 + i * 0.1, 0.65 + i * 0.03 + Math.sin(t * 3 + i) * 0.03 - 0.3 * Math.exp(-i * 0.4)]);
    out.push(S(g, 'R', 1.4));
    out.push(S(line([0.3, 0.62], [0.9, 0.62]), 'g', 0.8));
    out.push(...cross(0.0, -0.15, 0.55, 'r', 1));
    return out;
  },

  clown: ({ t }) => {
    const out: Stroke[] = [S(arc(0, 0.05, 0.62, 0.7, 0, TAU, 34), 'w', 1.4)];
    for (const s of [-1, 1]) {
      out.push(S(zig([s * 0.5, -0.5], [s * 0.85, -0.78 + Math.sin(t * 3 + s) * 0.03], 8, 0.05), 'r', 1.3));
      out.push(S(zig([s * 0.55, -0.35], [s * 0.95, -0.45], 8, 0.05), 'r', 1.1));
      out.push(S(arc(s * 0.24, -0.15, 0.1, 0.12, 0, TAU, 12), 'w', 1.1));
      out.push(S(line([s * 0.24, -0.04], [s * 0.26, 0.28 + ((t * 0.5) % 1) * 0.1]), 'g', 0.8)); // tears
    }
    out.push(S(circ(0, 0.1, 0.1, 14), 'R', 2.4));
    out.push(S(arc(0, 0.2, 0.35, 0.3, 0.2, Math.PI - 0.2, 16), 'r', 1.6));
    return out;
  },

  stairs: ({ t }) => {
    const out: Stroke[] = [];
    for (let i = 0; i < 6; i++) out.push(S(line([-0.9 + i * 0.28, -0.7 + i * 0.28], [-0.62 + i * 0.28, -0.7 + i * 0.28], [-0.62 + i * 0.28, -0.42 + i * 0.28]), 'w', 1.3));
    const fall = (t * 1.2) % 1;
    out.push(...stick(-0.4 + fall * 0.9, -0.95 + fall * 1.5, 0.3, t * 9, 'R').map((s) => ({ ...s, pts: s.pts.map((p) => rot(p, fall * 3.2, -0.4 + fall * 0.9, -0.95 + fall * 1.5)) })));
    // drain at the bottom
    for (let i = 0; i < 3; i++) out.push(S(arc(0.55, 0.85, 0.3 - i * 0.08, 0.1 - i * 0.025, t * 2 + i, t * 2 + i + 5, 18), 'g', 1));
    return out;
  },

  fork: ({ t }) => {
    const out: Stroke[] = [
      S(line([0, 1], [0, 0.1], [-0.55, -0.55], [-0.62, -0.95]), 'w', 1.5),
      S(line([0, 0.1], [0.55, -0.55], [0.62, -0.95]), 'w', 1.5),
      S(line([0.12, 1], [0.12, 0.22], [0.66, -0.4]), 'g', 1),
      S(line([-0.12, 1], [-0.12, 0.2], [-0.5, -0.3]), 'g', 1),
    ];
    // two signposts, both blank
    out.push(S(line([-0.8, -0.05], [-0.4, -0.05], [-0.3, -0.15], [-0.4, -0.25], [-0.8, -0.25], [-0.8, -0.05]), 'w', 1), S(line([0.8, -0.05], [0.4, -0.05], [0.3, -0.15], [0.4, -0.25], [0.8, -0.25], [0.8, -0.05]), 'w', 1));
    out.push(...cross(-0.55, -0.15, 0.08, 'r', 1), ...cross(0.55, -0.15, 0.08, 'r', 1));
    out.push(...stick(0, 0.58, 0.26, Math.sin(t * 4) * 0.1, 'w'));
    return out;
  },

  /** an empty mirror frame; the reflection is only the memory of a shape */
  mirror: ({ t }) => {
    const out: Stroke[] = [
      S([...arc(0, -0.55, 0.55, 0.4, Math.PI, TAU, 16), [0.55, 0.95], [-0.55, 0.95], [-0.55, -0.55]], 'w', 1.6),
      S([...arc(0, -0.55, 0.47, 0.33, Math.PI, TAU, 16), [0.47, 0.88], [-0.47, 0.88], [-0.47, -0.55]], 'g', 0.8),
    ];
    const flick = 0.5 + Math.sin(t * 1.7) * 0.5;
    out.push(...head(0, -0.2, 0.14, flick > 0.2 ? 'd' : 'g'));
    out.push(S(line([-0.4, 0.05], [-0.4, 0.8]), 'd', 3), S(line([0.4, 0.05], [0.4, 0.8]), 'd', 3));
    out.push(S(zig([-0.3, -0.9], [0.3, 0.9], 11, 0.03), 'r', 0.8));
    return out;
  },
};

export const DRAWINGS = D;

export function drawingStrokes(id: string, ctx: Omit<DrawCtx, 'rnd'>): Stroke[] {
  const fn = D[id];
  if (!fn) throw new Error(`unknown drawing "${id}" in scenario (see src/render/drawings.ts)`);
  return fn({ ...ctx, rnd: mulberry32(hashString(id)) });
}

export function strokeLength(pts: Pt[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

/** The leading `frac` (0..1) of the whole drawing, stroke by stroke — how it "draws itself". */
export function revealStrokes(strokes: Stroke[], frac: number): Stroke[] {
  if (frac >= 1) return strokes;
  const lens = strokes.map((s) => strokeLength(s.pts));
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  let budget = frac * total;
  const out: Stroke[] = [];
  for (let i = 0; i < strokes.length && budget > 0; i++) {
    if (budget >= lens[i]) { out.push(strokes[i]); budget -= lens[i]; continue; }
    const pts: Pt[] = [strokes[i].pts[0]];
    let left = budget;
    for (let k = 1; k < strokes[i].pts.length && left > 0; k++) {
      const a = strokes[i].pts[k - 1], b = strokes[i].pts[k];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d <= left) { pts.push(b); left -= d; } else { const r = left / d; pts.push([a[0] + (b[0] - a[0]) * r, a[1] + (b[1] - a[1]) * r]); left = 0; }
    }
    out.push({ ...strokes[i], pts });
    budget = 0;
  }
  return out;
}

export { arc, circ, line, S, head, stick, zig, hatch, cross, move, rot };
