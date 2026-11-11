const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ComponentType } = require('discord.js');
const { useMainPlayer, useQueue, QueueRepeatMode, QueryType } = require('discord-player');
const db = require('../database');
const spotify = require('../Engine/spotify');
const { findBestTrack } = require('../Engine/matcher');
const { requireAuthorized } = require('../Engine/checks');
const { COLOR, nodeOptions, join247 } = require('../Engine/music');

const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Play a song or playlist (name, YouTube/Spotify/SoundCloud link)')
    .addStringOption(o => o.setName('query').setDescription('Song name or link').setRequired(true)),
  new SlashCommandBuilder().setName('search').setDescription('Search for a song and pick the right result')
    .addStringOption(o => o.setName('query').setDescription('Song name and artist').setRequired(true)),
  new SlashCommandBuilder().setName('247').setDescription('Keep the bot in a voice channel 24/7 (admins only)')
    .addStringOption(o => o.setName('mode').setDescription('On or off').setRequired(true)
      .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' }))
    .addChannelOption(o => o.setName('channel').setDescription('Voice channel to stay in (default: the one you\'re in)').addChannelTypes(2, 13)),
  new SlashCommandBuilder().setName('pause').setDescription('Pause the music'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume the music'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop the music, clear the queue and leave'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the queue')
    .addIntegerOption(o => o.setName('page').setDescription('Page number').setMinValue(1)),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current song with a progress bar'),
  new SlashCommandBuilder().setName('volume').setDescription('Set the volume (1-100)')
    .addIntegerOption(o => o.setName('level').setDescription('Volume 1-100').setMinValue(1).setMaxValue(100).setRequired(true)),
  new SlashCommandBuilder().setName('loop').setDescription('Set loop mode')
    .addStringOption(o => o.setName('mode').setDescription('Loop mode').setRequired(true)
      .addChoices({ name: 'Off', value: 'off' }, { name: 'Current track', value: 'track' }, { name: 'Whole queue', value: 'queue' }, { name: 'Autoplay (related songs)', value: 'autoplay' })),
  new SlashCommandBuilder().setName('autoplay').setDescription('Keep playing related songs when the queue ends (admins change it)')
    .addStringOption(o => o.setName('mode').setDescription('On or off (leave empty to see the current setting)')
      .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' })),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queue'),
  new SlashCommandBuilder().setName('remove').setDescription('Remove a song from the queue')
    .addIntegerOption(o => o.setName('position').setDescription('Position in /queue').setMinValue(1).setRequired(true)),
];

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms)),
]);

// Tries each search engine in turn (25s cap each). Returns the loaded track or null.
async function startPlayback(interaction, voice, query, engines) {
  const player = useMainPlayer();
  for (const engine of engines) {
    try {
      const { track } = await withTimeout(player.play(voice, query, {
        requestedBy: interaction.user,
        nodeOptions: nodeOptions(interaction.guild.id, { channel: interaction.channel }),
        ...(engine ? { searchEngine: engine } : {}),
      }), 25_000, 'play');
      return track;
    } catch (err) {
      console.error(`[music] play attempt failed (${engine || 'auto'}):`, err.message);
    }
  }
  console.error('[music] play failed. Extractors loaded:', [...player.extractors.store.keys()].join(', ') || 'none');
  return null;
}

const isUrl = (s) => /^https?:\/\//i.test(s.trim());
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const reply = (i, content, ephemeral = true) => i.reply({ content, ephemeral });

async function execute(interaction) {
  if (!interaction.guild) return reply(interaction, '❌ Use this in a server.');

  const name = interaction.commandName;

  if (name === '247') {
    if (!(await requireAuthorized(interaction))) return;
    const mode = interaction.options.getString('mode', true);
    if (mode === 'off') {
      db.setMusic247(interaction.guild.id, { enabled: false });
      return reply(interaction, '✅ 24/7 mode is **off**. I\'ll leave when the channel is empty or the queue ends.');
    }
    const target = interaction.options.getChannel('channel') || interaction.member?.voice?.channel;
    if (!target) return reply(interaction, '❌ Join a voice channel or pick one with the `channel` option.');
    const perms = target.permissionsFor(interaction.guild.members.me);
    if (!perms?.has(['Connect', 'Speak'])) return reply(interaction, '❌ I need **Connect** and **Speak** in that channel.');

    await interaction.deferReply({ ephemeral: true });
    db.setMusic247(interaction.guild.id, { enabled: true, voiceChannelId: target.id, textChannelId: interaction.channel.id });
    try {
      const player = useMainPlayer();
      // If a queue already exists, turn off its auto-leave settings too.
      const existing = player.nodes.get(interaction.guild.id);
      if (existing) {
        existing.options.leaveOnEmpty = false;
        existing.options.leaveOnEnd = false;
        existing.options.leaveOnStop = false;
      }
      await join247(interaction.client, player, interaction.guild.id);
      return interaction.editReply(`✅ 24/7 mode is **on**. I'll stay in ${target} and rejoin after restarts. Use \`/play\` any time.`);
    } catch (err) {
      console.error('[music] 24/7 join error:', err);
      return interaction.editReply('⚠️ Saved 24/7 mode, but I couldn\'t join right now. I\'ll keep retrying on restart.');
    }
  }
  if (name === 'autoplay') {
    const mode = interaction.options.getString('mode');
    const gid = interaction.guild.id;
    if (!mode) {
      return reply(interaction, db.getAutoplay(gid)
        ? '🔁 Autoplay is **on**. When the queue ends I keep playing related songs. Turn it off with `/autoplay off`.'
        : '⏹️ Autoplay is **off**. Turn it on with `/autoplay on`.');
    }
    if (mode !== 'on' && mode !== 'off') return reply(interaction, '❌ Use `autoplay on` or `autoplay off`.');
    if (!(await requireAuthorized(interaction))) return;
    const on = mode === 'on';
    db.setAutoplay(gid, on);
    const queue = useQueue(gid);
    if (queue) queue.setRepeatMode(on ? QueueRepeatMode.AUTOPLAY : QueueRepeatMode.OFF);
    return reply(interaction, on
      ? '🔁 Autoplay is **on**. When the queue ends I\'ll keep playing related songs.'
      : '✅ Autoplay is **off**. I\'ll stop when the queue ends.', false);
  }

  const voice = interaction.member?.voice?.channel;

  // Everything except reading the queue needs the user in the bot's voice channel.
  const readOnly = name === 'queue' || name === 'nowplaying';
  if (!readOnly) {
    if (!voice) return reply(interaction, '❌ Join a voice channel first.');
    const botVc = interaction.guild.members.me?.voice?.channelId;
    if (botVc && botVc !== voice.id) return reply(interaction, '❌ I\'m already playing in another voice channel.');
  }

  if (name === 'play') {
    const player = useMainPlayer();
    const query = interaction.options.getString('query', true);

    const perms = voice.permissionsFor(interaction.guild.members.me);
    if (!perms?.has(['Connect', 'Speak'])) return reply(interaction, '❌ I need **Connect** and **Speak** permissions in that voice channel.');

    await interaction.deferReply();
    // Links go straight through. For plain text we search SoundCloud first
    // (YouTube search is unreliable from hosting servers), then auto as backup.
    let track = null;
    if (!isUrl(query)) {
      // YT_FIRST=true: search YouTube first (official studio tracks). If YouTube cannot stream a
      // track, the engine automatically plays the best SoundCloud match instead.
      if (process.env.YT_FIRST === 'true') {
        try {
          track = await startPlayback(interaction, voice, query, [QueryType.YOUTUBE_SEARCH]);
        } catch (err) {
          console.error('[music] YouTube search failed:', err.message);
        }
      }
      // Otherwise (or if YouTube found nothing): SoundCloud. The name/artist is matched
      // through Spotify (or iTunes if Spotify keys fail), then the audio is found on SoundCloud.
      if (!track) try {
        const best = await withTimeout(findBestTrack(useMainPlayer(), query, interaction.user), 20_000, 'match');
        if (best) track = await startPlayback(interaction, voice, best, [null]);
      } catch (err) {
        console.error('[music] smart match failed:', err.message);
      }
      if (!track) track = await startPlayback(interaction, voice, query, [QueryType.SOUNDCLOUD_SEARCH]);
      // YouTube is only a last resort here (it is blocked from most hosting IPs).
      if (!track && process.env.YT_FIRST !== 'true' && process.env.YT_LAST_RESORT !== 'false') {
        try {
          track = await startPlayback(interaction, voice, query, [QueryType.YOUTUBE_SEARCH]);
        } catch (err) {
          console.error('[music] YouTube search failed:', err.message);
        }
      }
    }
    if (!track && isUrl(query)) track = await startPlayback(interaction, voice, query, [null]);
    if (!track) return interaction.editReply('❌ I couldn\'t find or play that. Try `/search` to pick a result, or use a full song link.');
    return interaction.editReply(`🎶 Loaded **${track.title}**`);
  }

  if (name === 'search') {
    const player = useMainPlayer();
    const query = interaction.options.getString('query', true);
    const perms = voice.permissionsFor(interaction.guild.members.me);
    if (!perms?.has(['Connect', 'Speak'])) return reply(interaction, '❌ I need **Connect** and **Speak** permissions in that voice channel.');

    await interaction.deferReply();

    // Build the list of choices: [{ label, description, query, engines }]
    let choices = [];
    let source = 'SoundCloud';
    try {
      const results = await spotify.searchTracks(query, 5);
      choices = results.map(r => ({
        label: clip(r.title, 100),
        description: clip(`${r.artist} • ${r.duration}`, 100),
        query: `${r.title} ${r.artist}`,
        engines: [QueryType.SOUNDCLOUD_SEARCH, null],
      }));
      source = results.source || 'Spotify';
    } catch (err) {
      console.error('[music] song lookup failed, using SoundCloud:', err.message);
    }
    if (!choices.length) {
      try {
        const res = await withTimeout(player.search(query, { searchEngine: QueryType.SOUNDCLOUD_SEARCH, requestedBy: interaction.user }), 15_000, 'search');
        choices = res.tracks.slice(0, 5).map(t => ({
          label: clip(t.title, 100),
          description: clip(`${t.author} • ${t.duration}`, 100),
          query: t.url,
          engines: [null],
        }));
        source = 'SoundCloud';
      } catch (err) {
        console.error('[music] SoundCloud search failed:', err.message);
      }
    }
    if (!choices.length) return interaction.editReply('❌ No results. Try adding the artist name.');

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`music_search_${interaction.id}`)
      .setPlaceholder('Pick the song to play')
      .addOptions(choices.map((ch, i) => ({ label: ch.label, description: ch.description, value: String(i) })));
    const msg = await interaction.editReply({
      content: `🔎 Results for **${clip(query, 80)}** (${source}) — pick one:`,
      components: [new ActionRowBuilder().addComponents(menu)],
    });

    let picked;
    try {
      picked = await msg.awaitMessageComponent({
        componentType: ComponentType.StringSelect,
        time: 30_000,
        filter: (i) => i.user.id === interaction.user.id && i.customId === menu.data.custom_id,
      });
    } catch {
      return interaction.editReply({ content: '⌛ Search timed out. Run `/search` again.', components: [] });
    }

    const choice = choices[Number(picked.values[0])];
    await picked.update({ content: `⏳ Loading **${choice.label}**…`, components: [] });
    const track = await startPlayback(interaction, voice, choice.query, choice.engines);
    if (!track) return interaction.editReply({ content: '❌ Couldn\'t play that one. Try another result.', components: [] });
    return interaction.editReply({ content: `🎶 Loaded **${track.title}**`, components: [] });
  }

  const queue = useQueue(interaction.guild.id);
  if (!queue || (!queue.isPlaying() && queue.tracks.size === 0 && !queue.currentTrack)) {
    return reply(interaction, '❌ Nothing is playing right now.');
  }

  switch (name) {
    case 'pause':
      queue.node.pause();
      return reply(interaction, '⏸️ Paused.', false);
    case 'resume':
      queue.node.resume();
      return reply(interaction, '▶️ Resumed.', false);
    case 'skip': {
      const title = queue.currentTrack?.title;
      queue.node.skip();
      return reply(interaction, `⏭️ Skipped **${title}**.`, false);
    }
    case 'stop':
      // In 24/7 mode keep the connection and just stop playback.
      if (db.getMusic247(interaction.guild.id).enabled) queue.node.stop();
      else queue.delete();
      return reply(interaction, '⏹️ Stopped and cleared the queue.', false);
    case 'volume': {
      const level = interaction.options.getInteger('level', true);
      queue.node.setVolume(level);
      return reply(interaction, `🔊 Volume set to **${level}%**.`, false);
    }
    case 'loop': {
      const mode = interaction.options.getString('mode', true);
      const map = { off: QueueRepeatMode.OFF, track: QueueRepeatMode.TRACK, queue: QueueRepeatMode.QUEUE, autoplay: QueueRepeatMode.AUTOPLAY };
      queue.setRepeatMode(map[mode]);
      return reply(interaction, `🔁 Loop mode: **${mode}**.`, false);
    }
    case 'shuffle':
      if (queue.tracks.size < 2) return reply(interaction, '❌ Need at least 2 queued songs to shuffle.');
      queue.tracks.shuffle();
      return reply(interaction, '🔀 Queue shuffled.', false);
    case 'remove': {
      const pos = interaction.options.getInteger('position', true);
      if (pos > queue.tracks.size) return reply(interaction, '❌ No song at that position.');
      const removed = queue.removeTrack(pos - 1);
      return reply(interaction, `🗑️ Removed **${removed?.title || 'track'}**.`, false);
    }
    case 'nowplaying': {
      const t = queue.currentTrack;
      if (!t) return reply(interaction, '❌ Nothing is playing right now.');
      const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle(t.title)
        .setURL(t.url)
        .setDescription(`by **${t.author}**\n${queue.node.createProgressBar()}`);
      if (t.thumbnail) embed.setThumbnail(t.thumbnail);
      return interaction.reply({ embeds: [embed] });
    }
    case 'queue': {
      const tracks = queue.tracks.toArray();
      const perPage = 10;
      const pages = Math.max(1, Math.ceil(tracks.length / perPage));
      const page = Math.min(interaction.options.getInteger('page') || 1, pages);
      const slice = tracks.slice((page - 1) * perPage, page * perPage);
      const lines = slice.map((t, i) => `**${(page - 1) * perPage + i + 1}.** ${t.title} — \`${t.duration}\``);
      const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('Queue')
        .setDescription(`**Now:** ${queue.currentTrack?.title || '—'}\n\n${lines.join('\n') || '*Nothing queued.*'}`)
        .setFooter({ text: `Page ${page}/${pages} • ${tracks.length} queued` });
      return interaction.reply({ embeds: [embed] });
    }
  }
}

module.exports = { commands, execute };
