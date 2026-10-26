// End-to-end check in a real (headless) Edge: play → answer → record a WebM → save → report.
//   node scripts/e2e.mjs [--url http://127.0.0.1:5173] [--partial] [--from 0] [--limit 12] [--format landscape|portrait] [--name e2e.webm]
// Needs `bun run dev` running (or `bun run preview`). The recorded file lands in test-output/ and can be checked with
//   python scripts/verify_webm.py test-output/<name>
import { chromium } from 'playwright-core';
import { existsSync, statSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : (process.argv[i + 1]?.startsWith('--') || process.argv[i + 1] === undefined ? true : process.argv[i + 1]); };
const base = arg('url', 'http://127.0.0.1:5173');
const partial = process.argv.includes('--partial');
const from = arg('from', undefined);
const limit = Number(arg('limit', 12));
const format = arg('format', 'landscape');
const name = arg('name', 'e2e.webm');
const quality = arg('quality', '1080p');
const codec = arg('codec', undefined);
// Windows: Edge/Chrome. Linux: CHROME_PATH, the Playwright Chromium (`bunx playwright install chromium`) or a system Chrome.
const exe = [process.env.CHROME_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => p && existsSync(p));
if (!exe) throw new Error('No Edge/Chrome found; set the path in scripts/e2e.mjs');

const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', process.platform === 'win32' ? '--use-angle=d3d11' : '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
await page.goto(`${base}/${partial ? '?partial=1' : ''}`);
await page.click('#begin');
await page.waitForFunction(() => window.__uc && window.__uc.player.phase !== 'black', null, { timeout: 180000, polling: 500 }).catch(async (e) => { console.log('start failed; gate says:', await page.textContent('#gate-status').catch(() => '?')); console.log(errors.join(' | ')); throw e; });
console.log('phase after start:', await page.evaluate(() => window.__uc.player.phase));
await page.waitForFunction(() => window.__uc.player.phase === 'ringing', null, { timeout: 120000, polling: 500 });
await page.screenshot({ path: 'test-output/e2e-ringing.png' }).catch(() => {});
await page.click('#answer');
await page.waitForFunction(() => window.__uc.player.phase === 'call', null, { timeout: 120000, polling: 500 });
await page.waitForTimeout(4000);
const live = await page.evaluate(() => ({ t: window.__uc.player.callTime, fps: 0, ctx: window.__uc.engine.ctx.state }));
console.log('in call:', live);
await page.screenshot({ path: 'test-output/e2e-call.png' });

const t0 = Date.now();
const result = await page.evaluate(async ({ limit, from, format, name, quality, codec }) => {
  document.getElementById('quality').value = quality;
  const sel = document.getElementById('format');
  sel.value = format; sel.dispatchEvent(new Event('change'));
  const r = await window.__uc.ui.runExport({ limitSeconds: limit, fromCallT: from === undefined ? undefined : Number(from), upload: name, codec });
  return r && { bytes: r.blob.size, mime: r.mime, frames: r.frames, seconds: r.seconds, w: r.width, h: r.height, audio: r.audioTracks, video: r.videoTracks, patched: r.durationPatched, realtimeRatio: +r.realtimeRatio.toFixed(2), captureMsAvg: +r.captureMsAvg.toFixed(1), warning: r.warning };
}, { limit, from, format, name, quality, codec });
const st = await page.evaluate(() => window.__uc.player.stats);
console.log(`preview render: ${st.frames} frames, avg ${(st.renderMs / Math.max(1, st.frames)).toFixed(1)} ms, max ${st.maxMs.toFixed(0)} ms`);
console.log(`export finished in ${((Date.now() - t0) / 1000).toFixed(1)} s`, result);
const st2 = await page.evaluate(() => window.__uc.player.stats);
console.log(`after export: ${st2.frames} frames, avg ${(st2.renderMs / Math.max(1, st2.frames)).toFixed(1)} ms, max ${st2.maxMs.toFixed(0)} ms`);
await browser.close();
const out = `test-output/${name}`;
console.log(existsSync(out) ? `saved ${out} (${(statSync(out).size / 1048576).toFixed(2)} MB)` : 'NOT SAVED');
if (errors.length) console.log('page errors:\n' + errors.join('\n'));
process.exit(existsSync(out) && result && result.audio >= 1 && result.frames > 10 ? 0 : 1);
