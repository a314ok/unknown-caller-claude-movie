// Structured timeline export: time, speaker, EN text, UA subtitle(s), audio files, effects.
//   bun run timeline            -> build/timeline.json + build/timeline.csv
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import scenarioJson from '../scenario/scenario.json';
import { buildCues, LANDSCAPE_CUES } from '../src/core/cues';
import { buildTimeline, exportRows } from '../src/core/timeline';
import type { Manifest, Scenario } from '../src/core/types';

const scn = scenarioJson as unknown as Scenario;
const manifest = JSON.parse(readFileSync('public/audio/manifest.json', 'utf-8')) as Manifest;
const tl = buildTimeline(scn, manifest);
const cues = buildCues(tl.lines, LANDSCAPE_CUES);
const rows = exportRows(tl).map((r) => ({
  ...r,
  alignment: manifest.lines[r.id].alignment,
  subtitleCues: cues.filter((c) => c.start >= r.start - 0.2 && c.start < r.end).map((c) => ({ from: +c.start.toFixed(3), to: +c.end.toFixed(3), text: c.text })),
}));
mkdirSync('build', { recursive: true });
writeFileSync('build/timeline.json', JSON.stringify({ title: scn.meta.title, callSeconds: +tl.duration.toFixed(2), speechStart: +tl.speechStart.toFixed(2), speechEnd: +tl.speechEnd.toFixed(2), rows }, null, 1));
const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
writeFileSync('build/timeline.csv', ['id,start,end,speaker,mood,scene,en,ua,audio,effects', ...rows.map((r) => [r.id, r.start, r.end, r.speaker, r.mood, r.scene, esc(r.en), esc(r.ua), r.audio, esc(JSON.stringify(r.effects))].join(','))].join('\n'));
console.log(`timeline: ${rows.length} rows, ${tl.duration.toFixed(1)} s of call -> build/timeline.json, build/timeline.csv`);
