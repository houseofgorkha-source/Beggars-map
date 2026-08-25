export async function parseGoogleMapsUrl(rawUrl: string): Promise<{ latitude: number; longitude: number } | null> {
  let url = rawUrl.trim();
  if (!url) return null;

  if (/goo\.gl/.test(url)) {
    // Browser fetch enforces CORS, unlike React Native's — if Google doesn't
    // send permissive CORS headers on this redirect, this throws and we fall
    // through to null. Full-length @lat,lng links below don't need this step.
    try {
      const response = await fetch(url);
      url = response.url || url;
    } catch {
      return null;
    }
  }

  const atMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (atMatch) return { latitude: parseFloat(atMatch[1]), longitude: parseFloat(atMatch[2]) };

  const qMatch = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (qMatch) return { latitude: parseFloat(qMatch[1]), longitude: parseFloat(qMatch[2]) };

  const dMatch = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (dMatch) return { latitude: parseFloat(dMatch[1]), longitude: parseFloat(dMatch[2]) };

  return null;
}
