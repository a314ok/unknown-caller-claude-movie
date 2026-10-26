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

export interface ExportOptions {
  format: Format;
  /** stop after this many seconds of film (tests / quick previews); default: the whole film */
  limitSeconds?: number;
  /** start inside the call instead of at the ring (tests) */
  fromCallT?: number;
  fps?: number;
  videoBitsPerSecond?: number;
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
  const mime = pickMime();
  if (!mime) {
    throw new ExportUnsupportedError('This browser cannot record WebM (MediaRecorder with video/webm is unavailable). Use a current Chrome, Edge or Firefox.');
  }
  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    throw new ExportUnsupportedError('This browser does not support canvas.captureStream().');
  }
  const fps = opts.fps ?? 30;
  const portrait = opts.format === 'portrait';
  const width = portrait ? 1080 : 1920;
  const height = portrait ? 1920 : 1080;
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
    videoBitsPerSecond: opts.videoBitsPerSecond ?? 12_000_000,
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
  let lastCap = -Infinity;
  let startClock = 0;
  let finished = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });
  const prevOnFrame = player.onFrame;
  const prevOnEnded = player.onEnded;

  const capture = () => {
    ctx2.drawImage(player.app.canvas as HTMLCanvasElement, 0, 0, width, height);
    vTrack.requestFrame();
    frames++;
  };

  // A timer also pushes frames, so a slow render loop still yields a steady cadence (repeating the last picture).
  const timer = window.setInterval(() => {
    const clock = player.engine.now;
    if (!finished && clock - lastCap >= 1 / fps - 0.004) { lastCap = clock; capture(); }
  }, 1000 / fps / 2);
  player.onFrame = (clock) => {
    if (finished) return;
    if (clock - lastCap >= 1 / fps - 0.002) {
      lastCap = clock;
      capture();
    }
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

  const raw = new Blob(chunks, { type: mime.split(';')[0] });
  // MediaRecorder writes no Duration/Cues; patch them in so every player can seek.
  let blob = raw;
  let durationPatched = false;
  try { blob = await resolveDurationFixer()(raw); durationPatched = true; } catch (e) { console.warn('webm duration patch failed', e); blob = raw; }
  opts.onProgress?.(1, 'Done');
  return {
    blob, mime, seconds: total, frames, width, height,
    videoTracks: stream.getVideoTracks().length, audioTracks: aTracks.length, durationPatched,
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
