import type { Plugin } from 'vite';

/**
 * Serves the dashboard through Vite in dev (hot reload). Production still gets its page from the EJS shell; this
 * fills in the same `data-*` flags the server would, from the same env vars the sidecar reads (DEV_MODE, ADMIN_RUN).
 * With no Seerr proxy in front, `/` shows the dashboard; otherwise open /web/dashboard/index.html.
 */
export function dashboardPage({ rootIsDashboard }: { rootIsDashboard: boolean }): Plugin {
  const adminRun = Number(process.env.ADMIN_RUN) > 0;
  const devMode = !adminRun && process.env.DEV_MODE !== '0'; // fake login is what makes the dev page usable
  return {
    name: 'stewarrd-dashboard-page',
    transformIndexHtml(html) {
      return html.replace('__DEV_MODE__', String(devMode)).replace('__ADMIN_RUN__', String(adminRun));
    },
    configureServer(server) {
      if (!rootIsDashboard) return;
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/' || req.url?.startsWith('/?')) req.url = '/web/dashboard/index.html';
        next();
      });
    },
  };
}
