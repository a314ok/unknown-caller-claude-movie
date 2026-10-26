import { Application } from 'pixi.js';
import { AudioEngine } from '../audio/engine';
import { buildCues, cueAt, LANDSCAPE_CUES, PORTRAIT_CUES } from '../core/cues';
import { clamp } from '../core/rng';
import { buildTimeline, lastStartedIndex, sceneParamsAt } from '../core/timeline';
import type { Manifest, SceneParams, Scenario, SubtitleCue, Timeline } from '../core/types';
import { CallScene, type FrameState, type Phase } from '../render/scene';

export type Format = 'landscape' | 'portrait';

export interface BeginOptions {
  autoAnswer?: boolean;   // answer by itself after N rings (used for export)
  fromCallT?: number;     // jump straight into the call at this call time (tests / partial exports)
}

const IDLE_PARAMS = (): SceneParams => ({
  stress: 0.05, red: 0.02, decay: 0, clean: 0, dead: 0,
  atmos: { hum: 0, line: 0, breath: 0, bass: 0 },
  shake: 0, flash: 0, ghosts: 0, spin: 0, scratchBoost: 0,
});

/** Owns the clock (the AudioContext), the phase machine and the render loop. */
export class Player {
  readonly scn: Scenario;
  readonly manifest: Manifest;
  readonly tl: Timeline;
  readonly engine: AudioEngine;
  scene!: CallScene;
  app!: Application;
  phase: Phase = 'black';
  format: Format = 'landscape';
  paused = false;
  exporting = false;
  cues: SubtitleCue[] = [];
  onFrame?: (clock: number) => void;
  onPhase?: (p: Phase) => void;
  onEnded?: () => void;
  /** render-loop health (ms per frame, frames drawn) for diagnostics / e2e checks */
  stats = { frames: 0, renderMs: 0, maxMs: 0, startedAt: 0 };

  private phaseStart = 0;
  private callStart = 0;
  private autoAnswer = false;
  private raf = 0;
  private running = false;
  private level = 0;
  private answerAt = 0;
  private lastRenderClock = -1;

  constructor(scn: Scenario, manifest: Manifest, engine: AudioEngine) {
    this.scn = scn;
    this.manifest = manifest;
    this.engine = engine;
    this.tl = buildTimeline(scn, manifest);
  }

  async init(canvas: HTMLCanvasElement) {
    this.app = new Application();
    await this.app.init({
      canvas, width: 1280, height: 720, background: 0x000000, antialias: true, resolution: 1,
      autoDensity: false, preference: 'webgl', preserveDrawingBuffer: true, autoStart: false, sharedTicker: false,
    });
    this.app.ticker.stop();
    this.scene = new CallScene(this.app);
    this.setFormat('landscape', 1280, 720);
  }

  /** px size is the actual render size (preview is smaller than the 1080p export). */
  setFormat(format: Format, pw: number, ph: number) {
    this.format = format;
    this.scene.setFormat(format === 'portrait', pw, ph);
    this.cues = buildCues(this.tl.lines, format === 'portrait' ? PORTRAIT_CUES : LANDSCAPE_CUES);
    this.lastRenderClock = -1;
  }

  get callTime() { return this.phase === 'call' ? this.engine.now - this.callStart : this.phase === 'ended' ? this.tl.callEnd : 0; }

  // ---------------------------------------------------------------- control
  async begin(opts: BeginOptions = {}) {
    await this.engine.resume();
    this.stopLoop();
    this.engine.stopAll();
    this.engine.resetRinging();
    this.paused = false;
    this.autoAnswer = !!opts.autoAnswer;
    this.level = 0;
    if (opts.fromCallT !== undefined) {
      this.enterCall(opts.fromCallT);
    } else {
      this.setPhase('black');
    }
    this.startLoop();
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.phaseStart = this.engine.now;
    this.onPhase?.(p);
  }

  answer() {
    if (this.phase !== 'ringing') return;
    this.setPhase('answering');
    this.engine.stopRinging();
    this.engine.pickUp();
  }

  private enterCall(from = 0) {
    this.engine.stopAll();
    this.engine.stopRinging();
    this.callStart = this.engine.now - from;
    this.engine.scheduleCall(this.scn, this.tl, this.callStart, from);
    this.setPhase('call');
  }

  seek(t: number) {
    if (this.exporting) return;
    this.enterCall(clamp(t, 0, this.tl.callEnd - 0.1));
    this.lastRenderClock = -1;
  }

  async togglePause() {
    if (this.exporting) return this.paused;
    if (this.paused) { await this.engine.resume(); this.paused = false; } else { await this.engine.pause(); this.paused = true; }
    return this.paused;
  }

  async restart() {
    if (this.exporting) return;
    await this.begin({});
  }

  // ---------------------------------------------------------------- loop
  private startLoop() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      this.tick();
    };
    this.raf = requestAnimationFrame(tick);
  }

  stopLoop() { this.running = false; cancelAnimationFrame(this.raf); }

  private tick() {
    const clock = this.engine.now;
    const ic = this.scn.intro;
    const period = ic.ringSeconds + ic.ringGapSeconds;

    // phase machine
    if (this.phase === 'black' && clock - this.phaseStart >= ic.blackSeconds) {
      this.setPhase('ringing');
      this.answerAt = this.phaseStart + ic.autoAnswerAfterRings * period - ic.ringGapSeconds * 0.4 + 0.2;
    }
    if (this.phase === 'ringing') {
      this.engine.ensureRings(this.phaseStart, clock + 6, ic.ringSeconds, ic.ringGapSeconds);
      if (this.autoAnswer && clock >= this.answerAt) this.answer();
    }
    if (this.phase === 'answering' && clock - this.phaseStart >= 0.55) this.enterCall(0);
    if (this.phase === 'call' && clock - this.callStart >= this.tl.callEnd) {
      this.setPhase('ended');
    }
    if (this.phase === 'ended' && Number.isFinite(this.phaseStart) && clock - this.phaseStart >= this.scn.outro.blackSeconds) {
      this.phaseStart = Infinity;       // fire once; restart is explicit
      this.onEnded?.();
    }

    if (this.paused && this.lastRenderClock === clock && !this.exporting) return;
    this.lastRenderClock = clock;

    const callT = this.phase === 'call' ? clock - this.callStart : this.tl.callEnd;
    const inCall = this.phase === 'call';
    const p = inCall ? sceneParamsAt(this.scn, this.tl, callT) : IDLE_PARAMS();
    const idx = inCall ? lastStartedIndex(this.tl, callT) : -1;
    const line = idx >= 0 ? this.tl.lines[idx] : null;
    const speaking = line && callT >= line.start && callT < line.end;

    const raw = this.engine.voiceLevel();
    this.level = Math.max(raw, this.level * 0.82);

    const phaseT = clock - this.phaseStart;
    const ringOn = this.phase === 'ringing' && (clock - this.phaseStart) % period < ic.ringSeconds;
    const state: FrameState = {
      phase: this.phase,
      clock,
      phaseT: Number.isFinite(phaseT) ? phaseT : 0,
      callT,
      p,
      voice: this.level,
      speaker: speaking ? line!.speaker : null,
      draw: line?.fx.draw ?? 'none',
      cue: inCall ? cueAt(this.cues, callT) : null,
      ringOn,
      answerPress: this.phase === 'answering' ? clamp(phaseT / 0.35) : 0,
      label: ic.label,
      lineDropped: inCall && callT >= this.tl.lineDropAt,
    };
    const r0 = performance.now();
    this.scene.render(state);
    const dt = performance.now() - r0;
    this.stats.frames++; this.stats.renderMs += dt; this.stats.maxMs = Math.max(this.stats.maxMs, dt);
    this.onFrame?.(clock);
  }

  /** current-call progress in 0..1 over the whole film (black + rings are not counted) */
  get progress() { return clamp(this.callTime / this.tl.duration); }
}
