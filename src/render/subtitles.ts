import { Container, Graphics, Text } from 'pixi.js';
import { clamp, smoothstep } from '../core/rng';
import type { SubtitleCue } from '../core/types';

/**
 * Ukrainian subtitles, always in the bottom third. Rendered *inside* the frame (no DOM), so they
 * are part of every exported WebM. At most two rows; cues come pre-wrapped from core/cues.ts.
 */
export class SubtitleView {
  readonly container = new Container();
  private readonly plate = new Graphics();
  private readonly text: Text;
  private currentText = '';
  private w = 1920;
  private h = 1080;
  private size = 52;

  constructor() {
    this.text = new Text({
      text: '',
      style: {
        fontFamily: 'Cormorant Garamond',
        fontWeight: '600',
        fontSize: this.size,
        fill: 0xf5f1e8,
        align: 'center',
        lineHeight: this.size * 1.16,
        letterSpacing: 0.6,
        stroke: { color: 0x000000, width: 8, join: 'round' },
        dropShadow: { color: 0x000000, alpha: 0.85, blur: 7, distance: 2, angle: Math.PI / 2 },
      },
    });
    this.text.anchor.set(0.5, 1);
    this.container.addChild(this.plate, this.text);
  }

  layout(w: number, h: number) {
    this.w = w; this.h = h;
    const portrait = h > w;
    this.size = portrait ? 50 : 54;
    this.text.style.fontSize = this.size;
    this.text.style.lineHeight = this.size * 1.16;
    this.text.position.set(w / 2, h - (portrait ? 150 : 92));
    // soft dark floor under the text so it reads over any drawing
    this.plate.clear();
    const bandH = h * (portrait ? 0.2 : 0.3);
    const steps = 18;
    for (let i = 0; i < steps; i++) {
      const k = i / (steps - 1);
      this.plate.rect(-80, h - bandH + (bandH * i) / steps, w + 160, bandH / steps + 1).fill({ color: 0x000000, alpha: Math.pow(k, 1.6) * 0.78 });
    }
  }

  update(cue: SubtitleCue | null, t: number, redness: number, tremor: number) {
    if (!cue) { this.text.alpha = 0; this.plate.alpha = 0; return; }
    if (cue.text !== this.currentText) { this.currentText = cue.text; this.text.text = cue.text; }
    const fadeIn = clamp((t - cue.start) / 0.16);
    const fadeOut = clamp((cue.hide - t) / 0.24);
    const a = Math.min(fadeIn, fadeOut);
    this.text.alpha = smoothstep(0, 1, a);
    this.plate.alpha = this.text.alpha;
    const rise = (1 - smoothstep(0, 1, fadeIn)) * 8;
    this.text.y = this.h - (this.h > this.w ? 150 : 92) + rise + (tremor > 0 ? Math.sin(t * 61) * tremor * 2.2 : 0);
    this.text.x = this.w / 2 + (tremor > 0 ? Math.sin(t * 47 + 1) * tremor * 2.6 : 0);
    // the red creeps into the type at emotional peaks
    const r = clamp(redness);
    this.text.style.fill = r > 0.55 ? mixHex(0xf5f1e8, 0xff3a2a, (r - 0.55) * 0.9) : 0xf5f1e8;
  }
}

function mixHex(a: number, b: number, k: number): number {
  const m = (s: number) => Math.round(((a >> s) & 255) + ((((b >> s) & 255) - ((a >> s) & 255)) * k));
  return (m(16) << 16) | (m(8) << 8) | m(0);
}
