import { defineConfig, type Plugin } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Dev-only helper: lets an automated test post the recorded WebM back to the dev server so it
 * can be inspected with ffmpeg (scripts/verify-webm.mjs). The shipped app downloads the file
 * through the browser as usual; this endpoint does not exist in `vite build` output.
 */
function saveExport(): Plugin {
  return {
    name: 'save-export',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__save-export', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        const name = String(new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? 'export.webm').replace(/[^\w.-]/g, '_');
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const dir = join(process.cwd(), 'test-output');
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, name), Buffer.concat(chunks));
          res.end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [saveExport()],
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { fs: { strict: false } },
});
