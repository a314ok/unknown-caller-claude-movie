import '@fontsource/cormorant-garamond/cyrillic-600.css';
import '@fontsource/cormorant-garamond/latin-600.css';
import '@fontsource/cormorant-garamond/cyrillic-500-italic.css';
import '@fontsource/neucha/cyrillic-400.css';
import '@fontsource/permanent-marker/latin-400.css';
import '@fontsource/special-elite/latin-400.css';
import './app/styles.css';

import scenarioJson from '../scenario/scenario.json';
import { AudioEngine } from './audio/engine';
import { Player, type Format } from './app/player';
import { bindUi } from './app/ui';
import type { Manifest, Scenario } from './core/types';
import { exportWebM, pickMime } from './export/recorder';

const scenario = scenarioJson as unknown as Scenario;
/** dev aid: ?partial=1 plays only the lines that already have generated audio */
const PARTIAL = new URLSearchParams(location.search).get('partial') === '1';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const PREVIEW: Record<Format, [number, number]> = { landscape: [1280, 720], portrait: [720, 1280] };

async function loadFonts() {
  const probes = ['600 40px "Cormorant Garamond"', '400 40px "Permanent Marker"', '400 30px "Special Elite"'];
  await Promise.all(probes.map((f) => document.fonts.load(f, 'АаБбЖжЯя Aa')));
  await document.fonts.ready;
}

async function loadManifest(): Promise<Manifest> {
  const res = await fetch(`${import.meta.env.BASE_URL}audio/manifest.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error('audio/manifest.json not found');
  return res.json();
}

async function main() {
  const gateStatus = $('gate-status');
  const begin = $<HTMLButtonElement>('begin');
  let manifest: Manifest;
  let partialNote = '';
  let draftNote = '';
  try {
    manifest = await loadManifest();
    const total = scenario.lines.length;
    const missing = scenario.lines.filter((l) => !manifest.lines[l.id]).map((l) => l.id);
    if (missing.length === total) throw new Error('no generated voice audio found');
    const drafts = scenario.lines.filter((l) => manifest.lines[l.id]?.engine === 'sapi-draft').length;
    if (drafts) draftNote = `DRAFT VOICES: ${drafts} of ${total - 1} spoken lines use an offline stand-in voice (Windows SAPI + the same DSP). The other lines are OmniVoice. Run python tts/cli.py gen on a GPU to replace them.`;
    if (PARTIAL || missing.length) {
      // Voices are generated offline (tts/cli.py). Until every line exists, play what exists - and say so.
      scenario.lines = scenario.lines.filter((l) => manifest.lines[l.id]);
      partialNote = `PREVIEW: ${scenario.lines.length} of ${total} lines have generated voices (missing ${missing.length}).
Run  python tts/cli.py all  to generate the rest.`;
    }
  } catch (e) {
    gateStatus.className = 'status err';
    gateStatus.textContent = `${(e as Error).message}\n\nGenerate the voices first:\n  python tts/cli.py all\n(see README.md → "Voice generation")`;
    begin.disabled = true;
    return;
  }

  begin.addEventListener('click', async () => {
    begin.disabled = true;
    gateStatus.textContent = partialNote || draftNote || 'tuning the line…';
    try {
      const engine = new AudioEngine();
      await engine.resume();
      const player = new Player(scenario, manifest, engine);
      await loadFonts();
      await player.init($<HTMLCanvasElement>('view'));
      const urls = player.tl.lines.flatMap((l) => [l.file, ...l.layers.map((x) => x.file)]).map((u) => `${import.meta.env.BASE_URL}${u}`);
      // timeline stores bare paths; map them to full URLs for fetch/decode
      await engine.load(urls, (d, n) => { gateStatus.textContent = `loading voices ${d}/${n}`; });
      if (partialNote) console.warn(partialNote);
      for (const l of player.tl.lines) {
        l.file = `${import.meta.env.BASE_URL}${l.file}`;
        l.layers.forEach((x) => { x.file = `${import.meta.env.BASE_URL}${x.file}`; });
      }
      $('gate').classList.add('gone');
      const ui = bindUi(player, scenario, PREVIEW, pickMime() !== null, exportWebM);
      if (partialNote || draftNote) ui.say((partialNote || draftNote).split('\n').join(' '), true);
      (window as unknown as { __uc: unknown }).__uc = { player, engine, scenario, exportWebM, ui };
      await player.begin({});
    } catch (e) {
      console.error(e);
      gateStatus.className = 'status err';
      gateStatus.textContent = `Could not start: ${(e as Error).message}`;
      begin.disabled = false;
    }
  });
}

void main();
