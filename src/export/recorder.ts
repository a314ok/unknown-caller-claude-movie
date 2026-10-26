import * as fixModule from 'webm-duration-fix';
import type { Format, Player } from '../app/player';

/** the package is CommonJS: depending on the bundler the callable is `default`, `default.default` or the namespace */
function resolveDurationFixer(): (b: Blob) => Promise<Blob> {
  const m = fixModule as unknown as Record<string, unknown>;
  const cands = [m.default, (m.default as Record<string, unknown> | undefined)?.default, m.fixWebmDuration, m];
  const fn = cands.find((c) => typeof c === 'function');
  if (!fn) throw new Error('webm-duration-fix: no callable export');
  return fn as (b: Blob) => Promise<Blob>;
}

export type ExportQuality = '1080p' | '720p';

export interface ExportOptions {
  format: Format;
  /** 1080p is the target; 720p is the escape hatch for machines that cannot render 1080p in real time */
  quality?: ExportQuality;
  /** stop after this many seconds of film (tests / quick previews); default: the whole film */
  limitSeconds?: number;
  /** start inside the call instead of at the ring (tests) */
  fromCallT?: number;
  fps?: number;
  videoBitsPerSecond?: number;
  /** force a codec, e.g. 'vp8' (cheaper to encode than the default vp9 on slow CPUs) */
  codec?: 'vp9' | 'vp8' | 'av1' | 'h264';
  onProgress?: (frac: number, message: string) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  mime: string;
  seconds: number;
  frames: number;
  width: number;
  height: number;
  videoTracks: number;
  audioTracks: number;
  durationPatched: boolean;
  /** wall-clock seconds per second of film. ~1.0 = the machine kept real time; >1.05 = it did not and A/V may be out of sync */
  realtimeRatio: number;
  captureMsAvg: number;
  warning?: string;
}

const CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=av1,opus',
  'video/webm;codecs=h264,opus',
  'video/webm',
];

export function pickMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

export class ExportUnsupportedError extends Error {}

/**
 * Pixi canvas ──drawImage──> 2D export canvas ──captureStream(0)──┐
 *                                                                 ├─> MediaStream ─> MediaRecorder ─> WebM
 * Web Audio mix ─> MediaStreamAudioDestinationNode ───────────────┘
 *
 * Frames are pushed explicitly (requestFrame) on the audio clock, 30 per second, so the picture
 * can never run ahead of the sound; the WebGL canvas is copied to a plain 2D canvas first because
 * capturing a WebGL drawing buffer directly can yield black frames.
 */
export async function exportWebM(player: Player, opts: ExportOptions): Promise<ExportResult> {
  const forced = opts.codec ? `video/webm;codecs=${opts.codec},opus` : null;
  const mime = forced && typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(forced) ? forced : pickMime();
  if (!mime) {
    throw new ExportUnsupportedError('This browser cannot record WebM (MediaRecorder with video/webm is unavailable). Use a current Chrome, Edge or Firefox.');
  }
  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    throw new ExportUnsupportedError('This browser does not support canvas.captureStream().');
  }
  const fps = opts.fps ?? 30;
  const portrait = opts.format === 'portrait';
  const hd = (opts.quality ?? '1080p') === '1080p';
  const width = portrait ? (hd ? 1080 : 720) : (hd ? 1920 : 1280);
  const height = portrait ? (hd ? 1920 : 1280) : (hd ? 1080 : 720);
  const previewSize = [player.app.renderer.width, player.app.renderer.height] as const;
  const previewFormat = player.format;

  const out = document.createElement('canvas');
  out.width = width; out.height = height;
  const ctx2 = out.getContext('2d', { alpha: false });
  if (!ctx2) throw new ExportUnsupportedError('2D canvas unavailable.');
  ctx2.fillStyle = '#000';
  ctx2.fillRect(0, 0, width, height);

  const videoStream = out.captureStream(0);
  const vTrack = videoStream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const aTracks = player.engine.recorderStream.getAudioTracks();
  if (aTracks.length === 0) throw new ExportUnsupportedError('No audio track available from the Web Audio graph.');
  const stream = new MediaStream([vTrack, ...aTracks]);

  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: opts.videoBitsPerSecond ?? (hd ? 8_000_000 : 4_000_000),
    audioBitsPerSecond: 192_000,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise<void>((res, rej) => {
    recorder.onstop = () => res();
    recorder.onerror = (e) => rej((e as ErrorEvent).error ?? new Error('MediaRecorder error'));
  });

  const ic = player.scn.intro;
  const period = ic.ringSeconds + ic.ringGapSeconds;
  const introSeconds = opts.fromCallT !== undefined ? 0 : ic.blackSeconds + ic.autoAnswerAfterRings * period - ic.ringGapSeconds * 0.4 + 0.2 + 0.55;
  const filmSeconds = opts.fromCallT !== undefined ? player.tl.duration - opts.fromCallT : introSeconds + player.tl.duration;
  const total = Math.min(opts.limitSeconds ?? Infinity, filmSeconds);

  player.exporting = true;
  player.setFormat(opts.format, width, height);

  let frames = 0;
  let startClock = 0;
  let wallStart = 0;
  let finished = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });
  const prevOnFrame = player.onFrame;
  const prevOnEnded = player.onEnded;

  let captureMs = 0;
  const capture = () => {
    const t0 = performance.now();
    ctx2.drawImage(player.app.canvas as HTMLCanvasElement, 0, 0, width, height);
    vTrack.requestFrame();
    frames++;
    captureMs += performance.now() - t0;
  };

  // Frame cadence runs on a wall-clock schedule (the picture itself is drawn from the audio clock). Gating on
  // AudioContext.currentTime instead drops to ~23 fps where it advances in coarse steps (e.g. 21 ms quanta on Linux).
  let nextDue = -Infinity;
  const due = () => {
    const now = performance.now();
    if (now < nextDue - 4) return false;
    nextDue = now - nextDue > 2000 / fps ? now + 1000 / fps : nextDue + 1000 / fps;   // resync after a stall
    return true;
  };
  // A timer also pushes frames, so a slow render loop still yields a steady cadence (repeating the last picture).
  const timer = window.setInterval(() => {
    if (!finished && due()) capture();
  }, 1000 / fps / 2);
  player.onFrame = (clock) => {
    if (finished) return;
    if (due()) capture();
    const elapsed = clock - startClock;
    opts.onProgress?.(Math.min(1, elapsed / total), `Recording ${elapsed.toFixed(0)} / ${total.toFixed(0)} s`);
    if (elapsed >= total || opts.signal?.aborted) { finished = true; resolveDone(); }
  };
  player.onEnded = () => { if (!finished) { finished = true; resolveDone(); } };

  try {
    capture();            // frame 0 (black) so the encoder starts immediately
    recorder.start(1000);
    startClock = player.engine.now;
    await player.begin({ autoAnswer: true, fromCallT: opts.fromCallT });
    startClock = player.engine.now;
    wallStart = performance.now();
    await done;
    capture();
    await new Promise((r) => setTimeout(r, 250));   // let the encoder drain the last frames
    recorder.stop();
    await stopped;
  } finally {
    window.clearInterval(timer);
    player.onFrame = prevOnFrame;
    player.onEnded = prevOnEnded;
    player.exporting = false;
    stream.getTracks().forEach((t) => { if (t.kind === 'video') t.stop(); });
    player.engine.stopAll();
    player.stopLoop();
    player.setFormat(previewFormat, previewSize[0], previewSize[1]);
  }
  if (opts.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');

  const wallSeconds = (performance.now() - wallStart) / 1000;
  const realtimeRatio = wallSeconds / Math.max(0.001, player.engine.now - startClock);
  const raw = new Blob(chunks, { type: mime.split(';')[0] });
  // MediaRecorder writes no Duration/Cues; patch them in so every player can seek.
  let blob = raw;
  let durationPatched = false;
  try { blob = await resolveDurationFixer()(raw); durationPatched = true; } catch (e) { console.warn('webm duration patch failed', e); blob = raw; }
  opts.onProgress?.(1, 'Done');
  return {
    blob, mime, seconds: total, frames, width, height,
    videoTracks: stream.getVideoTracks().length, audioTracks: aTracks.length, durationPatched, realtimeRatio, captureMsAvg: captureMs / Math.max(1, frames),
    warning: realtimeRatio > 1.05
      ? `This machine ran the export at ${realtimeRatio.toFixed(2)}x real time, so picture and sound in the file may be out of sync. Close other apps, use 720p, or export on a faster/GPU machine.`
      : undefined,
  };
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
