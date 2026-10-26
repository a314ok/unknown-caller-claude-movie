// Contact sheet of every procedural drawing (dev aid): http://localhost:5173/sheet.html
import { Application, Graphics, Text } from 'pixi.js';
import { crayonStrokes } from './render/crayon';
import { DRAWINGS, drawingStrokes } from './render/drawings';
import { CrayonFilter } from './render/filter';

const app = new Application();
await app.init({ canvas: document.getElementById('v') as HTMLCanvasElement, width: 1600, height: 1200, background: 0, antialias: true, preference: 'webgl', autoStart: false });
app.ticker.stop();
const ids = Object.keys(DRAWINGS).filter((i) => i !== 'none');
const cols = 5, rows = Math.ceil(ids.length / cols);
const cw = 1600 / cols, ch = 1200 / rows;
const g = new Graphics();
app.stage.addChild(g);
ids.forEach((id, i) => {
  const cx = (i % cols) * cw + cw / 2, cy = Math.floor(i / cols) * ch + ch / 2 - 8;
  const strokes = drawingStrokes(id, { t: 1.7, spin: 0.8, stress: 0.35, level: 0.4 });
  crayonStrokes(g, strokes, cx, cy, Math.min(cw, ch) * 0.4, { frame: 3, wobble: 1.4, scale: 3.6, alpha: 1, redMix: 0, seed: 1 }, 10 * i);
  const t = new Text({ text: id, style: { fontFamily: 'monospace', fontSize: 16, fill: 0x777777 } });
  t.anchor.set(0.5); t.position.set(cx, cy + Math.min(cw, ch) * 0.46);
  app.stage.addChild(t);
});
const f = new CrayonFilter();
f.setResolution(1600, 1200);
f.set({ uFrame: 3, uGrain: 0.85, uNoise: 0.04 });
app.stage.filters = [f];
app.render();
(window as unknown as { done: boolean }).done = true;
