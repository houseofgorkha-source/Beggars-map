// Google's official inline bootstrap loader for the Maps JavaScript API
// (https://developers.google.com/maps/documentation/javascript/load-maps-js-api)
// — the currently recommended way to load the API. It exposes
// `google.maps.importLibrary`, which each library is fetched through
// on demand (dynamic library import) rather than via one big upfront
// <script src> with a `libraries=` query string.
//
// This is intentionally not an npm package: Google's own docs recommend
// this exact snippet over a wrapper library for a plain (non-framework-
// specific) app like this one, and it avoids taking on a dependency.
type BootstrapConfig = {
  key: string;
  v?: string;
  [key: string]: unknown;
};

function bootstrapGoogleMaps(g: BootstrapConfig) {
  let h: Promise<void> | undefined;
  let a: HTMLScriptElement;
  const p = 'The Google Maps JavaScript API';
  const c = 'google';
  const l = 'importLibrary';
  const q = '__ib__';
  const m = document;
  const b = window as any;
  b[c] = b[c] || {};
  const d = (b[c].maps = b[c].maps || {});
  const r = new Set<string>();
  const e = new URLSearchParams();
  const u = () =>
    h ||
    (h = new Promise(async (resolve, reject) => {
      a = m.createElement('script');
      e.set('libraries', [...r] + '');
      for (const k in g) {
        e.set(k.replace(/[A-Z]/g, (t) => '_' + t[0].toLowerCase()), String(g[k as keyof BootstrapConfig]));
      }
      e.set('callback', c + '.maps.' + q);
      a.src = `https://maps.${c}apis.com/maps/api/js?` + e;
      d[q] = resolve;
      a.onerror = () => (h = undefined as any) || reject(new Error(p + ' could not load.'));
      a.nonce = m.querySelector('script[nonce]')?.getAttribute('nonce') || '';
      m.head.append(a);
    }));
  if (d[l]) {
    console.warn(p + ' only loads once. Ignoring repeat init.');
  } else {
    d[l] = (f: string, ...n: unknown[]) => r.add(f) && u().then(() => d[l](f, ...n));
  }
}

let loaderStarted = false;

function ensureLoaderStarted() {
  if (loaderStarted) return;
  const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  if (!apiKey) return;
  loaderStarted = true;
  bootstrapGoogleMaps({ key: apiKey, v: 'weekly' });
}

export function hasGoogleMapsKey(): boolean {
  return Boolean(import.meta.env.VITE_GOOGLE_MAPS_API_KEY);
}

export function getMapId(): string | undefined {
  return import.meta.env.VITE_GOOGLE_MAPS_MAP_ID || undefined;
}

export async function loadMapsLibrary(): Promise<google.maps.MapsLibrary> {
  ensureLoaderStarted();
  return (await google.maps.importLibrary('maps')) as google.maps.MapsLibrary;
}

export async function loadMarkerLibrary(): Promise<google.maps.MarkerLibrary> {
  ensureLoaderStarted();
  return (await google.maps.importLibrary('marker')) as google.maps.MarkerLibrary;
}
