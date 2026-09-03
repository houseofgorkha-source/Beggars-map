// Mirrors web/src/lib/extractGoogleCoords.ts — split out of googleMapsLink.ts
// into its own file with zero imports so it stays directly unit-testable
// under plain Node (that file's ./supabase import breaks strict ESM
// resolution the moment the file is evaluated, even for an unrelated export).
export function extractGoogleCoordsFromUrl(url: string): { latitude: number; longitude: number; source: 'google' } | null {
  // .../@12.9716,77.5946,15z
  const atMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (atMatch) return { latitude: parseFloat(atMatch[1]), longitude: parseFloat(atMatch[2]), source: 'google' };

  // ...?q=12.9716,77.5946 or &q=12.9716,77.5946
  const qMatch = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (qMatch) return { latitude: parseFloat(qMatch[1]), longitude: parseFloat(qMatch[2]), source: 'google' };

  // ...!3d12.9716!4d77.5946 (embedded in some place share links)
  const dMatch = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (dMatch) return { latitude: parseFloat(dMatch[1]), longitude: parseFloat(dMatch[2]), source: 'google' };

  return null;
}
