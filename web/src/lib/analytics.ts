// GA4 (gtag.js) + Cloudflare Web Analytics (beacon), each loaded at runtime
// only when its own env var is present and non-empty — never a static tag
// in index.html, since that can't conditionally omit itself, and never an
// invented/blank id. Set VITE_GA4_MEASUREMENT_ID / VITE_CLOUDFLARE_BEACON_TOKEN
// in web/.env (or Vercel's project env vars for production) to enable either.
declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

function loadGA4(measurementId: string): void {
  const loader = document.createElement('script');
  loader.async = true;
  loader.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
  document.head.appendChild(loader);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag(...args: unknown[]) {
    window.dataLayer!.push(args);
  };
  window.gtag('js', new Date());
  window.gtag('config', measurementId);
}

function loadCloudflareAnalytics(beaconToken: string): void {
  const beacon = document.createElement('script');
  beacon.defer = true;
  beacon.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  beacon.setAttribute('data-cf-beacon', JSON.stringify({ token: beaconToken }));
  document.head.appendChild(beacon);
}

export function initAnalytics(): void {
  try {
    const ga4Id = import.meta.env.VITE_GA4_MEASUREMENT_ID;
    if (ga4Id) loadGA4(ga4Id);

    const cfToken = import.meta.env.VITE_CLOUDFLARE_BEACON_TOKEN;
    if (cfToken) loadCloudflareAnalytics(cfToken);
  } catch {
    // Analytics must never break the app it's measuring.
  }
}

export function trackEvent(event: string, props?: Record<string, string | number | boolean>): void {
  try {
    window.gtag?.('event', event, props);
  } catch {
    // Analytics must never break the app it's measuring.
  }
}
