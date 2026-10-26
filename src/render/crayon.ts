import type { Graphics } from 'pixi.js';
import { noise1 } from '../core/rng';
import type { Pt, Stroke, Tone } from './drawings';

/** Black, white, blood red and the greys between — nothing else is ever drawn. */
export const PALETTE: Record<Tone, number> = {
  w: 0xf1ede3,   // wax white
  g: 0x8d8a82,   // soft grey
  d: 0x3b3a37,   // charcoal
  r: 0xb30d0d,   // blood
  R: 0xff2a1f,   // hot blood
};

export const BLACK = 0x000000;

export interface Brush {
  frame: number;      // quantised animation frame -> new wobble every frame (hand redrawing the page)
  wobble: number;     // px of hand tremor
  scale: number;      // px per 1.0 stroke width unit
  alpha: number;
  redMix: number;     // 0..1 tint of white strokes towards red (emotional peaks)
  seed: number;
}

const lerpHex = (a: number, b: number, k: number) => {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * k) << 16) | (Math.round(ag + (bg - ag) * k) << 8) | Math.round(ab + (bb - ab) * k);
};

/** Resample a polyline so the tremor has something to bite into. */
function resample(pts: Pt[], step: number): Pt[] {
  if (pts.length < 2) return pts;
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(d / step));
    for (let k = 1; k <= n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  return out;
}

/** Draw px-space polylines with the wax-crayon brush: two to three offset, trembling passes. */
export function crayonPolyline(g: Graphics, pts: Pt[], tone: Tone, width: number, b: Brush, sid = 0) {
  if (pts.length < 2) return;
  const base = PALETTE[tone];
  const color = tone === 'w' && b.redMix > 0 ? lerpHex(base, PALETTE.r, b.redMix * 0.6) : base;
  const rs = resample(pts, 11);
  const passes = width > 1.7 ? 3 : 2;
  for (let p = 0; p < passes; p++) {
    const off = (p - (passes - 1) / 2) * (0.8 + width * 0.5);
    const w = Math.max(1.4, b.scale * width * (p === 1 ? 0.55 : 1) * (1 - p * 0.08));
    g.moveTo(rs[0][0], rs[0][1]);
    for (let i = 0; i < rs.length; i++) {
      const n = i * 0.37 + b.frame * 4.13 + sid * 11.7 + p * 5.1;
      const jx = noise1(n, b.seed) * b.wobble;
      const jy = noise1(n + 91.7, b.seed + 1) * b.wobble;
      const x = rs[i][0] + jx + off, y = rs[i][1] + jy + off * 0.6;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke({ width: w, color, alpha: b.alpha * (p === 1 ? 0.62 : 0.9), cap: 'round', join: 'round' });
  }
}

/** Unit-box strokes -> px, centered at (cx, cy) with half-size `half`. */
export function crayonStrokes(g: Graphics, strokes: Stroke[], cx: number, cy: number, half: number, b: Brush, sidBase = 0) {
  strokes.forEach((s, i) => {
    const pts: Pt[] = s.pts.map(([x, y]) => [cx + x * half, cy + y * half]);
    crayonPolyline(g, pts, s.tone, s.width ?? 1, b, sidBase + i);
  });
}
