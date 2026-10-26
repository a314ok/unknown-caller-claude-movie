// Scene lab: drive the renderer directly (no audio) to tune drawings, scene looks and subtitles.
// Open /lab.html while `bun run dev` is running. Query: ?draw=wheel&scene=bride&phase=call&portrait=1
import '@fontsource/cormorant-garamond/cyrillic-600.css';
import '@fontsource/cormorant-garamond/latin-600.css';
import '@fontsource/permanent-marker/latin-400.css';
import '@fontsource/special-elite/latin-400.css';
import { Application } from 'pixi.js';
import scenarioJson from '../scenario/scenario.json';
import { DRAWINGS } from './render/drawings';
import { CallScene, type FrameState } from './render/scene';
import type { Scenario, SceneParams } from './core/types';

const scn = scenarioJson as unknown as Scenario;
const q = new URLSearchParams(location.search);
const state = {
  draw: q.get('draw') ?? 'wheel', scene: q.get('scene') ?? 'wheel', phase: (q.get('phase') ?? 'call') as FrameState['phase'],
  portrait: q.get('portrait') === '1', voice: 0.5, shake: 0, flash: 0, ghosts: 0, spin: 0.5, sub: 'Всім похуй на тебе, Азічок.', speaker: 'A' as FrameState['speaker'],
};
const ctl = document.getElementById('c')!;
const mk = (name: string, opts: string[], key: keyof typeof state) => {
  const l = document.createElement('label'); l.textContent = name;
  const s = document.createElement('select');
  opts.forEach((o) => s.add(new Option(o, o)));
  s.value = String(state[key]); s.onchange = () => ((state as any)[key] = s.value); l.append(s); ctl.append(l);
};
const num = (name: string, key: keyof typeof state, max = 1) => {
  const l = document.createElement('label'); l.textContent = name;
  const i = document.createElement('input'); i.type = 'range'; i.min = '0'; i.max = String(max); i.step = '0.01'; i.value = String(state[key]);
  i.oninput = () => ((state as any)[key] = Number(i.value)); l.append(i); ctl.append(l);
};
mk('draw', Object.keys(DRAWINGS), 'draw'); mk('scene', Object.keys(scn.scenes), 'scene'); mk('phase', ['ringing', 'answering', 'call'], 'phase');
mk('speaker', ['A', 'B', 'M', 'W'], 'speaker');
num('voice', 'voice'); num('shake', 'shake'); num('flash', 'flash'); num('ghosts', 'ghosts', 6); num('spin', 'spin', 2);

const app = new Application();
await app.init({ canvas: document.getElementById('v') as HTMLCanvasElement, width: 1280, height: 720, background: 0, antialias: true, preference: 'webgl', autoStart: false });
app.ticker.stop();
await Promise.all(['600 40px "Cormorant Garamond"', '400 40px "Permanent Marker"', '400 30px "Special Elite"'].map((f) => document.fonts.load(f, 'АаЯя Aa')));
await document.fonts.ready;
const scene = new CallScene(app);
scene.setFormat(state.portrait, state.portrait ? 720 : 1280, state.portrait ? 1280 : 720);
const t0 = performance.now();
const loop = () => {
  const clock = (performance.now() - t0) / 1000;
  const sc = scn.scenes[state.scene];
  const p: SceneParams = { ...sc, shake: state.shake, flash: state.flash, ghosts: Math.round(state.ghosts), spin: state.spin, scratchBoost: 0 };
  const s: FrameState = {
    phase: state.phase, clock, phaseT: clock, callT: clock + 20, p, voice: state.voice * (0.6 + 0.4 * Math.sin(clock * 7) ** 2), speaker: state.speaker,
    draw: state.draw, ringOn: state.phase === 'ringing' && clock % 3.9 < 2,
    answerPress: state.phase === 'answering' ? Math.min(1, clock) : 0, label: scn.intro.label, lineDropped: false,
    cue: { text: state.sub, start: 0, end: 1e9, hide: 1e9 },
  };
  scene.render(s);
  requestAnimationFrame(loop);
};
loop();
