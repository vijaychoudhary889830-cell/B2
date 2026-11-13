// Music engine — powered by discord-player.
// registerMusic(client) creates the Player, loads extractors and wires the
// "now playing" / "queue finished" announcements. Slash commands live in
// Commands/music.js and pull the shared Player via useMainPlayer()/useQueue().

const { Player, QueueRepeatMode, useMainPlayer } = require('discord-player');
const { EmbedBuilder } = require('discord.js');
const db = require('../database');

const COLOR = '#38a3ff';

// The bundled static ffmpeg crashes (SIGSEGV) whenever it opens a network URL itself, which made
// every track end instantly. So Node downloads the audio and ffmpeg only reads it from a pipe.
// SoundCloud serves HLS playlists, so those are downloaded segment by segment and joined here.
const { Readable } = require('stream');
const UA = { 'user-agent': 'Mozilla/5.0' };

async function httpGet(u) {
  const r = await fetch(u, { headers: UA });
  if (!r.ok) throw new Error('http ' + r.status + ' ' + String(u).slice(0, 70));
  return r;
}

async function hlsToStream(playlistUrl) {
  let url = playlistUrl;
  let text = await (await httpGet(url)).text();
  if (/#EXT-X-STREAM-INF/.test(text)) { // master playlist -> take the first variant
    const lines = text.split(/\r?\n/);
    const i = lines.findIndex(l => l.startsWith('#EXT-X-STREAM-INF'));
    const variant = lines.slice(i + 1).find(l => l.trim() && !l.startsWith('#'));
    url = new URL(variant.trim(), url).href;
    text = await (await httpGet(url)).text();
  }
  if (/#EXT-X-KEY:(?!.*METHOD=NONE)/.test(text)) throw new Error('encrypted HLS is not supported');
  const lines = text.split(/\r?\n/);
  const urls = [];
  const map = lines.find(l => l.startsWith('#EXT-X-MAP'));
  if (map) { const m = map.match(/URI="([^"]+)"/); if (m) urls.push(new URL(m[1], url).href); }
  for (const l of lines) if (l.trim() && !l.startsWith('#')) urls.push(new URL(l.trim(), url).href);
  if (!urls.length) throw new Error('empty HLS playlist');

  const fetchSeg = (i) => {
    const pr = httpGet(urls[i]).then(r => r.arrayBuffer()).then(b => Buffer.from(b));
    pr.catch(() => {}); // avoid unhandled rejection if nobody awaits it
    return pr;
  };
  async function* segments() {
    const ahead = 3;
    const queue = [];
    let next = 0;
    while (next < urls.length && queue.length < ahead) queue.push(fetchSeg(next++));
    while (queue.length) {
      const buf = await queue.shift();
      if (next < urls.length) queue.push(fetchSeg(next++));
      yield buf;
    }
  }
  console.log('[music] HLS segments:', urls.length);
  return Readable.from(segments(), { objectMode: false });
}

const withTimeoutMs = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms)),
]);

const isYouTubeTrack = (track) =>
  /youtube/i.test(String(track?.extractor?.identifier || '')) || /youtu\.?be/i.test(String(track?.url || ''));

// Gets playable audio for a track as a Node stream (never lets ffmpeg open a network URL).
// Returns null if nothing usable; throws on extractor errors.
async function rawStream(track) {
  const ext = track && track.extractor;
  if (!ext || typeof ext.stream !== 'function') return null;
  const out = await withTimeoutMs(Promise.resolve(ext.stream(track)), 25_000, 'extractor.stream');
  if (typeof out !== 'string') return out || null; // extractor already gave us a stream
  if (!/^https?:/i.test(out)) return null;
  if (/\.m3u8(\?|$|#)/i.test(out)) {
    console.log('[music] streaming via node (HLS):', track.title);
    return hlsToStream(out);
  }
  const res = await httpGet(out);
  const type = res.headers.get('content-type') || '';
  if (/mpegurl/i.test(type)) {
    try { await res.body.cancel(); } catch {}
    console.log('[music] streaming via node (HLS):', track.title);
    return hlsToStream(out);
  }
  console.log('[music] streaming via node:', track.title, type);
  return Readable.fromWeb(res.body);
}

// If YouTube cannot give us audio (blocked server IP), play the best SoundCloud match instead.
async function soundcloudFallback(track) {
  try {
    const { findBestTrack } = require('./matcher');
    const alt = await findBestTrack(useMainPlayer(), `${track.title} ${track.author || ''}`.trim(), track.requestedBy);
    if (!alt) { console.log('[music] SoundCloud fallback: no match for', track.title); return null; }
    console.log(`[music] YouTube stream failed, falling back to SoundCloud: "${alt.title}"`);
    return await nodeFetchStream(alt, true);
  } catch (err) {
    console.error('[music] SoundCloud fallback failed:', err.message);
    return null;
  }
}

// A YouTube stream can "succeed" but be empty or die at once (blocked IP, 403 page). Wait for the
// first bytes; if they never come, throw so the SoundCloud fallback takes over.
function probeStream(stream, ms = 20_000, minBytes = 16_384) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0, done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.off('data', onData); stream.off('end', onEnd); stream.off('close', onEnd); stream.off('error', onErr);
      if (err) { try { stream.destroy(); } catch {} return reject(err); }
      stream.pause();
      const first = Buffer.concat(chunks);
      console.log(`[music] YouTube stream OK (first ${first.length} bytes)`);
      resolve(Readable.from((async function* () { yield first; for await (const c of stream) yield c; })(), { objectMode: false }));
    };
    const onData = (c) => { const b = Buffer.from(c); chunks.push(b); total += b.length; if (total >= minBytes) finish(); };
    const onEnd = () => finish(new Error(`YouTube stream ended after only ${total} bytes`));
    const onErr = (e) => finish(new Error('YouTube stream error: ' + (e && e.message)));
    const timer = setTimeout(() => finish(new Error(`no YouTube audio data within ${ms / 1000}s`)), ms);
    stream.on('data', onData); stream.on('end', onEnd); stream.on('close', onEnd); stream.on('error', onErr);
  });
}

async function nodeFetchStream(track, isFallback = false) {
  try {
    const stream = await rawStream(track);
    if (stream) return (!isFallback && isYouTubeTrack(track)) ? await probeStream(stream) : stream;
  } catch (err) {
    console.error('[music] onBeforeCreateStream failed:', err.message);
  }
  if (!isFallback && isYouTubeTrack(track)) return soundcloudFallback(track);
  return null;
}

// Queue options shared by /play and 24/7 joins. In 24/7 mode the bot never
// leaves on its own (empty channel, end of queue, or /stop).
function nodeOptions(guildId, metadata) {
  const stay = db.getMusic247(guildId).enabled;
  return {
    metadata,
    volume: 60,
    repeatMode: db.getAutoplay(guildId) ? QueueRepeatMode.AUTOPLAY : QueueRepeatMode.OFF,
    selfDeaf: true,
    leaveOnEmpty: !stay,
    leaveOnEmptyCooldown: 60_000,
    leaveOnEnd: !stay,
    leaveOnEndCooldown: 60_000,
    leaveOnStop: !stay,
    onBeforeCreateStream: async (track) => nodeFetchStream(track),
  };
}

// Joins the saved voice channel for a guild (idempotent).
async function join247(client, player, guildId) {
  const cfg = db.getMusic247(guildId);
  if (!cfg.enabled || !cfg.voiceChannelId) return false;
  const guild = client.guilds.cache.get(guildId);
  const vc = guild?.channels.cache.get(cfg.voiceChannelId);
  if (!guild || !vc) return false;

  let queue = player.nodes.get(guildId);
  if (queue?.connection && guild.members.me?.voice?.channelId === vc.id) return true;

  const textChannel = cfg.textChannelId ? guild.channels.cache.get(cfg.textChannelId) : null;
  queue = queue || player.nodes.create(guild, nodeOptions(guildId, { channel: textChannel }));
  await queue.connect(vc);
  return true;
}

function checkFfmpeg() {
  try {
    const fs = require('fs');
    const { spawnSync } = require('child_process');
    try {
      const p = require('ffmpeg-static');
      const ok = !!p && fs.existsSync(p);
      console.log('[music] ffmpeg-static:', p || 'none', ok ? '(found)' : '(MISSING)');
      if (ok) process.env.FFMPEG_PATH = p;
    } catch (err) {
      console.log('[music] ffmpeg-static not available:', err.message);
    }
    const r = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version']);
    console.log('[music] ffmpeg check:', r.error ? `FAILED (${r.error.message})` : String(r.stdout).split('\n')[0]);
  } catch (err) {
    console.log('[music] ffmpeg check error:', err.message);
  }
}

// Startup self-test: shows whether ffmpeg can decode audio, fetch an https URL, and read audio
// piped from Node, plus memory use. Results appear as [music][selftest] lines.
function selfTest() {
  const { spawn } = require('child_process');
  const bin = process.env.FFMPEG_PATH || 'ffmpeg';
  const mb = (n) => Math.round(n / 1048576) + 'MB';
  const mem = () => `rss=${mb(process.memoryUsage().rss)} heap=${mb(process.memoryUsage().heapUsed)}`;
  console.log('[music][selftest] node', process.version, mem());
  try {
    const os = require('os');
    let limit = 'n/a';
    for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
      try { limit = require('fs').readFileSync(f, 'utf8').trim(); break; } catch {}
    }
    console.log(`[music][selftest] os total=${mb(os.totalmem())} free=${mb(os.freemem())} cgroupLimit=${limit}`);
  } catch {}

  const run = (label, args, feeder) => new Promise(resolve => {
    let err = '', bytes = 0;
    const p = spawn(bin, ['-hide_banner', '-loglevel', 'error', ...args]);
    const timer = setTimeout(() => { err += ' (timeout 20s)'; p.kill('SIGKILL'); }, 20_000);
    p.stdout.on('data', d => { bytes += d.length; });
    p.stderr.on('data', d => { err += d.toString(); });
    p.stdin.on('error', () => {});
    p.on('error', e => { err += ' spawn error: ' + e.message; });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      console.log(`[music][selftest] ${label}: exit=${code} signal=${signal} outBytes=${bytes} ${mem()} ${err.trim().split('\n').slice(-3).join(' | ')}`);
      resolve();
    });
    if (feeder) feeder(p.stdin).catch(e => { err += ' feeder: ' + e.message; try { p.stdin.end(); } catch {} });
  });

  const URL_OGG = 'https://upload.wikimedia.org/wikipedia/commons/c/c8/Example.ogg';
  (async () => {
    await run('A ffmpeg local tone', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'null', '-']);
    await run('B ffmpeg fetches https itself', ['-t', '3', '-i', URL_OGG, '-f', 'null', '-']);
    await run('C node fetch piped into ffmpeg', ['-i', 'pipe:0', '-t', '3', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], async (stdin) => {
      const res = await fetch(URL_OGG);
      if (!res.ok) throw new Error('http ' + res.status);
      const { Readable } = require('stream');
      Readable.fromWeb(res.body).on('error', () => {}).pipe(stdin);
    });
  })().catch(e => console.log('[music][selftest] failed:', e.message));
}

function registerMusic(client) {
  checkFfmpeg();
  if (process.env.MUSIC_DEBUG === 'true') selfTest();
  const player = new Player(client, {
    // Sensible defaults; per-queue options are set in /play.
    skipFFmpeg: false,
  });

  // Extractors load asynchronously; commands issued before this finishes will
  // simply fail with "no results", which is fine for the first few seconds.
  (async () => {
    try {
      const { DefaultExtractors } = require('@discord-player/extractor');
      await player.extractors.loadMulti(DefaultExtractors); // SoundCloud, Spotify/Apple/Vimeo metadata, direct links...
    } catch (err) {
      console.error('[music] Failed to load default extractors:', err.message);
    }
    if (process.env.YT_DISABLE === 'true') {
      console.log('[music] YouTube extractor disabled (YT_DISABLE=true) - saves memory, SoundCloud only.');
    } else try {
      // YouTube support (search + playback). Community extractor — if YouTube
      // changes something, `npm update discord-player-youtubei` usually fixes it.
      const _yt = require('discord-player-youtubei'); const YoutubeiExtractor = _yt.YoutubeiExtractor || _yt.YoutubeExtractor;
      // Optional auth/anti-block settings, all read from environment variables:
      //   YT_COOKIE  - cookie string from a throwaway Google account (best fix for datacenter-IP blocks)
      //   YT_OAUTH   - OAuth tokens string (alternative to cookies)
      //   YT_CLIENT  - force a YouTube client for streaming: WEB, TV, ANDROID, IOS, MWEB, WEB_EMBEDDED
      //   YT_POTOKEN - set to "false" to disable automatic PoToken generation
      // One-time phone-friendly login: set YT_OAUTH_SETUP=true on Render (no YT_OAUTH yet),
      // redeploy, then read the code from the logs, open google.com/device on your phone
      // and enter it. The tokens get printed in the logs; put them in YT_OAUTH and
      // remove YT_OAUTH_SETUP.
      if (process.env.YT_OAUTH_SETUP === 'true' && !process.env.YT_OAUTH) {
        try {
          const yt = require('discord-player-youtubei');
          if (typeof yt.generateOauthTokens !== 'function') {
            console.log('[music] OAuth setup: generateOauthTokens not exported. Exports:', Object.keys(yt).join(', '));
          } else {
            console.log('[music] OAuth setup: waiting for the code, open https://google.com/device when it appears below');
            const tokens = await yt.generateOauthTokens();
            console.log('[music] YT_OAUTH =', typeof tokens === 'string' ? tokens : JSON.stringify(tokens));
          }
        } catch (err) {
          console.error('[music] OAuth setup failed:', err.message);
        }
      }
      const ytOptions = {
        generateWithPoToken: process.env.YT_POTOKEN !== 'false',
        ignoreSignInErrors: true,
      };
      if (process.env.YT_COOKIE) ytOptions.cookie = process.env.YT_COOKIE.trim();
      if (process.env.YT_OAUTH) ytOptions.authentication = process.env.YT_OAUTH.trim();
      if (process.env.YT_CLIENT) ytOptions.streamOptions = { useClient: process.env.YT_CLIENT.trim().toUpperCase() };
      console.log('[music] YouTube auth:', ytOptions.cookie ? 'cookie' : ytOptions.authentication ? 'oauth' : 'none',
        '| poToken:', ytOptions.generateWithPoToken, '| client:', process.env.YT_CLIENT || 'default');
      await player.extractors.register(YoutubeiExtractor, ytOptions);
    } catch (err) {
      console.error('[music] YouTube extractor not loaded (run `npm i discord-player-youtubei`):', err.message);
    }
    console.log('[music] Extractors:', [...player.extractors.store.keys()].join(', ') || 'none');
    console.log('[music] Ready.');
  })();

  // 24/7: rejoin saved voice channels on startup, and if the bot gets dropped.
  client.once('ready', async () => {
    // Give extractors a moment to load before rejoining.
    await new Promise(r => setTimeout(r, 5000));
    for (const { guildId } of db.getAllMusic247()) {
      join247(client, player, guildId).catch(err => console.error(`[music] 24/7 rejoin failed (${guildId}):`, err.message));
    }
  });

  client.on('voiceStateUpdate', (oldState, newState) => {
    if (oldState.id !== client.user.id) return;
    if (newState.channelId) return; // still connected somewhere
    const guildId = oldState.guild.id;
    if (!db.getMusic247(guildId).enabled) return;
    setTimeout(() => {
      join247(client, player, guildId).catch(err => console.error('[music] 24/7 reconnect failed:', err.message));
    }, 5000);
  });

  const say = (queue, payload) => {
    const ch = queue.metadata?.channel;
    if (ch) ch.send(payload).catch(() => {});
  };

  // Server-wide autoplay: turn it on once per queue (covers queues created before the setting changed).
  const autoplayApplied = new WeakSet();
  player.events.on('playerStart', (queue, track) => {
    if (!autoplayApplied.has(queue)) {
      autoplayApplied.add(queue);
      if (db.getAutoplay(queue.guild.id) && queue.repeatMode !== QueueRepeatMode.AUTOPLAY) queue.setRepeatMode(QueueRepeatMode.AUTOPLAY);
    }
    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setAuthor({ name: 'Now playing' })
      .setTitle(track.title)
      .setURL(track.url)
      .setDescription(`by **${track.author}**\n\`${track.duration}\``)
      .setFooter({ text: track.requestedBy ? `Requested by ${track.requestedBy.username}` : (queue.repeatMode === QueueRepeatMode.AUTOPLAY ? 'Autoplay' : 'Music') });
    if (track.thumbnail) embed.setThumbnail(track.thumbnail);
    say(queue, { embeds: [embed] });
  });

  player.events.on('audioTrackAdd', (queue, track) => {
    // Only announce when something is already playing (otherwise playerStart covers it).
    if (queue.isPlaying() && queue.tracks.size > 0) {
      say(queue, { content: `➕ Queued **${track.title}** — position ${queue.tracks.size}` });
    }
  });

  player.events.on('audioTracksAdd', (queue, tracks) => {
    say(queue, { content: `➕ Queued **${tracks.length}** tracks.` });
  });

  player.events.on('emptyQueue', (queue) => {
    say(queue, { content: '✅ Queue finished. Add more with `/play`.' });
  });

  player.events.on('emptyChannel', (queue) => {
    say(queue, { content: '👋 Everyone left, so I left too.' });
  });

  player.events.on('playerSkip', (queue, track, reason, description) => {
    console.error(`[music] playerSkip: "${track?.title}" reason=${reason} ${description || ''}`);
  });

  player.events.on('playerError', (queue, error, track) => {
    console.error('[music] playerError:', error);
    say(queue, { content: `⚠️ Couldn't play **${track?.title || 'that track'}** — skipping.` });
  });

  player.events.on('error', (queue, error) => {
    console.error('[music] queue error:', error);
  });

  // Diagnostics: shows why a track ends instantly (ffmpeg / stream / voice problems).
  if (process.env.MUSIC_DEBUG === 'true') {
    player.events.on('debug', (queue, msg) => console.log('[music][debug]', msg));
    player.on('debug', (msg) => console.log('[music][player-debug]', msg));
  }
  player.events.on('playerFinish', (queue, track) => {
    console.log(`[music] playerFinish: "${track?.title}" source=${track?.source} extractor=${track?.extractor?.identifier || 'n/a'} url=${track?.url}`);
  });

  return player;
}

module.exports = { registerMusic, nodeOptions, join247, COLOR, hlsToStream };
      
