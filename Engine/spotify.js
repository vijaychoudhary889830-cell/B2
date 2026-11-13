// Tiny Spotify Web API client (client-credentials flow) used ONLY to search
// for accurate song names/artists. Spotify audio can't be streamed by bots,
// so the actual audio is still found on SoundCloud using "title artist".
//
// Needs env vars SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET
// (create an app at https://developer.spotify.com/dashboard).

let token = null;
let expiresAt = 0;

function isConfigured() {
  return !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

async function getToken() {
  if (token && Date.now() < expiresAt - 30_000) return token;
  const basic = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Spotify token request failed (${res.status})`);
  const data = await res.json();
  token = data.access_token;
  expiresAt = Date.now() + data.expires_in * 1000;
  return token;
}

// Returns [{ title, artist, duration, url }]
async function searchSpotify(query, limit = 5) {
  const t = await getToken();
  const res = await fetch(`https://api.spotify.com/v1/search?type=track&limit=${limit}&q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  if (!res.ok) throw new Error(`Spotify search failed (${res.status})`);
  const data = await res.json();
  return (data.tracks?.items || []).map(tr => {
    const secs = Math.round(tr.duration_ms / 1000);
    return {
      title: tr.name,
      artist: tr.artists.map(a => a.name).join(', '),
      durationMs: tr.duration_ms,
      duration: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`,
      url: tr.external_urls?.spotify,
    };
  });
}

// Free fallback with no account or keys: Apple's public iTunes Search API.
async function searchItunes(query, limit = 5) {
  for (const country of ['US', 'IN']) {
    const res = await fetch(`https://itunes.apple.com/search?media=music&entity=song&limit=${limit}&country=${country}&term=${encodeURIComponent(query)}`);
    if (!res.ok) continue;
    const data = await res.json();
    const items = data.results || [];
    if (!items.length) continue;
    return items.map(tr => {
      const secs = Math.round((tr.trackTimeMillis || 0) / 1000);
      return {
        title: tr.trackName,
        artist: tr.artistName,
        durationMs: tr.trackTimeMillis || 0,
        duration: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`,
        url: tr.trackViewUrl,
      };
    });
  }
  return [];
}

// Uses Spotify when keys are set, otherwise (or if Spotify fails) iTunes.
// Always available, so callers don't need to check configuration.
async function searchTracks(query, limit = 5) {
  if (isConfigured()) {
    try {
      const r = await searchSpotify(query, limit);
      if (r.length) return Object.assign(r, { source: 'Spotify' });
    } catch (err) {
      console.error('[music] Spotify failed, using iTunes:', err.message);
    }
  }
  const r = await searchItunes(query, limit);
  return Object.assign(r, { source: 'Apple Music' });
}

module.exports = { isConfigured, searchTracks };
