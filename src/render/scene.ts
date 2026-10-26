import { Application, Container, Graphics, Text } from 'pixi.js';
import { clamp, lerp, mulberry32, noise1, smoothstep } from '../core/rng';
import type { SceneParams, SpeakerId, SubtitleCue } from '../core/types';
import { BLACK, crayonPolyline, crayonStrokes, type Brush } from './crayon';
import { drawingStrokes, revealStrokes, type Pt } from './drawings';
import { CrayonFilter } from './filter';
import { SubtitleView } from './subtitles';

export type Phase = 'black' | 'ringing' | 'answering' | 'call' | 'ended';

export interface FrameState {
  phase: Phase;
  clock: number;        // monotonic seconds (audio clock) - freezes while paused
  phaseT: number;       // seconds inside the current phase
  callT: number;        // call time
  p: SceneParams;
  voice: number;        // instantaneous voice loudness 0..1
  speaker: SpeakerId | null;
  draw: string;         // drawing id of the current line
  cue: SubtitleCue | null;
  ringOn: boolean;
  answerPress: number;  // 0..1
  label: string;
  lineDropped: boolean;  // the call has actually been cut (after the last word)
}

interface Scratch { pts: Pt[]; th: number; tone: 'r' | 'R' | 'w' | 'g'; width: number }

/** Design-space layout; everything is authored for 1920x1080 or 1080x1920 and scaled to the canvas. */
export function designSize(portrait: boolean) { return portrait ? { W: 1080, H: 1920 } : { W: 1920, H: 1080 }; }

export class CallScene {
  readonly root = new Container();
  private readonly world = new Container();
  private readonly gBg = new Graphics();
  private readonly gGhost = new Graphics();
  private readonly gDraw = new Graphics();
  private readonly gPresence = new Graphics();
  private readonly gUi = new Graphics();
  private readonly gScratch = new Graphics();
  private readonly gFlash = new Graphics();
  private readonly label: Text;
  private readonly status: Text;
  private readonly timer: Text;
  private readonly answerTxt: Text;
  private readonly declineTxt: Text;
  private readonly filter = new CrayonFilter();
  readonly subs = new SubtitleView();
  private W = 1920;
  private H = 1080;
  private portrait = false;
  private scratches: Scratch[] = [];
  private lastFrame10 = -1;
  private lastFrame20 = -1;
  private cur = { id: 'none', since: 0 };
  private old = { id: 'none', since: 0, until: 0 };
  private lastState: FrameState | null = null;

  constructor(private readonly app: Application) {
    const font = (family: string, size: number, fill: number, extra: Record<string, unknown> = {}) =>
      new Text({ text: '', style: { fontFamily: family, fontSize: size, fill, align: 'center', ...extra } });
    this.label = font('Permanent Marker', 84, 0xf1ede3, { letterSpacing: 4 });
    this.status = font('Special Elite', 30, 0x8d8a82, { letterSpacing: 3 });
    this.timer = font('Special Elite', 34, 0xb9b5ab, { letterSpacing: 5 });
    this.answerTxt = font('Permanent Marker', 30, 0xf1ede3, { letterSpacing: 3 });
    this.declineTxt = font('Permanent Marker', 30, 0xb30d0d, { letterSpacing: 3 });
    for (const t of [this.label, this.status, this.timer, this.answerTxt, this.declineTxt]) t.anchor.set(0.5);
    this.world.addChild(this.gBg, this.gScratch, this.gGhost, this.gDraw, this.gPresence, this.gUi,
      this.label, this.status, this.timer, this.answerTxt, this.declineTxt, this.gFlash);
    this.world.filters = [this.filter];
    this.root.addChild(this.world, this.subs.container);
    app.stage.addChild(this.root);
    this.makeScratches();
  }

  // ---------------------------------------------------------------- layout
  setFormat(portrait: boolean, pixelW: number, pixelH: number) {
    this.portrait = portrait;
    const { W, H } = designSize(portrait);
    this.W = W; this.H = H;
    this.app.renderer.resize(pixelW, pixelH);
    this.root.scale.set(pixelW / W);
    this.world.pivot.set(W / 2, H / 2);
    this.world.position.set(W / 2, H / 2);
    this.gBg.clear().rect(-80, -80, W + 160, H + 160).fill(BLACK);
    this.filter.setResolution(pixelW, pixelH);
    this.subs.layout(W, H);
    this.label.style.fontSize = portrait ? 66 : 84;
    this.lastFrame10 = -1; this.lastFrame20 = -1;
    this.makeScratches();
    if (this.lastState) this.render(this.lastState);
  }

  get layout() {
    const { W, H } = this;
    const p = this.portrait;
    return {
      label: [W / 2, H * (p ? 0.075 : 0.105)] as Pt,
      status: [W / 2, H * (p ? 0.075 : 0.105) + (p ? 62 : 78)] as Pt,
      timer: [W / 2, H * (p ? 0.075 : 0.105) + (p ? 112 : 130)] as Pt,
      presence: [W * (p ? 0.5 : 0.3), H * (p ? 0.33 : 0.52)] as Pt,
      presenceR: p ? 190 : 215,
      draw: [W * (p ? 0.5 : 0.69), H * (p ? 0.64 : 0.5)] as Pt,
      drawHalf: p ? 290 : 285,
      answer: [W / 2 + (p ? 160 : 150), H * (p ? 0.78 : 0.8)] as Pt,
      decline: [W / 2 - (p ? 160 : 150), H * (p ? 0.78 : 0.8)] as Pt,
      btnR: 62,
    };
  }

  /** Hit rectangle of the ANSWER button as fractions of the canvas, for the DOM click target. */
  answerHit() {
    const l = this.layout;
    return { x: (l.answer[0] - 110) / this.W, y: (l.answer[1] - 110) / this.H, w: 220 / this.W, h: 250 / this.H };
  }

  private makeScratches() {
    const rnd = mulberry32(777);
    this.scratches = [];
    const { W, H } = this;
    for (let i = 0; i < 110; i++) {
      const claw = rnd() < 0.22;
      const x0 = rnd() * W, y0 = rnd() * H;
      const a = rnd() * Math.PI * 2;
      const len = (claw ? 260 : 160) + rnd() * (claw ? 520 : 780);
      const n = 6 + Math.floor(rnd() * 8);
      const mk = (ox: number, oy: number): Pt[] => {
        const pts: Pt[] = [];
        for (let k = 0; k <= n; k++) {
          const d = (k / n) * len;
          pts.push([x0 + ox + Math.cos(a) * d + (rnd() - 0.5) * 14, y0 + oy + Math.sin(a) * d + (rnd() - 0.5) * 14]);
        }
        return pts;
      };
      const th = Math.pow(i / 110, 0.9);
      const tone: Scratch['tone'] = rnd() < 0.7 ? 'r' : rnd() < 0.5 ? 'g' : 'R';
      if (claw) for (let c = 0; c < 3; c++) this.scratches.push({ pts: mk(-Math.sin(a) * c * 16, Math.cos(a) * c * 16), th, tone, width: 0.9 });
      else this.scratches.push({ pts: mk(0, 0), th, tone, width: 0.7 + rnd() * 0.9 });
    }
  }

  // ---------------------------------------------------------------- per-frame
  render(s: FrameState) {
    this.lastState = s;
    const { p } = s;
    const visible = s.phase !== 'black' && s.phase !== 'ended';
    this.world.visible = visible;
    this.subs.container.visible = s.phase === 'call';
    if (!visible) { this.app.render(); return; }

    const f10 = Math.floor(s.clock * 10);
    const f20 = Math.floor(s.clock * 20);
    const cleanK = clamp(p.clean);
    const dead = clamp(p.dead);

    // drawing slots: a new id replaces the old, which fades out
    if (s.draw !== this.cur.id) {
      this.old = { id: this.cur.id, since: this.cur.since, until: s.clock + 0.45 };
      this.cur = { id: s.draw, since: s.clock };
    }

    if (f10 !== this.lastFrame10) { this.lastFrame10 = f10; this.redrawSlow(s, f10); }
    if (f20 !== this.lastFrame20) { this.lastFrame20 = f20; this.redrawPresence(s, f20); }

    // camera: tremor, ring buzz, shock shakes
    const tremor = p.stress * 5 + p.shake * 30 + (s.ringOn ? 7 : 0) + (s.phase === 'answering' ? 3 : 0);
    const shakeK = 1 - dead * 0.85;
    const c = s.clock;
    this.world.position.set(
      this.W / 2 + noise1(c * (14 + p.shake * 40), 3) * tremor * shakeK,
      this.H / 2 + noise1(c * (13 + p.shake * 40), 9) * tremor * shakeK);
    this.world.rotation = noise1(c * 9, 5) * 0.0018 * (p.stress + p.shake * 4) * shakeK;
    this.world.scale.set(1 + p.shake * 0.012 * Math.sin(c * 31));

    // flash overlay (white/red burst)
    this.gFlash.clear();
    if (p.flash > 0.01) this.gFlash.rect(-80, -80, this.W + 160, this.H + 160).fill({ color: p.flash > 0.6 ? 0xff2a1f : 0xf1ede3, alpha: p.flash * 0.22 });

    this.filter.set({
      uTime: s.clock,
      uFrame: f10,
      uGrain: lerp(0.9, 0.55, cleanK * 0.4),
      uNoise: 0.045 + p.stress * 0.04 + dead * 0.03,
      uRed: clamp(p.red) * (1 - dead * 0.7),
      uFlash: p.flash,
      uDead: dead,
      uWobble: clamp(p.stress + p.shake),
      uBeat: s.phase === 'call' ? Math.max(0, Math.sin(c * (2.4 + p.atmos.bass * 2)) ** 24) * p.atmos.bass * 0.8 : 0,
    });

    this.subs.update(s.cue, s.callT, p.red > 0.7 ? p.red : 0, p.shake > 0.3 ? p.shake : 0);
    this.app.render();
  }

  private brush(s: FrameState, frame: number, scale: number, seed: number): Brush {
    const p = s.p;
    return {
      frame,
      wobble: 1.1 + p.stress * 4.5 + p.shake * 6,
      scale,
      alpha: 1,
      redMix: clamp(p.red - 0.35) * 0.9,
      seed,
    };
  }

  // 10 fps: the "redrawn page" layers
  private redrawSlow(s: FrameState, f: number) {
    const { p } = s;
    const L = this.layout;
    const dead = clamp(p.dead);
    const clutter = clamp(1 - p.clean);
    const b = this.brush(s, f, 4.2, 1);

    // --- texts: label, status, timer
    const lt = L.label;
    const j = (k: number, amp: number) => noise1(f * 0.9 + k, 7) * amp;
    this.label.text = this.garble(s.label, p.decay * (s.phase === 'call' ? 1 : 0.2) * (1 - dead), f);
    this.label.position.set(lt[0] + j(1, 3 + p.stress * 6), lt[1] + j(2, 2 + p.stress * 4));
    this.label.rotation = j(3, 0.012 + p.decay * 0.025);
    this.label.alpha = lerp(1, 0.35, dead) * lerp(1, 0.55, clamp(p.clean));
    this.label.tint = 0xffffff;
    this.status.text = s.phase === 'ringing' ? 'incoming call' : s.phase === 'answering' ? 'connecting' : s.lineDropped ? 'call ended' : 'connected';
    this.status.position.set(L.status[0], L.status[1]);
    this.status.alpha = 0.9 * lerp(1, 0.4, dead);
    const secs = Math.max(0, Math.floor(s.callT));
    const mm = String(Math.floor(secs / 60)).padStart(2, '0'), ss = String(secs % 60).padStart(2, '0');
    this.timer.text = s.phase === 'call' ? this.garbleDigits(`${mm}:${ss}`, p.decay * (1 - dead), f) : '';
    this.timer.position.set(L.timer[0], L.timer[1]);
    this.timer.alpha = 0.8 * lerp(1, 0.3, dead) * lerp(1, 0.5, clamp(p.clean));

    // --- ring buttons
    const showBtn = s.phase === 'ringing' || s.phase === 'answering';
    this.answerTxt.visible = this.declineTxt.visible = showBtn;
    this.gUi.clear();
    if (showBtn) {
      this.answerTxt.text = 'ANSWER';
      this.declineTxt.text = 'DECLINE';
      this.answerTxt.position.set(L.answer[0], L.answer[1] + L.btnR + 44);
      this.declineTxt.position.set(L.decline[0], L.decline[1] + L.btnR + 44);
      const pulse = 1 + Math.sin(s.clock * 7) * 0.05 * (s.phase === 'ringing' ? 1 : 0);
      const press = s.answerPress;
      const bw = this.brush(s, f, 4.4, 2);
      crayonPolyline(this.gUi, this.circle(L.answer[0], L.answer[1], L.btnR * pulse * (1 - press * 0.12), 26, f), 'w', 1.5, bw, 1);
      if (press > 0) for (let i = 0; i < 6; i++) crayonPolyline(this.gUi, this.circle(L.answer[0], L.answer[1], L.btnR * (0.15 + i * 0.13) * (1 - press * 0.12), 20, f + i), 'w', 1.1, { ...bw, alpha: 0.5 + press * 0.5 }, 3 + i);
      this.handset(this.gUi, L.answer[0], L.answer[1], 30, bw, 'w', 0);
      crayonPolyline(this.gUi, this.circle(L.decline[0], L.decline[1], L.btnR, 26, f + 3), 'r', 1.5, bw, 9);
      this.handset(this.gUi, L.decline[0], L.decline[1], 30, bw, 'r', Math.PI * 0.75);
    } else if (s.phase === 'call') {
      // a dead "hang up" ring in the corner that the scribbles slowly take over
      const hx = this.portrait ? this.W / 2 : this.W * 0.5, hy = this.H * (this.portrait ? 0.9 : 0.8);
      if (clutter > 0.15 && s.p.dead < 0.5 && !this.portrait) {
        const bb = { ...b, alpha: clutter * (1 - p.decay * 0.6) };
        crayonPolyline(this.gUi, this.circle(hx - 520, hy, 44, 20, f), 'r', 1.1, bb, 20);
        crayonPolyline(this.gUi, [[hx - 540, hy - 14], [hx - 500, hy + 14]], 'r', 1, bb, 21);
        crayonPolyline(this.gUi, this.circle(hx + 520, hy, 44, 20, f + 1), 'g', 1.1, bb, 22);
      }
    }
    // --- label scribble-over: the call UI is being destroyed
    if (s.phase === 'call' && p.decay > 0.18 && dead < 0.9) {
      const n = Math.floor(p.decay * 6);
      const half = this.label.width / 2 + 30;
      for (let i = 0; i < n; i++) {
        const y = lt[1] + (i % 3 - 1) * 20 + noise1(f * 0.2 + i * 9, 4) * 14;
        const x0 = lt[0] - half + noise1(i * 17.3, 5) * 60;
        crayonPolyline(this.gUi, [[x0, y], [x0 + half * 0.7, y + 14], [lt[0] + half * 0.6, y - 8], [lt[0] + half + noise1(i * 7.1, 2) * 50, y + 10]], i % 2 ? 'R' : 'r', 1.2, { ...b, alpha: 0.55 * clutter + 0.3 }, 30 + i);
      }
    }

    // --- scratches
    this.gScratch.clear();
    if (s.phase === 'call') {
      const thr = clamp(p.decay * 0.98 * lerp(1, 0.05, clamp(p.clean)) + p.scratchBoost * 0.55);
      const sb = { ...b, wobble: 2.4, scale: 3.2, alpha: 0.7 * (1 - dead * 0.7) };
      for (let i = 0; i < this.scratches.length; i++) {
        const sc = this.scratches[i];
        if (sc.th > thr) continue;
        crayonPolyline(this.gScratch, sc.pts, sc.tone, sc.width, sb, 100 + i);
      }
    }

    // --- drawings (current + fading old)
    this.gDraw.clear();
    if (s.phase === 'call') {
      const fade = 1 - smoothstep(0, 1, clutter < 1 ? p.clean * 0.9 : 0);
      this.paintDrawing(this.cur.id, s, f, s.clock - this.cur.since, 1, fade);
      if (this.old.id !== 'none' && s.clock < this.old.until) this.paintDrawing(this.old.id, s, f, 99, clamp((this.old.until - s.clock) / 0.45), fade);
    }

    // --- ghosts
    this.gGhost.clear();
    if (s.phase === 'call' && p.ghosts > 0) this.paintGhosts(p.ghosts, s, f);
  }

  private paintDrawing(id: string, s: FrameState, f: number, age: number, alpha: number, fade: number) {
    if (id === 'none' || alpha <= 0.01 || fade <= 0.01) return;
    const L = this.layout;
    const t = s.clock;
    const strokes = drawingStrokes(id, { t, spin: s.p.spin, stress: s.p.stress, level: s.voice });
    const reveal = smoothstep(0, 1, clamp(age / 1.6));
    const b = this.brush(s, f, 5, 50);
    b.alpha = alpha * fade * (1 - clamp(s.p.dead) * 0.8);
    crayonStrokes(this.gDraw, revealStrokes(strokes, reveal), L.draw[0], L.draw[1], L.drawHalf, b, 200);
  }

  private paintGhosts(n: number, s: FrameState, f: number) {
    const rnd = mulberry32(4242);
    const b = this.brush(s, f, 3.4, 77);
    for (let i = 0; i < n; i++) {
      const x = this.W * (0.1 + 0.8 * (n === 1 ? 0.5 : i / (n - 1))) + noise1(s.clock * 0.6 + i * 5, 6) * 40;
      const y = this.H * (this.portrait ? 0.5 : 0.62) + rnd() * 60 + noise1(s.clock * 0.4 + i, 8) * 20;
      const k = (this.portrait ? 1.1 : 1.35) * (0.8 + rnd() * 0.5);
      const a = 0.22 + 0.2 * Math.sin(s.clock * 3 + i * 1.7) ** 2;
      const hb = { ...b, alpha: a };
      crayonPolyline(this.gGhost, this.circle(x, y - 150 * k, 46 * k, 16, f + i), i % 2 ? 'g' : 'w', 1.2, hb, 300 + i);
      crayonPolyline(this.gGhost, [[x - 120 * k, y + 160 * k], [x - 100 * k, y - 60 * k], [x - 40 * k, y - 100 * k], [x + 40 * k, y - 100 * k], [x + 100 * k, y - 60 * k], [x + 120 * k, y + 160 * k]], 'g', 1.2, hb, 310 + i);
      for (let h = 0; h < 5; h++) crayonPolyline(this.gGhost, [[x - 70 * k + h * 28 * k, y - 80 * k], [x - 90 * k + h * 30 * k, y + 150 * k]], 'd', 2.2, { ...hb, alpha: a * 0.9 }, 320 + i * 7 + h);
      // red eyes
      crayonPolyline(this.gGhost, [[x - 20 * k, y - 156 * k], [x - 8 * k, y - 154 * k]], 'R', 1.4, { ...hb, alpha: 0.9 }, 340 + i);
      crayonPolyline(this.gGhost, [[x + 8 * k, y - 154 * k], [x + 20 * k, y - 156 * k]], 'R', 1.4, { ...hb, alpha: 0.9 }, 350 + i);
    }
  }

  // 20 fps: the voice made visible
  private redrawPresence(s: FrameState, f: number) {
    const g = this.gPresence;
    g.clear();
    if (s.phase === 'black' || s.phase === 'ended') return;
    const { p } = s;
    const L = this.layout;
    const dead = clamp(p.dead);
    const [cx, cy] = s.phase === 'ringing' || s.phase === 'answering' ? [this.W / 2, this.H * (this.portrait ? 0.36 : 0.47)] : L.presence;
    const R = L.presenceR;
    const b = this.brush(s, f, 4.6, 12);
    const aSpeaking = s.speaker === 'A' || s.speaker === null;
    const level = s.phase === 'call' ? s.voice : s.phase === 'ringing' ? (s.ringOn ? 0.55 + 0.25 * Math.sin(s.clock * 70) : 0.08) : 0.15;
    const t = s.clock;
    if (dead > 0.97 || (s.phase === 'call' && p.dead > 0.6)) {
      // the call is nearly dead: one flat quivering line and a red tick
      const k = 1 - clamp((dead - 0.6) / 0.4) * 0.4;
      const pts: Pt[] = [];
      for (let i = 0; i <= 40; i++) pts.push([cx - R * 1.1 + (i / 40) * R * 2.2, cy + noise1(i * 0.7 + t * 2, 3) * (2 + level * 36)]);
      crayonPolyline(g, pts, 'w', 1.2, { ...b, alpha: 0.65 * k }, 5);
      crayonPolyline(g, [[cx + R * 1.1 + 12, cy - 14], [cx + R * 1.1 + 12, cy + 14]], 'r', 1.1, { ...b, alpha: 0.5 }, 6);
      return;
    }
    const loops = 6;
    const energy = (s.phase === 'call' ? 0.18 + level * 1.05 : level) * (1 + p.stress * 0.5);
    for (let i = 0; i < loops; i++) {
      const base = R * (0.28 + i * 0.145);
      const pts: Pt[] = [];
      const n = 56;
      const sp = s.phase === 'call' ? 0.55 + p.stress * 1.6 : 0.8;
      for (let k = 0; k <= n; k++) {
        const a = (k / n) * Math.PI * 2;
        const ripple = noise1(Math.cos(a) * 1.6 + i * 3.1 + t * sp, 11 + i) + noise1(Math.sin(a) * 2.2 + i + t * sp * 1.7, 19);
        const r = base * (1 + ripple * (0.06 + energy * 0.22)) + energy * 14 * Math.sin(a * 3 + t * 6 + i) * (aSpeaking ? 1 : 0.2);
        pts.push([cx + Math.cos(a + i * 0.4) * r, cy + Math.sin(a + i * 0.4) * r * (this.portrait ? 1 : 0.96)]);
      }
      const redShare = clamp(p.red * 1.25 - (i / loops) * 0.5);
      const tone = redShare > 0.5 ? (p.red > 0.8 ? 'R' : 'r') : i % 3 === 2 ? 'g' : 'w';
      const sa = aSpeaking ? 1 : 0.45;
      crayonPolyline(g, pts, tone, 0.9 + (1 - i / loops) * 0.7, { ...b, alpha: (0.95 - i * 0.07) * sa, wobble: b.wobble + energy * 3 }, 20 + i);
    }
    // the listener (you) answers as a small trembling ring when you speak
    if (!aSpeaking && s.phase === 'call') {
      const pts = this.circle(cx, cy + R * 1.55, 26 + level * 22, 18, f);
      crayonPolyline(g, pts, s.speaker === 'W' ? 'g' : 'w', 1.2, { ...b, alpha: 0.9 }, 40);
    }
    // heavy dots at the centre like a pupil
    crayonPolyline(g, [[cx - 6, cy], [cx + 6, cy + 1]], p.red > 0.5 ? 'R' : 'w', 3, { ...b, alpha: 0.95 }, 41);
  }

  private circle(cx: number, cy: number, r: number, n: number, f: number): Pt[] {
    const pts: Pt[] = [];
    const a0 = noise1(f * 0.3 + cx * 0.01, 2) * 3;
    for (let i = 0; i <= n + 1; i++) {
      const a = a0 + (i / n) * Math.PI * 2;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    return pts;
  }

  private handset(g: Graphics, x: number, y: number, s: number, b: Brush, tone: 'w' | 'r', rot: number) {
    const pts: Pt[] = [];
    const base: Pt[] = [[-1, -0.55], [-0.75, -0.9], [-0.35, -0.8], [-0.3, -0.45], [-0.55, -0.3], [0, 0.4], [0.3, 0.2], [0.45, 0.45], [0.75, 0.55], [0.85, 0.85], [0.55, 1.0], [-0.1, 0.75], [-0.7, 0.2], [-1, -0.55]];
    for (const [px, py] of base) {
      const c = Math.cos(rot), sn = Math.sin(rot);
      pts.push([x + (px * c - py * sn) * s * 0.9, y + (px * sn + py * c) * s * 0.9]);
    }
    crayonPolyline(g, pts, tone, 1.1, b, 8);
  }

  private garble(text: string, amount: number, f: number): string {
    if (amount < 0.3) return text;
    const rnd = mulberry32(f * 31 + 5);
    const sub = '#/\\?*%';
    return [...text].map((ch) => (ch !== ' ' && rnd() < (amount - 0.25) * 0.22 ? sub[Math.floor(rnd() * sub.length)] : ch)).join('');
  }

  private garbleDigits(text: string, amount: number, f: number): string {
    if (amount < 0.45) return text;
    const rnd = mulberry32(f * 17 + 3);
    return [...text].map((ch) => (ch !== ':' && rnd() < (amount - 0.4) * 0.5 ? '?' : ch)).join('');
  }

  destroy() { this.root.destroy({ children: true }); }
}

