// Picks the SoundCloud upload that best matches an official Spotify track,
// using duration, title words, artist and a penalty for remix-style uploads.

const { QueryType } = require('discord-player');
const spotify = require('./spotify');

const BAD_WORDS = ['remix', 'slowed', 'reverb', 'sped', 'speed', 'lofi', 'lo-fi', 'cover', 'mashup', 'karaoke',
  'nightcore', 'instrumental', 'bass boosted', 'mix', 'edit', 'live', '8d', 'status', 'shorts', 'reel'];

const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => norm(s).split(' ').filter(w => w.length > 1);

function score(candidate, target, queryText) {
  const title = String(candidate.title || '').toLowerCase();
  const wanted = `${target.title} ${queryText}`.toLowerCase();
  let s = 0;

  // Duration is the strongest signal.
  if (candidate.durationMS && target.durationMs) {
    const diff = Math.abs(candidate.durationMS - target.durationMs) / 1000;
    s += diff <= 3 ? 60 : diff <= 8 ? 40 : diff <= 20 ? 15 : -Math.min(diff, 90) / 2;
  }

  // Title words from the official title.
  const tw = words(target.title);
  if (tw.length) {
    const hay = norm(candidate.title);
    s += 35 * (tw.filter(w => hay.includes(w)).length / tw.length);
  }

  // Artist appears in the upload title or uploader name.
  const aw = words(target.artist.split(',')[0]);
  const ahay = norm(`${candidate.title} ${candidate.author}`);
  if (aw.length && aw.some(w => ahay.includes(w))) s += 15;

  // Penalise remix-style uploads unless the user/official title asked for them.
  for (const bad of BAD_WORDS) {
    if (title.includes(bad) && !wanted.includes(bad)) s -= 40;
  }
  return s;
}

// Returns a Track (best match) or null.
async function findBestTrack(player, queryText, requestedBy) {
  const [official] = await spotify.searchTracks(queryText, 1);
  if (!official) return null;

  const seen = new Map();
  for (const q of [`${official.title} ${official.artist}`, `${official.title} ${official.artist.split(',')[0]} official`]) {
    try {
      const res = await player.search(q, { searchEngine: QueryType.SOUNDCLOUD_SEARCH, requestedBy });
      for (const t of res.tracks.slice(0, 10)) seen.set(t.url, t);
    } catch (err) {
      console.error('[music] matcher search failed:', err.message);
    }
  }
  if (!seen.size) return null;

  const ranked = [...seen.values()]
    .map(t => ({ t, s: score(t, official, queryText) }))
    .sort((a, b) => b.s - a.s);
  console.log(`[music] matched "${queryText}" -> official "${official.title} – ${official.artist}" -> "${ranked[0].t.title}" (score ${ranked[0].s.toFixed(0)})`);
  return ranked[0].t;
}

module.exports = { findBestTrack };
