export async function parseGoogleMapsUrl(rawUrl: string): Promise<{ latitude: number; longitude: number } | null> {
  let url = rawUrl.trim();
  if (!url) return null;

  // Short links (maps.app.goo.gl, goo.gl/maps/...) don't carry coordinates
  // themselves — resolve the redirect first to get the real URL.
  if (/goo\.gl/.test(url)) {
    try {
      const response = await fetch(url);
      url = response.url || url;
    } catch {
      return null;
    }
  }

  // .../@12.9716,77.5946,15z
  const atMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (atMatch) return { latitude: parseFloat(atMatch[1]), longitude: parseFloat(atMatch[2]) };

  // ...?q=12.9716,77.5946 or &q=12.9716,77.5946
  const qMatch = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (qMatch) return { latitude: parseFloat(qMatch[1]), longitude: parseFloat(qMatch[2]) };

  // ...!3d12.9716!4d77.5946 (embedded in some place share links)
  const dMatch = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (dMatch) return { latitude: parseFloat(dMatch[1]), longitude: parseFloat(dMatch[2]) };

  return null;
}
