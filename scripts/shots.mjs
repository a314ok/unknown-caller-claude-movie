// Screenshot the film at chosen call times (seeks, so it does not need to play in real time):
//   node scripts/shots.mjs 4 30 61 ...        [--portrait]   -> test-output/shot-<t>.png
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';

const times = process.argv.slice(2).filter((a) => !a.startsWith('--')).map(Number);
const portrait = process.argv.includes('--portrait');
const base = process.env.URL ?? 'http://127.0.0.1:5173';
// Windows: Edge/Chrome. Linux: CHROME_PATH, the Playwright Chromium (`bunx playwright install chromium`) or a system Chrome.
const exe = [process.env.CHROME_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', chromium.executablePath()].find((p) => p && existsSync(p));
mkdirSync('test-output', { recursive: true });
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', process.platform === 'win32' ? '--use-angle=d3d11' : '--use-angle=swiftshader'] });
const page = await browser.newPage({ viewport: portrait ? { width: 720, height: 1280 } : { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(base);
await page.click('#begin');
await page.waitForFunction(() => window.__uc?.player.phase === 'ringing', null, { timeout: 120000, polling: 500 });
if (portrait) await page.evaluate(() => { const s = document.getElementById('format'); s.value = 'portrait'; s.dispatchEvent(new Event('change')); });
await page.click('#answer');
await page.waitForFunction(() => window.__uc.player.phase === 'call', null, { timeout: 60000, polling: 250 });
for (const t of times) {
  await page.evaluate((t) => window.__uc.player.seek(t), t);
  await page.waitForTimeout(2600);
  await page.screenshot({ path: `test-output/shot-${portrait ? 'p-' : ''}${t}.png` });
  console.log('shot', t, await page.evaluate(() => Math.round(window.__uc.player.callTime * 10) / 10));
}
await browser.close();
if (errors.length) console.log('page errors:', errors.join(' | '));
