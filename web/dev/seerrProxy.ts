import type { ServerResponse } from 'node:http';
import type { ProxyOptions } from 'vite';

// What the nginx `sub_filter` does in production: put the injected UI into Seerr's HTML. In dev the script is the
// Vite-served source, so edits hot-reload inside the real Seerr pages.
const DEV_SCRIPTS = '<script type="module" src="/@vite/client"></script>'
  + '<script type="module" src="/web/inject/main.tsx"></script>';

/** Everything that is not ours (Vite internals, our sources, the sidecar proxies) goes to Seerr. */
const SEERR_PATHS = '^/(?!(sidecar-api|sidecar-assets|@|web/|node_modules/))';

export function seerrProxy(target: string): Record<string, ProxyOptions> {
  return {
    [SEERR_PATHS]: {
      target,
      changeOrigin: true,
      selfHandleResponse: true,
      headers: { 'accept-encoding': 'identity' }, // keep the body uncompressed so it can be rewritten
      configure(proxy) {
        proxy.on('proxyRes', (proxyRes, _req, res) => {
          const out = res as ServerResponse;
          const status = proxyRes.statusCode ?? 200;
          if (!String(proxyRes.headers['content-type'] ?? '').includes('text/html')) {
            out.writeHead(status, proxyRes.headers);
            proxyRes.pipe(out);
            return;
          }
          const chunks: Buffer[] = [];
          proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
          proxyRes.on('end', () => {
            const html = Buffer.concat(chunks).toString('utf8').replace('</head>', `${DEV_SCRIPTS}</head>`);
            const headers = { ...proxyRes.headers, 'content-length': String(Buffer.byteLength(html)) };
            out.writeHead(status, headers);
            out.end(html);
          });
        });
      },
    },
  };
}
