// The three URL shapes a Google-embedded coordinate can appear in. Split out
// of googleMapsLink.ts into its own file with zero imports (that file pulls
// in ./supabase, which breaks plain-Node module resolution the moment the
// file is evaluated — even for an unrelated export) so this stays directly
// unit-testable, same reasoning as placeRanking.ts.
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
