import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import scenarioJson from '../scenario/scenario.json';
import { buildCues, chunkSubtitle, cueAt, cuesForLine, LANDSCAPE_CUES, PORTRAIT_CUES, wrapRows } from '../src/core/cues';
import { buildTimeline, lastStartedIndex, sceneParamsAt } from '../src/core/timeline';
import type { Manifest, Scenario } from '../src/core/types';
import { DRAWINGS, drawingStrokes, revealStrokes } from '../src/render/drawings';

const scn = scenarioJson as unknown as Scenario;

/** deterministic fake durations: ~0.34 s per English word, so the layout logic can be tested without audio */
function fakeManifest(): Manifest {
  const lines: Manifest['lines'] = {};
  for (const l of scn.lines) {
    const words = l.en.split(/\s+/).filter(Boolean);
    const dur = Math.max(0.8, words.length * 0.34);
    lines[l.id] = {
      file: `audio/lines/${l.id}.wav`, duration: dur, layers: [], alignment: 'test',
      words: words.map((w, i) => ({ w, t0: 0.07 + (i * (dur - 0.2)) / words.length, t1: 0.07 + ((i + 0.85) * (dur - 0.2)) / words.length })),
    };
  }
  return { sampleRate: 24000, lines };
}

describe('scenario data', () => {
  test('every line has English text, a Ukrainian subtitle, a known scene and mood', () => {
    const ids = new Set<string>();
    for (const l of scn.lines) {
      expect(ids.has(l.id)).toBe(false);
      ids.add(l.id);
      expect(l.en.length).toBeGreaterThan(0);
      expect(l.ua.length).toBeGreaterThan(0);
      expect(scn.scenes[l.scene]).toBeDefined();
      expect(scn.moods[l.mood]).toBeDefined();
      expect(scn.dspPresets[scn.moods[l.mood].dsp]).toBeDefined();
    }
    expect(scn.lines.length).toBeGreaterThanOrEqual(55);
  });

  test('every referenced drawing exists', () => {
    for (const l of scn.lines) if (l.fx?.draw) expect(Object.keys(DRAWINGS)).toContain(l.fx.draw);
  });

  test('all scripted beats are present (source script coverage)', () => {
    const ua = scn.lines.map((l) => l.ua).join(' ');
    for (const needle of ['Давно не чулись', 'Це хто?', 'ва-банк', 'білка', 'диктатори', 'А+', 'етилу', 'будиночка', 'ліки', 'Всім похуй', 'НІІІІ', 'Андрійку', 'вінцем', 'крик', 'клоуном', 'коту під хвіст', 'фінальне рішення', 'твоє минуле']) {
      expect(ua).toContain(needle);
    }
    expect(scn.lines.some((l) => l.sfx === 'scream')).toBe(true);
    expect(scn.lines.find((l) => l.id === 'l026')?.layers?.length).toBeGreaterThanOrEqual(3);   // multi-voice
  });

  test('the speech accelerates through the hamster-wheel passage and then calms', () => {
    const sp = ['l007', 'l008', 'l009', 'l010', 'l011'].map((id) => {
      const l = scn.lines.find((x) => x.id === id)!;
      return (l.tts?.speed as number | undefined) ?? scn.moods[l.mood].speed;
    });
    expect(sp[1]).toBeGreaterThan(sp[0]);
    expect(sp[2]).toBeGreaterThan(sp[1]);
    expect(sp[3]).toBeGreaterThan(sp[2]);
    expect(sp[4]).toBeLessThan(sp[0]);
  });
});

describe('timeline', () => {
  const tl = buildTimeline(scn, fakeManifest());

  test('is derived from durations: lines are ordered, non-overlapping and respect authored pauses', () => {
    for (let i = 0; i < tl.lines.length; i++) {
      const l = tl.lines[i];
      expect(l.end).toBeCloseTo(l.start + l.duration, 6);
      if (i > 0) expect(l.start - tl.lines[i - 1].end).toBeCloseTo(scn.lines[i].timing?.gapBefore ?? 0.35, 6);
    }
    expect(tl.lines[0].start).toBeGreaterThanOrEqual(scn.intro.connectSeconds);
    expect(tl.duration).toBeGreaterThan(tl.speechEnd + scn.outro.holdSeconds);
  });

  test('changing a pause moves everything after it (no hard-coded timecodes)', () => {
    const edited: Scenario = JSON.parse(JSON.stringify(scn));
    edited.lines[10].timing = { gapBefore: (edited.lines[10].timing?.gapBefore ?? 0.35) + 2 };
    const tl2 = buildTimeline(edited, fakeManifest());
    expect(tl2.lines[9].start).toBeCloseTo(tl.lines[9].start, 6);
    expect(tl2.lines[10].start).toBeCloseTo(tl.lines[10].start + 2, 6);
    expect(tl2.duration).toBeCloseTo(tl.duration + 2, 6);
  });

  test('missing audio is a hard error', () => {
    const m = fakeManifest();
    delete m.lines.l020;
    expect(() => buildTimeline(scn, m)).toThrow(/l020/);
  });

  test('scene parameters: decay grows, the finale is clean and dead, atmosphere is removed', () => {
    const early = sceneParamsAt(scn, tl, tl.lines[3].start + 3);
    const mid = sceneParamsAt(scn, tl, tl.lines.find((l) => l.id === 'l036')!.start + 3);
    const last = tl.lines[tl.lines.length - 1];
    const fin = sceneParamsAt(scn, tl, last.start + 3);
    expect(mid.decay).toBeGreaterThan(early.decay);
    expect(fin.clean).toBeGreaterThan(0.9);
    expect(fin.dead).toBeGreaterThan(0.9);
    expect(fin.atmos.hum + fin.atmos.bass + fin.atmos.breath).toBeLessThan(0.05);
    expect(sceneParamsAt(scn, tl, tl.lineDropAt + 0.1).dead).toBe(1);
  });

  test('climax impulses: the multi-voice line spikes shake/red/ghosts', () => {
    const l = tl.lines.find((x) => x.id === 'l026')!;
    const p = sceneParamsAt(scn, tl, l.start + 0.5);
    expect(p.ghosts).toBe(5);
    expect(p.shake).toBeGreaterThan(0.5);
    expect(p.red).toBeGreaterThan(0.8);
  });

  test('lastStartedIndex is a correct binary search', () => {
    expect(lastStartedIndex(tl, 0)).toBe(-1);
    for (let i = 0; i < tl.lines.length; i++) expect(lastStartedIndex(tl, tl.lines[i].start + 0.001)).toBe(i);
  });
});

describe('subtitles', () => {
  test('rows never exceed the limit and never split words', () => {
    for (const l of scn.lines) {
      for (const opts of [LANDSCAPE_CUES, PORTRAIT_CUES]) {
        for (const chunk of chunkSubtitle(l.ua, opts)) {
          const rows = chunk.split('\n');
          expect(rows.length).toBeLessThanOrEqual(2);
          for (const r of rows) expect(r.length).toBeLessThanOrEqual(opts.maxChars + 0);
          expect(chunk.replace(/\n/g, ' ').split(' ').every((w) => l.ua.includes(w))).toBe(true);
        }
      }
    }
  });

  test('wrapRows balances two rows', () => {
    const rows = wrapRows('Ти досі та сама наївна сучка, що вірить у безкорисливу доброту в людях?', 46);
    expect(rows.length).toBe(2);
    expect(Math.abs(rows[0].length - rows[1].length)).toBeLessThan(20);
  });

  test('cues follow the word timings, not text length, and vanish in long silences', () => {
    const tl = buildTimeline(scn, fakeManifest());
    const cues = buildCues(tl.lines, LANDSCAPE_CUES);
    for (let i = 0; i < cues.length; i++) {
      expect(cues[i].end).toBeGreaterThan(cues[i].start);
      expect(cues[i].hide).toBeGreaterThanOrEqual(cues[i].end);
      if (i > 0) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].start);
      if (i < cues.length - 1) expect(cues[i].hide).toBeLessThanOrEqual(cues[i + 1].start + 1e-9);
    }
    // a long gap (> linger) between l055 and l056 leaves no subtitle on screen
    const a = tl.lines.find((l) => l.id === 'l055')!, b = tl.lines.find((l) => l.id === 'l056')!;
    const mid = (a.end + 0.9 + b.start) / 2;
    expect(b.start - a.end).toBeGreaterThan(1.2);
    expect(cueAt(cues, mid)).toBeNull();
    expect(cueAt(cues, a.start + 0.5)?.text).toContain('фінальне');
  });

  test('a long line is split into several cues in order, timed by aligned words', () => {
    const tl = buildTimeline(scn, fakeManifest());
    const long = tl.lines.find((l) => l.id === 'l023')!;
    const cues = cuesForLine(long, PORTRAIT_CUES);
    expect(cues.length).toBeGreaterThan(1);
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeGreaterThan(cues[i - 1].start);
    expect(cues[0].start).toBeGreaterThanOrEqual(long.start);
    expect(cues[cues.length - 1].end).toBeLessThanOrEqual(long.end);
  });
});

describe('drawings', () => {
  test('every drawing produces strokes, and reveal grows monotonically', () => {
    for (const id of Object.keys(DRAWINGS)) {
      const s = drawingStrokes(id, { t: 1.3, spin: 0.5, stress: 0.5, level: 0.4 });
      if (id === 'none') { expect(s.length).toBe(0); continue; }
      expect(s.length).toBeGreaterThan(2);
      for (const st of s) for (const [x, y] of st.pts) { expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true); }
      let prev = 0;
      for (const f of [0.1, 0.4, 0.8, 1]) {
        const n = revealStrokes(s, f).reduce((a, st) => a + st.pts.length, 0);
        expect(n).toBeGreaterThanOrEqual(prev);
        prev = n;
      }
    }
  });

  test('only the allowed palette tones exist', () => {
    for (const id of Object.keys(DRAWINGS)) for (const st of drawingStrokes(id, { t: 0.5, spin: 0, stress: 0, level: 0 })) expect(['w', 'r', 'R', 'g', 'd']).toContain(st.tone);
  });
});

describe('generated audio', () => {
  const manifestPath = new URL('../public/audio/manifest.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const have = existsSync(manifestPath);
  const manifest = have ? (JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest) : null;

  test.skipIf(!have)('every generated entry has a real duration, an existing file and (for speech) word timings', () => {
    for (const l of scn.lines) {
      const e = manifest!.lines[l.id];
      if (!e) continue;                       // not generated yet: covered by the strict test below
      expect(e.duration).toBeGreaterThan(0.2);
      expect(existsSync(new URL(`../public/${e.file}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))).toBe(true);
      if (l.kind !== 'sfx') expect(e.words.length).toBeGreaterThan(0);
    }
  });

  // Run with REQUIRE_FULL_AUDIO=1 to gate "the film is complete" (all 58 lines synthesised).
  test.skipIf(!process.env.REQUIRE_FULL_AUDIO)('ALL lines have generated audio', () => {
    const missing = scn.lines.filter((l) => !manifest?.lines[l.id]).map((l) => l.id);
    expect(missing).toEqual([]);
  });
});
