import type { FxDef, Manifest, SceneDef, SceneParams, Scenario, Timeline, TimelineLine } from './types';

/**
 * Lay the scenario out in time. Nothing here is a hard-coded timecode: every start/end comes
 * from the real audio durations in the manifest plus the authored pauses (`timing.gapBefore`).
 */
export function buildTimeline(scn: Scenario, manifest: Manifest): Timeline {
  const connect = scn.intro.connectSeconds;
  let cursor = connect;
  const lines: TimelineLine[] = [];
  scn.lines.forEach((def, index) => {
    const m = manifest.lines[def.id];
    if (!m) throw new Error(`manifest has no audio for line ${def.id} - run the voice pipeline`);
    const gap = def.timing?.gapBefore ?? 0.35;
    const overlap = def.timing?.overlap ?? 0;
    const start = Math.max(cursor + gap - overlap, connect);
    const end = start + m.duration;
    lines.push({
      id: def.id,
      index,
      speaker: def.speaker,
      mood: def.mood,
      scene: def.scene,
      start,
      end,
      duration: m.duration,
      en: def.en,
      ua: def.ua,
      file: m.file,
      layers: m.layers,
      words: m.words,
      fx: def.fx ?? {},
      kind: def.kind ?? 'speech',
      engine: m.engine ?? 'omnivoice',
    });
    cursor = end;
  });
  const speechEnd = cursor;
  const lineDropAt = speechEnd + scn.outro.holdSeconds;
  const callEnd = lineDropAt + scn.outro.lineDropSeconds;
  return {
    connectSeconds: connect,
    speechStart: lines[0]?.start ?? connect,
    speechEnd,
    callEnd,
    lineDropAt,
    duration: callEnd + scn.outro.blackSeconds,
    lines,
  };
}

export function lineAt(tl: Timeline, t: number): TimelineLine | null {
  for (const l of tl.lines) if (t >= l.start && t < l.end) return l;
  return null;
}

/** index of the last line whose start <= t (or -1) */
export function lastStartedIndex(tl: Timeline, t: number): number {
  let lo = 0, hi = tl.lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tl.lines[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const smooth = (k: number) => k * k * (3 - 2 * k);

export const NEUTRAL_SCENE: SceneDef = {
  stress: 0, red: 0.02, decay: 0, clean: 0, dead: 0,
  atmos: { hum: 0.5, line: 0.45, breath: 0.2, bass: 0.1 },
};

export function mixScene(a: SceneDef, b: SceneDef, k: number): SceneDef {
  return {
    stress: lerp(a.stress, b.stress, k), red: lerp(a.red, b.red, k), decay: lerp(a.decay, b.decay, k),
    clean: lerp(a.clean, b.clean, k), dead: lerp(a.dead, b.dead, k),
    atmos: {
      hum: lerp(a.atmos.hum, b.atmos.hum, k), line: lerp(a.atmos.line, b.atmos.line, k),
      breath: lerp(a.atmos.breath, b.atmos.breath, k), bass: lerp(a.atmos.bass, b.atmos.bass, k),
    },
  };
}

/**
 * Scene parameters at call time t: eased blend from the previous line's scene to the current
 * one, plus decaying per-line impulses (shake, flash, ...) authored in `fx`.
 */
export function sceneParamsAt(scn: Scenario, tl: Timeline, t: number): SceneParams {
  const i = lastStartedIndex(tl, t);
  let base: SceneDef;
  let fx: FxDef = {};
  let sinceStart = Infinity;
  if (i < 0) {
    base = scn.scenes[tl.lines[0].scene] ?? NEUTRAL_SCENE;
    base = mixScene(NEUTRAL_SCENE, base, 0);
  } else {
    const cur = tl.lines[i];
    const target = scn.scenes[cur.scene] ?? NEUTRAL_SCENE;
    const prev = i > 0 ? scn.scenes[tl.lines[i - 1].scene] ?? NEUTRAL_SCENE : NEUTRAL_SCENE;
    sinceStart = t - cur.start;
    const k = smooth(Math.min(1, Math.max(0, sinceStart / 2.2)));
    base = mixScene(prev, target, k);
    fx = cur.fx;
  }
  // impulses relax over ~1.3s after the line starts but follow the line while it plays
  const hold = i >= 0 ? Math.max(0, 1 - Math.max(0, sinceStart - tl.lines[i].duration) / 1.3) : 0;
  const impulse = (v: number | undefined) => (v ?? 0) * hold;
  const sceneEnd = t > tl.lineDropAt ? Math.max(0, 1 - (t - tl.lineDropAt) / Math.max(0.001, tl.callEnd - tl.lineDropAt)) : 1;
  return {
    ...base,
    stress: Math.min(1, base.stress + impulse(fx.shake) * 0.3),
    red: Math.min(1, Math.max(base.red, impulse(fx.red))),
    dead: t > tl.lineDropAt ? 1 : base.dead,
    shake: impulse(fx.shake) * sceneEnd,
    flash: impulse(fx.flash) * Math.max(0, 1 - sinceStart / 0.9),
    ghosts: fx.ghosts ?? 0,
    spin: fx.spin ?? 0,
    scratchBoost: impulse(fx.scratch),
  };
}

export function exportRows(tl: Timeline) {
  return tl.lines.map((l) => ({
    id: l.id,
    start: +l.start.toFixed(3),
    end: +l.end.toFixed(3),
    speaker: l.speaker,
    mood: l.mood,
    scene: l.scene,
    en: l.en,
    ua: l.ua,
    audio: l.file,
    engine: l.engine,
    layers: l.layers.map((x) => x.file),
    effects: l.fx,
  }));
}
