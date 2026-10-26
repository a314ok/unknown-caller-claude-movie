import type { SubtitleCue, TimelineLine } from './types';

export interface CueOptions {
  maxChars: number;      // characters per subtitle row
  maxRows: number;       // rows per cue (2)
  lingerSeconds: number; // how long a cue stays after its last word
  leadSeconds: number;   // appear this much before the first word
}

export const LANDSCAPE_CUES: CueOptions = { maxChars: 46, maxRows: 2, lingerSeconds: 0.42, leadSeconds: 0.06 };
export const PORTRAIT_CUES: CueOptions = { maxChars: 27, maxRows: 2, lingerSeconds: 0.42, leadSeconds: 0.06 };

function greedyRows(words: string[], width: number): string[] {
  const rows: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= width || !cur) cur = next;
    else { rows.push(cur); cur = w; }
  }
  if (cur) rows.push(cur);
  return rows;
}

/** Break text into rows of at most maxChars, as even as possible. Never splits a word. */
export function wrapRows(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const n = greedyRows(words, maxChars).length;
  if (n === 1) return [words.join(' ')];
  // narrowest width that still needs only n rows -> balanced rows
  for (let width = Math.ceil(text.length / n); width < maxChars; width++) {
    const rows = greedyRows(words, width);
    if (rows.length === n) return rows;
  }
  return greedyRows(words, maxChars);
}

/** Split a subtitle into chunks of at most maxRows rows (sentence/clause boundaries preferred). */
export function chunkSubtitle(text: string, opts: CueOptions): string[] {
  const rows = wrapRows(text, opts.maxChars);
  if (rows.length <= opts.maxRows) return [rows.join('\n')];
  // Re-split on punctuation first so cues break at natural pauses.
  const pieces = text.match(/[^.!?…—–]+[.!?…—–]*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const chunks: string[] = [];
  let cur = '';
  const fits = (s: string) => wrapRows(s, opts.maxChars).length <= opts.maxRows;
  for (const p of pieces) {
    const cand = cur ? `${cur} ${p}` : p;
    if (fits(cand)) { cur = cand; continue; }
    if (cur) chunks.push(cur);
    if (fits(p)) { cur = p; continue; }
    // single piece too long: split by words
    const words = p.split(/\s+/);
    cur = '';
    for (const w of words) {
      const c2 = cur ? `${cur} ${w}` : w;
      if (fits(c2)) cur = c2; else { chunks.push(cur); cur = w; }
    }
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => wrapRows(c, opts.maxChars).join('\n'));
}

/**
 * Subtitle cues for one line. Single-chunk lines cover the real speech span. Longer lines are
 * split on clause boundaries and each chunk is timed by mapping its position in the Ukrainian
 * text onto the forced-aligned English words (word-level sync, not character-count durations).
 */
export function cuesForLine(line: TimelineLine, opts: CueOptions): SubtitleCue[] {
  if (line.kind === 'sfx') {
    return [{ text: line.ua, start: line.start, end: line.end, hide: line.end + opts.lingerSeconds }];
  }
  const chunks = chunkSubtitle(line.ua, opts);
  const speechStart = line.start + (line.words[0]?.t0 ?? 0.05);
  const speechEnd = line.start + (line.words[line.words.length - 1]?.t1 ?? line.duration - 0.1);
  const lens = chunks.map((c) => c.replace(/\n/g, ' ').length);
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const timeAt = (frac: number): number => {
    if (frac <= 0) return speechStart;
    if (frac >= 1) return speechEnd;
    const w = line.words;
    if (w.length === 0) return speechStart + frac * (speechEnd - speechStart);
    const pos = frac * w.length;
    const i = Math.min(w.length - 1, Math.floor(pos));
    // inside word i: interpolate its span; between words we jump at the start of the next word
    const within = pos - i;
    return line.start + w[i].t0 + within * (w[i].t1 - w[i].t0);
  };
  const cues: SubtitleCue[] = [];
  let acc = 0;
  chunks.forEach((text, i) => {
    const f0 = acc / total;
    acc += lens[i];
    const f1 = acc / total;
    const start = i === 0 ? speechStart : timeAt(f0);
    const end = i === chunks.length - 1 ? speechEnd : timeAt(f1);
    cues.push({ text, start: start - opts.leadSeconds, end, hide: end + opts.lingerSeconds });
  });
  tidy(cues);
  return cues;
}

/** A cue never runs into (or lingers over) the next one. */
function tidy(cues: SubtitleCue[]) {
  for (let i = 0; i < cues.length - 1; i++) {
    const next = cues[i + 1].start;
    cues[i].end = Math.min(cues[i].end, next);
    cues[i].hide = Math.max(cues[i].end, Math.min(cues[i].hide, next));
  }
}

export function buildCues(lines: TimelineLine[], opts: CueOptions): SubtitleCue[] {
  const all = lines.flatMap((l) => cuesForLine(l, opts));
  tidy(all);
  return all;
}

export function cueAt(cues: SubtitleCue[], t: number): SubtitleCue | null {
  let lo = 0, hi = cues.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans < 0) return null;
  return t < cues[ans].hide ? cues[ans] : null;
}
