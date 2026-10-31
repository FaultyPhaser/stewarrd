import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { dashboardPage } from './web/dev/dashboardPage.ts';
import { seerrProxy } from './web/dev/seerrProxy.ts';

const root = path.dirname(fileURLToPath(import.meta.url));

// `npm run build:web` builds each browser bundle separately (WEB_ENTRY=dashboard|inject) as one IIFE file
// plus one CSS file in public/, at the fixed URLs the server, the EJS shell and the nginx config expect.
const entry = process.env.WEB_ENTRY === 'inject' ? 'inject' : 'dashboard';

// Dev server: serves both UIs with HMR and proxies to a locally running sidecar (and optionally a real Seerr).
const sidecar = process.env.SIDECAR_URL || 'http://127.0.0.1:3000';
const seerr = process.env.SEERR_DEV_URL;

export default defineConfig(({ command }) => ({
  plugins: [preact(), dashboardPage({ rootIsDashboard: !seerr })],
  // Only the production bundle needs this: it runs as a plain script, where `process` does not exist.
  define: command === 'build' ? { 'process.env.NODE_ENV': JSON.stringify('production') } : {},
  build: {
    outDir: path.join(root, 'public'),
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: path.join(root, 'web', entry, 'main.tsx'),
      formats: ['iife'],
      name: `stewarrd_${entry}`,
      fileName: () => `${entry}.js`,
      cssFileName: entry,
    },
  },
  server: {
    proxy: {
      '/sidecar-api': { target: sidecar, changeOrigin: true, rewrite: (p) => p.replace(/^\/sidecar-api/, '/api') },
      '/sidecar-assets': { target: sidecar, changeOrigin: true, rewrite: (p) => p.replace(/^\/sidecar-assets/, '/public') },
      ...(seerr ? seerrProxy(seerr) : {}),
    },
  },
  test: {
    include: ['web/**/*.test.{ts,tsx}'],
    environment: 'node', // component tests opt in to a DOM with `// @vitest-environment happy-dom`
  },
}));
