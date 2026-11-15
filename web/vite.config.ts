import { copyFileSync, createReadStream, existsSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const webDir = fileURLToPath(new URL('.', import.meta.url));
const presentationPath = resolve(webDir, '../reports/AppPP.pptx');
const presentationUrl = '/presentation.pptx';

function sendPresentation(req: Connect.IncomingMessage, res: ServerResponse, next: Connect.NextFunction) {
  const path = (req.url ?? '').split('?')[0];
  if (path !== presentationUrl || !existsSync(presentationPath)) {
    next();
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.setHeader('Content-Length', String(statSync(presentationPath).size));
  res.setHeader('Content-Disposition', 'attachment; filename="Cropfather-presentation.pptx"');
  createReadStream(presentationPath).pipe(res);
}

function presentationFile(): Plugin {
  return {
    name: 'presentation-file',
    configureServer(server) {
      server.middlewares.use(sendPresentation);
    },
    configurePreviewServer(server) {
      server.middlewares.use(sendPresentation);
    },
    closeBundle() {
      if (!existsSync(presentationPath)) return;
      copyFileSync(presentationPath, resolve(webDir, 'dist/presentation.pptx'));
    },
  };
}

export default defineConfig({
  plugins: [presentationFile(), react(), tailwindcss()],
});