// The bundle is served at /sidecar-assets/ behind the Seerr proxy; its CSS and images live next to it.
// `currentScript` is only set while the script first runs, so read it once, at load.
const scriptSrc = (document.currentScript as HTMLScriptElement | null)?.src ?? '';
export const ASSET_BASE = scriptSrc.replace(/\/[^/]*$/, '') || '/sidecar-assets';

/** Production builds extract the CSS to a file, so link it. (The dev server injects imported CSS itself.) */
export function loadStyles(): void {
  if (!import.meta.env.PROD || document.getElementById('sidecar-styles')) return;
  const link = document.createElement('link');
  link.id = 'sidecar-styles';
  link.rel = 'stylesheet';
  link.href = `${ASSET_BASE}/inject.css`;
  document.head.appendChild(link);
}
