import { mulberry32, dbToGain, clamp } from '../core/rng';
import { sceneParamsAt } from '../core/timeline';
import type { Scenario, Timeline } from '../core/types';

/**
 * Web Audio mix for the whole call.
 *
 *   line sources ─┬─> phone band-limit ─┐
 *                 └─> dry (close) ──────┴─> voice bus ─> compressor ─┐
 *   atmosphere (hum, line noise, rumble, breath, thumps, clicks) ────┴─> mix ─┬─> MediaStreamDestination (recorder)
 *                                                                              └─> volume ─> speakers
 *
 * The recorder taps `mix` before the UI volume knob, so the exported WebM never depends on it.
 */
export class AudioEngine {
  readonly ctx: AudioContext;
  readonly mix: GainNode;
  readonly volume: GainNode;
  readonly recorderStream: MediaStream;
  private readonly recDest: MediaStreamAudioDestinationNode;
  private readonly voiceBus: GainNode;
  private readonly phoneGain: GainNode;
  private readonly dryGain: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly analyserBuf: Float32Array<ArrayBuffer>;
  private readonly hum: GainNode;
  private readonly hiss: GainNode;
  private readonly rumble: GainNode;
  private readonly ringBus: GainNode;
  private readonly fxBus: GainNode;
  private readonly room: ConvolverNode;
  private readonly roomSend: GainNode;
  private noiseBuf: AudioBuffer;
  readonly buffers = new Map<string, AudioBuffer>();
  private active = new Set<AudioScheduledSourceNode>();
  private queue: { t: number; run: () => void }[] = [];
  private qi = 0;
  private callStart = 0;
  private pumpTimer = 0;
  private ringScheduledUntil = 0;
  private ringStopped = false;

  constructor() {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.mix = ctx.createGain();
    this.volume = ctx.createGain();
    this.recDest = ctx.createMediaStreamDestination();
    this.recorderStream = this.recDest.stream;
    // safety limiter on the master so peaks (scream, multi-voice) never clip the recording
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -5; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.14;
    this.mix.connect(limiter);
    limiter.connect(this.recDest);
    limiter.connect(this.volume);
    this.volume.connect(ctx.destination);

    // --- voice chain
    this.voiceBus = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20; comp.ratio.value = 3; comp.attack.value = 0.004; comp.release.value = 0.2; comp.knee.value = 12;
    this.phoneGain = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.phoneGain.gain.value = 1;
    this.dryGain.gain.value = 0.35;
    this.voiceBus.connect(comp).connect(this.mix);
    this.phoneGain.connect(this.voiceBus);
    this.dryGain.connect(this.voiceBus);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyserBuf = new Float32Array(this.analyser.fftSize) as Float32Array<ArrayBuffer>;
    this.voiceBus.connect(this.analyser);

    // small dark room used by the ghost layers
    this.room = ctx.createConvolver();
    this.room.buffer = this.makeImpulse(1.6, 2.6);
    this.roomSend = ctx.createGain();
    this.roomSend.gain.value = 0.0;
    this.roomSend.connect(this.room);
    this.room.connect(this.voiceBus);

    // --- atmosphere
    this.noiseBuf = this.makeNoise(4);
    this.hum = this.makeHum();
    this.hiss = this.makeHiss();
    this.rumble = this.makeRumble();
    this.fxBus = ctx.createGain();
    this.fxBus.connect(this.mix);
    this.ringBus = ctx.createGain();
    this.ringBus.connect(this.mix);
    this.setVolume(0.9);
  }

  setVolume(v: number) { this.volume.gain.setTargetAtTime(clamp(v) ** 1.6, this.ctx.currentTime, 0.02); }
  async resume() { if (this.ctx.state !== 'running') await this.ctx.resume(); }
  async pause() { if (this.ctx.state === 'running') await this.ctx.suspend(); }
  get now() { return this.ctx.currentTime; }

  /** Instant voice loudness 0..1 for the visuals. */
  voiceLevel(): number {
    this.analyser.getFloatTimeDomainData(this.analyserBuf);
    let s = 0;
    for (let i = 0; i < this.analyserBuf.length; i++) s += this.analyserBuf[i] * this.analyserBuf[i];
    return clamp(Math.sqrt(s / this.analyserBuf.length) * 5.5);
  }

  // ---------------------------------------------------------------- loading
  async load(urls: string[], onProgress?: (done: number, total: number) => void) {
    let done = 0;
    await Promise.all(urls.filter((u) => !this.buffers.has(u)).map(async (u) => {
      const res = await fetch(u);
      if (!res.ok) throw new Error(`audio ${u}: HTTP ${res.status}`);
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      this.buffers.set(u, buf);
      onProgress?.(++done, urls.length);
    }));
  }

  // ---------------------------------------------------------------- generators
  private makeNoise(seconds: number): AudioBuffer {
    const b = this.ctx.createBuffer(2, this.ctx.sampleRate * seconds, this.ctx.sampleRate);
    const rnd = mulberry32(99);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1;
    }
    return b;
  }

  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const b = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    const rnd = mulberry32(5);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (rnd() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return b;
  }

  private loopNoise(): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.start(0, Math.random() * 3);
    return s;
  }

  private makeHum(): GainNode {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = 0;
    [[50, 0.55], [100.2, 0.28], [150.1, 0.16], [250.4, 0.06]].forEach(([f, a]) => {
      const o = ctx.createOscillator();
      o.type = f < 120 ? 'sine' : 'triangle';
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = a;
      o.connect(og).connect(g);
      o.start();
    });
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.21;
    const lg = ctx.createGain();
    lg.gain.value = 0.12;
    lfo.connect(lg).connect(g.gain);
    lfo.start();
    g.connect(this.mix);
    return g;
  }

  private makeHiss(): GainNode {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = 0;
    const n = this.loopNoise();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2100; bp.Q.value = 0.45;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 400;
    n.connect(bp).connect(hp).connect(g).connect(this.mix);
    return g;
  }

  private makeRumble(): GainNode {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = 0;
    const n = this.loopNoise();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 95; lp.Q.value = 0.7;
    n.connect(lp).connect(g).connect(this.mix);
    return g;
  }

  // ---------------------------------------------------------------- one-shots
  private track<T extends AudioScheduledSourceNode>(n: T): T {
    this.active.add(n);
    n.addEventListener('ended', () => { this.active.delete(n); try { n.disconnect(); } catch { /* */ } }, { once: true });
    return n;
  }

  private click(when: number, level = 0.3, tone = 1800) {
    const ctx = this.ctx;
    const s = this.track(ctx.createBufferSource());
    s.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = tone; bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(level, when + 0.0015);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.02);
    s.connect(bp).connect(g).connect(this.fxBus);
    s.start(when, Math.random() * 3, 0.03);
  }

  private crackle(when: number, level: number) {
    const n = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) this.click(when + i * (0.003 + Math.random() * 0.012), level * (0.4 + Math.random() * 0.6), 900 + Math.random() * 4500);
  }

  private breath(when: number, level: number, pan: number) {
    const ctx = this.ctx;
    const s = this.track(ctx.createBufferSource());
    s.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(420, when);
    bp.frequency.linearRampToValueAtTime(950, when + 1.0);
    bp.frequency.linearRampToValueAtTime(380, when + 2.6);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(level, when + 1.0);   // inhale
    g.gain.linearRampToValueAtTime(level * 0.2, when + 1.25);
    g.gain.linearRampToValueAtTime(level * 0.8, when + 1.6);   // exhale
    g.gain.exponentialRampToValueAtTime(0.0001, when + 2.8);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    s.connect(bp).connect(g).connect(p).connect(this.fxBus);
    s.start(when, Math.random() * 3, 3);
  }

  private thump(when: number, level: number) {
    const ctx = this.ctx;
    const o = this.track(ctx.createOscillator());
    o.type = 'sine';
    o.frequency.setValueAtTime(70, when);
    o.frequency.exponentialRampToValueAtTime(34, when + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(level, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.34);
    o.connect(g).connect(this.fxBus);
    o.start(when);
    o.stop(when + 0.4);
  }

  private tone(when: number, freq: number, dur: number, level: number, dest: AudioNode = this.fxBus) {
    const o = this.track(this.ctx.createOscillator());
    o.type = 'sine';
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(level, when + 0.01);
    g.gain.setValueAtTime(level, when + dur - 0.02);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    o.connect(g).connect(dest);
    o.start(when);
    o.stop(when + dur + 0.02);
  }

  // ---------------------------------------------------------------- ringing
  /** Classic two-tone ring with 20 Hz bell flutter. Called repeatedly while ringing. */
  ensureRings(startAt: number, untilAbs: number, onSeconds: number, gapSeconds: number) {
    if (this.ringStopped) return;
    let t = Math.max(this.ringScheduledUntil, startAt);
    while (t < untilAbs) {
      this.ring(t, onSeconds);
      t += onSeconds + gapSeconds;
    }
    this.ringScheduledUntil = t;
  }

  private ring(when: number, dur: number) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.16, when + 0.03);
    g.gain.setValueAtTime(0.16, when + dur - 0.05);
    g.gain.linearRampToValueAtTime(0.0001, when + dur);
    const am = ctx.createGain();
    am.gain.value = 0.55;
    const lfo = this.track(ctx.createOscillator());
    lfo.frequency.value = 20;
    const lg = ctx.createGain();
    lg.gain.value = 0.45;
    lfo.connect(lg).connect(am.gain);
    [440, 480, 880].forEach((f, i) => {
      const o = this.track(ctx.createOscillator());
      o.type = i === 2 ? 'triangle' : 'sine';
      o.frequency.value = f;
      const og = ctx.createGain();
      og.gain.value = i === 2 ? 0.08 : 0.5;
      o.connect(og).connect(am);
      o.start(when); o.stop(when + dur + 0.05);
    });
    lfo.start(when); lfo.stop(when + dur + 0.05);
    am.connect(g).connect(this.ringBus);
  }

  stopRinging() {
    this.ringStopped = true;
    const t = this.ctx.currentTime;
    this.ringBus.gain.cancelScheduledValues(t);
    this.ringBus.gain.setTargetAtTime(0, t, 0.02);
  }

  resetRinging() {
    this.ringStopped = false;
    this.ringScheduledUntil = 0;
    this.ringBus.gain.cancelScheduledValues(this.ctx.currentTime);
    this.ringBus.gain.value = 1;
  }

  /** pick-up thud shortly before the line opens */
  pickUp() {
    const t = this.ctx.currentTime;
    this.click(t, 0.5, 700);
    this.thump(t + 0.01, 0.18);
  }

  // ---------------------------------------------------------------- the call
  stopAll() {
    window.clearInterval(this.pumpTimer);
    this.queue = []; this.qi = 0;
    for (const n of this.active) { try { n.stop(); } catch { /* already stopped */ } try { n.disconnect(); } catch { /* */ } }
    this.active.clear();
    const t = this.ctx.currentTime;
    for (const p of [this.hum.gain, this.hiss.gain, this.rumble.gain, this.phoneGain.gain, this.dryGain.gain, this.roomSend.gain]) p.cancelScheduledValues(t);
  }

  /**
   * Plan the entire call, but only *instantiate* audio nodes a few seconds before they sound
   * (`pump`). Creating thousands of nodes up front makes the audio thread miss real time on slow
   * machines, which slows the clock and wrecks recordings. `callStart` is the ctx time that call
   * time 0 maps to; `from` allows starting mid-call (seek). Re-callable after stopAll().
   */
  scheduleCall(scn: Scenario, tl: Timeline, callStart: number, from = 0) {
    const ctx = this.ctx;
    this.callStart = callStart;
    this.queue = [];
    this.qi = 0;
    const abs = (t: number) => callStart + t;
    const nowT = () => ctx.currentTime;
    const at = (t: number, run: () => void) => this.queue.push({ t, run });

    // ---- voice lines (+ ghost layers)
    for (const line of tl.lines) {
      if (line.end <= from) continue;
      at(Math.max(line.start, from), () => {
        const buf = this.buffers.get(line.file);
        if (!buf) return;
        const startAt = Math.max(abs(line.start), nowT());
        const offset = Math.max(0, from - line.start, nowT() - abs(line.start));
        const src = this.track(ctx.createBufferSource());
        src.buffer = buf;
        const g = ctx.createGain();
        const mood = scn.moods[line.mood] as { dyn?: [number, number] } | undefined;
        const [d0, d1] = mood?.dyn ?? [0, 0];
        g.gain.setValueAtTime(dbToGain(d0 + (d1 - d0) * (offset / line.duration)), startAt);
        g.gain.linearRampToValueAtTime(dbToGain(d1), abs(line.end));
        src.connect(g);
        g.connect(this.phoneGain);
        g.connect(this.dryGain);
        src.start(startAt, offset);
        for (const lay of line.layers) {
          const lb = this.buffers.get(lay.file);
          if (!lb) continue;
          const ls = this.track(ctx.createBufferSource());
          ls.buffer = lb;
          const pan = ctx.createStereoPanner();
          pan.pan.value = lay.pan;
          const lg = ctx.createGain();
          lg.gain.value = dbToGain(lay.gainDb);
          ls.connect(pan).connect(lg);
          lg.connect(this.phoneGain);
          lg.connect(this.roomSend);
          const when = abs(line.start + lay.delay);
          const off = Math.max(0, nowT() - when, from - (line.start + lay.delay));
          if (when + lb.duration - off > nowT()) ls.start(Math.max(when, nowT()), off);
        }
        // ghosts get a touch of room; ordinary lines none
        this.roomSend.gain.setValueAtTime(line.layers.length ? 0.6 : 0.0, startAt);
      });
    }

    // ---- phone vs. close-mic balance + atmosphere automation (sampled from the scene curve)
    const step = 0.5;
    this.hum.gain.setValueAtTime(0, nowT());
    for (let t = Math.floor(from / step) * step; t <= tl.callEnd + 0.5; t += step) {
      const when = Math.max(abs(t), nowT());
      const p = sceneParamsAt(scn, tl, t);
      const post = t >= tl.lineDropAt ? 0 : 1;
      const connectFade = clamp((t - 0.4) / Math.max(0.5, tl.connectSeconds - 0.4));
      this.hum.gain.linearRampToValueAtTime(0.045 * p.atmos.hum * post * connectFade, when);
      this.hiss.gain.linearRampToValueAtTime(0.020 * p.atmos.line * post * (0.25 + 0.75 * connectFade) * (1 + p.stress * 0.5), when);
      this.rumble.gain.linearRampToValueAtTime(0.16 * (0.25 * p.atmos.hum + 0.75 * p.atmos.bass) * post * connectFade, when);
      this.phoneGain.gain.linearRampToValueAtTime(1 - 0.88 * p.clean, when);
      this.dryGain.gain.linearRampToValueAtTime(0.3 + 0.7 * p.clean, when);
    }

    // ---- discrete atmosphere events (seeded -> every run/export is identical)
    const rnd = mulberry32(2024);
    if (from <= 0.01) {
      // pickup + connection: the first thing heard after ANSWER
      at(0, () => {
        const c0 = abs(0);
        this.click(c0 + 0.05, 0.55, 1400);
        this.click(c0 + 0.17, 0.3, 2600);
        this.noiseSweep(c0 + 0.35, tl.connectSeconds - 0.55);
        this.tone(c0 + 0.62, 1209, 0.07, 0.012);
        this.tone(c0 + 0.72, 1477, 0.06, 0.012);
        this.crackle(c0 + 1.15, 0.07);
        this.crackle(c0 + 1.9, 0.09);
        this.click(c0 + tl.connectSeconds - 0.25, 0.28, 900);
      });
    }
    let nextBreath = 2.2 + rnd() * 2;
    for (let t = 0.8; t < tl.lineDropAt; t += 0.05) {
      if (t < tl.connectSeconds) continue;
      if (t >= nextBreath) {
        const p = sceneParamsAt(scn, tl, t);
        const lvl = 0.055 * p.atmos.breath * (0.7 + rnd() * 0.5), pan = (rnd() - 0.5) * 0.6;
        if (t >= from && p.atmos.breath > 0.06) at(t, () => this.breath(Math.max(abs(t), nowT()), lvl, pan));
        nextBreath = t + 5.5 + rnd() * 3.5 - p.atmos.breath * 1.5;
      }
    }
    let beat = tl.connectSeconds + 1;
    while (beat < tl.lineDropAt) {
      const p = sceneParamsAt(scn, tl, beat);
      const period = 1.9 - 0.9 * p.atmos.bass;
      if (beat >= from && p.atmos.bass > 0.05) {
        const b0 = beat, lvl = p.atmos.bass;
        at(b0, () => {
          this.thump(Math.max(abs(b0), nowT()), 0.28 * lvl);
          this.thump(Math.max(abs(b0 + 0.23), nowT()), 0.17 * lvl);
        });
      }
      beat += period;
    }
    for (let t = tl.connectSeconds; t < tl.lineDropAt; t += 0.1) {
      const p = sceneParamsAt(scn, tl, t);
      const rate = 0.1 + p.atmos.line * 0.22 + p.stress * 0.7;     // events per second
      if (t >= from && rnd() < rate * 0.1) {
        const lvl = 0.05 + 0.1 * p.stress, tt = t;
        at(tt, () => this.crackle(Math.max(abs(tt), nowT()), lvl));
      }
    }

    // ---- the line goes dead
    if (tl.lineDropAt >= from) {
      at(tl.lineDropAt, () => {
        const d = abs(tl.lineDropAt);
        this.click(Math.max(d, nowT()), 0.4, 800);
        for (let i = 0; i < 3; i++) this.tone(Math.max(d + 0.35 + i * 0.4, nowT()), 425, 0.22, 0.055);
      });
    }

    this.queue.sort((a, b) => a.t - b.t);
    this.pump();
    window.clearInterval(this.pumpTimer);
    this.pumpTimer = window.setInterval(() => this.pump(), 250);
  }

  /** instantiate everything that sounds within the next LOOKAHEAD seconds (idempotent, cheap) */
  pump() {
    const callT = this.ctx.currentTime - this.callStart;
    while (this.qi < this.queue.length && this.queue[this.qi].t <= callT + AudioEngine.LOOKAHEAD) {
      this.queue[this.qi++].run();
    }
  }
  private static readonly LOOKAHEAD = 5;

  private noiseSweep(when: number, dur: number) {
    const ctx = this.ctx;
    const s = this.track(ctx.createBufferSource());
    s.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 2.4;
    bp.frequency.setValueAtTime(500, when);
    bp.frequency.exponentialRampToValueAtTime(3200, when + dur * 0.5);
    bp.frequency.exponentialRampToValueAtTime(1500, when + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.05, when + dur * 0.35);
    g.gain.linearRampToValueAtTime(0.012, when + dur);
    s.connect(bp).connect(g).connect(this.fxBus);
    s.start(when, Math.random() * 3, dur + 0.1);
  }

  dispose() { this.stopAll(); void this.ctx.close(); }
}
