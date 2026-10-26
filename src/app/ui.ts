import type { exportWebM as ExportFn } from '../export/recorder';
import { downloadBlob, ExportUnsupportedError } from '../export/recorder';
import type { Scenario } from '../core/types';
import type { Format, Player } from './player';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Wires the DOM chrome (outside the canvas, therefore never part of the recorded video). */
export function bindUi(
  player: Player,
  scn: Scenario,
  preview: Record<Format, [number, number]>,
  canExport: boolean,
  doExport: typeof ExportFn,
) {
  const bar = $('bar');
  const pause = $<HTMLButtonElement>('btn-pause');
  const restart = $<HTMLButtonElement>('btn-restart');
  const exportBtn = $<HTMLButtonElement>('btn-export');
  const tlBtn = $<HTMLButtonElement>('btn-timeline');
  const vol = $<HTMLInputElement>('vol');
  const formatSel = $<HTMLSelectElement>('format');
  const qualitySel = $<HTMLSelectElement>('quality');
  const answer = $<HTMLButtonElement>('answer');
  const canvas = $<HTMLCanvasElement>('view');
  const panel = $('timeline');
  const rows = $('tl-rows');
  const clockEl = $('clock');
  const toast = $('toast');

  [pause, restart].forEach((b) => (b.disabled = false));
  exportBtn.disabled = !canExport;
  if (!canExport) exportBtn.title = 'This browser has no MediaRecorder WebM support';
  bar.classList.remove('hidden-ui');
  bar.classList.add('shown');

  // ---------- toast
  let toastTimer = 0;
  const say = (msg: string, err = false) => {
    toast.textContent = msg;
    toast.className = `on${err ? ' err' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toast.className = ''), err ? 9000 : 4500);
  };

  // ---------- auto-hide the bar
  let idle = 0;
  const wake = () => {
    bar.classList.add('shown'); bar.classList.remove('hidden-ui');
    clearTimeout(idle);
    idle = window.setTimeout(() => {
      if (!player.paused && panel.hidden && !player.exporting) { bar.classList.remove('shown'); bar.classList.add('hidden-ui'); }
    }, 3200);
  };
  ['mousemove', 'pointerdown', 'keydown', 'touchstart'].forEach((e) => window.addEventListener(e, wake, { passive: true }));
  wake();

  // ---------- transport
  const setPauseLabel = () => (pause.textContent = player.paused ? 'RESUME' : 'PAUSE');
  pause.addEventListener('click', async () => { await player.togglePause(); setPauseLabel(); });
  restart.addEventListener('click', async () => { await player.restart(); setPauseLabel(); });
  vol.addEventListener('input', () => player.engine.setVolume(Number(vol.value)));
  formatSel.addEventListener('change', () => {
    const f = formatSel.value as Format;
    player.setFormat(f, ...preview[f]);
    placeAnswer();
    renderRows();
  });
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement)?.tagName === 'SELECT') return;
    if (e.key === ' ' || e.key.toLowerCase() === 'k') {
      if (player.phase === 'ringing') { player.answer(); e.preventDefault(); return; }
      e.preventDefault(); pause.click();
    }
    if (e.key === 'Enter' && player.phase === 'ringing') player.answer();
    if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey) restart.click();
  });

  // ---------- ANSWER hit target, aligned with the button drawn in the canvas
  answer.addEventListener('click', () => player.answer());
  function placeAnswer() {
    const hit = player.scene.answerHit();
    const r = canvas.getBoundingClientRect();
    const ca = canvas.width / canvas.height, ra = r.width / r.height;
    const cw = ca > ra ? r.width : r.height * ca, ch = ca > ra ? r.width / ca : r.height;
    const ox = r.left + (r.width - cw) / 2, oy = r.top + (r.height - ch) / 2;
    Object.assign(answer.style, { left: `${ox + hit.x * cw}px`, top: `${oy + hit.y * ch}px`, width: `${hit.w * cw}px`, height: `${hit.h * ch}px` });
  }
  window.addEventListener('resize', placeAnswer);
  player.onPhase = (p) => {
    answer.hidden = p !== 'ringing';
    if (p === 'ringing') { placeAnswer(); answer.focus({ preventScroll: true }); }
  };

  // ---------- timeline panel
  const tl = player.tl;
  $('tl-meta').textContent = `${tl.lines.length} lines · ${fmtTime(tl.duration)}`;
  function renderRows() {
    rows.textContent = '';
    for (const l of tl.lines) {
      const row = document.createElement('div');
      row.className = 'row';
      row.id = `row-${l.id}`;
      row.tabIndex = 0;
      row.setAttribute('role', 'listitem');
      const names: Record<string, string> = { A: 'CALLER', B: 'AZIK', M: 'AZIK (PARODY)', W: 'HER', S: 'SFX' };
      const fx = Object.entries(l.fx).filter(([, v]) => v !== undefined && v !== 'none').map(([k, v]) => `${k}:${typeof v === 'number' ? v : v}`).join(' · ');
      row.innerHTML = `<div class="t">${fmtTime(l.start)}<br>${l.start.toFixed(1)}s</div>`
        + `<div class="who">${names[l.speaker] ?? l.speaker} · ${l.mood} · ${l.scene}</div>`
        + `<div class="en"></div><div class="ua"></div>`;
      (row.querySelector('.en') as HTMLElement).textContent = l.en;
      (row.querySelector('.ua') as HTMLElement).textContent = l.ua;
      const fxEl = document.createElement('div');
      fxEl.className = 'fx';
      fxEl.textContent = `${l.id} · ${l.engine} · ${l.file.split('/').pop()} · ${fx}`;
      fxEl.style.gridColumn = '2';
      row.appendChild(fxEl);
      const go = () => player.seek(l.start - 0.6);
      row.addEventListener('click', go);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      rows.appendChild(row);
    }
  }
  renderRows();
  const togglePanel = (open: boolean) => {
    panel.hidden = !open;
    tlBtn.setAttribute('aria-expanded', String(open));
  };
  tlBtn.addEventListener('click', () => togglePanel(Boolean(panel.hidden)));
  $('tl-close').addEventListener('click', () => togglePanel(false));

  // ---------- clock + live row (cheap, 5 Hz)
  let liveId = '';
  window.setInterval(() => {
    const t = Math.min(player.callTime, tl.duration);
    clockEl.textContent = `${fmtTime(t)} / ${fmtTime(tl.duration)}`;
    const cur = player.phase === 'call' ? tl.lines.find((l) => t >= l.start && t < l.end)?.id ?? '' : '';
    if (cur !== liveId) {
      document.getElementById(`row-${liveId}`)?.classList.remove('live');
      const el = document.getElementById(`row-${cur}`);
      el?.classList.add('live');
      if (el && !panel.hidden) el.scrollIntoView({ block: 'nearest' });
      liveId = cur;
    }
  }, 200);

  // ---------- export
  const exBox = $('export'), exMsg = $('ex-msg'), exFill = $('ex-fill');
  let abort: AbortController | null = null;
  $('ex-cancel').addEventListener('click', () => abort?.abort());
  const lock = (on: boolean) => {
    [pause, restart, exportBtn, formatSel, qualitySel, tlBtn].forEach((el) => ((el as HTMLButtonElement).disabled = on));
    exBox.hidden = !on;
    if (on) { togglePanel(false); bar.classList.add('shown'); }
  };
  async function runExport(opts: { limitSeconds?: number; fromCallT?: number; upload?: string; codec?: 'vp9' | 'vp8' | 'av1' | 'h264' } = {}) {
    if (player.exporting) return null;
    abort = new AbortController();
    lock(true);
    exFill.style.width = '0%';
    exMsg.textContent = 'Preparing…';
    try {
      const format = formatSel.value as Format;
      const result = await doExport(player, {
        format, quality: qualitySel.value as '1080p' | '720p', codec: opts.codec, limitSeconds: opts.limitSeconds, fromCallT: opts.fromCallT, signal: abort.signal,
        onProgress: (f, m) => { exFill.style.width = `${(f * 100).toFixed(1)}%`; exMsg.textContent = m; },
      });
      const name = `the-unknown-caller-${result.width}x${result.height}.webm`;
      if (opts.upload) {
        await fetch(`/__save-export?name=${encodeURIComponent(opts.upload)}`, { method: 'POST', body: result.blob });
      } else {
        downloadBlob(result.blob, name);
      }
      if (result.warning) say(result.warning, true);
      else say(`Saved ${name} · ${(result.blob.size / 1048576).toFixed(1)} MB · ${result.frames} frames · ${result.audioTracks} audio track`);
      return result;
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') say('Export cancelled');
      else if (err instanceof ExportUnsupportedError) say(err.message, true);
      else { console.error(e); say(`Export failed: ${err.message}`, true); }
      return null;
    } finally {
      lock(false);
      exportBtn.disabled = !canExport;
      player.setFormat(formatSel.value as Format, ...preview[formatSel.value as Format]);
      await player.begin({});
      await player.togglePause();   // leave the preview paused on the first frame after a recording
      setPauseLabel();
    }
  }
  exportBtn.addEventListener('click', () => void runExport());

  // keep the scenario import used for type completeness in devtools
  void scn;
  return { runExport, say, placeAnswer };
}
