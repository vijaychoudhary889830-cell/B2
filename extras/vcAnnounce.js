// VC Announcer - drop-in module for discord.js v14
// Usage in your main file (after creating `client`):
//   require('./extras/vcAnnounce')(client);
// Client needs intents: Guilds, GuildVoiceStates, GuildMessages, MessageContent
// Packages: @discordjs/voice google-tts-api ffmpeg-static libsodium-wrappers opusscript

const fs = require('fs');
const path = require('path');
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, VoiceConnectionStatus, entersState, getVoiceConnection,
} = require('@discordjs/voice');
const googleTTS = require('google-tts-api');

const PREFIX = '!';
const CMD = 'vcannounce';
const DATA_FILE = path.join(__dirname, 'vcAnnounce-data.json');

const DEFAULTS = {
  enabled: true,
  lang: 'en',
  joinMsg: '{user} joined the channel',
  leaveMsg: '{user} left the channel',
  announceLeave: false,
  slow: false,
  ignored: [], // voice channel IDs that are never announced
  home: null, // voice channel the bot stays in (set with summon)
};

module.exports = function setupVcAnnounce(client) {
  // ---------- Saved settings (survive restarts) ----------
  let data = {};
  try { data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { data = {}; }

  const save = () => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }
    catch (e) { console.error('VC announce save error:', e.message); }
  };
  const cfg = (guildId) => {
    if (!data[guildId]) data[guildId] = {};
    return Object.assign({ ...DEFAULTS, ignored: [] }, data[guildId]);
  };
  const setCfg = (guildId, patch) => {
    data[guildId] = { ...cfg(guildId), ...patch };
    save();
  };

  // ---------- Audio queue (per server) ----------
  const guilds = new Map();
  const getState = (id) => {
    if (!guilds.has(id)) guilds.set(id, { queue: [], playing: false, player: createAudioPlayer() });
    return guilds.get(id);
  };

  async function connect(channel) {
    let conn = getVoiceConnection(channel.guild.id);
    if (!conn || conn.joinConfig.channelId !== channel.id) {
      conn?.destroy();
      conn = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: true,
      });
    }
    await entersState(conn, VoiceConnectionStatus.Ready, 15_000);
    return conn;
  }

  function leaveIfEmpty(guild) {
    const conn = getVoiceConnection(guild.id);
    if (!conn || cfg(guild.id).home) return; // never auto-leave a home channel
    const ch = guild.channels.cache.get(conn.joinConfig.channelId);
    if (ch && ch.members.filter((m) => !m.user.bot).size === 0) {
      getState(guild.id).queue.length = 0;
      conn.destroy();
    }
  }

  async function playNext(guild) {
    const state = getState(guild.id);
    if (state.playing) return;
    const job = state.queue.shift();
    if (!job) { leaveIfEmpty(guild); return; }
    state.playing = true;
    try {
      const conn = await connect(job.channel);
      conn.subscribe(state.player);
      const url = googleTTS.getAudioUrl(job.text.slice(0, 190), { lang: job.lang, slow: job.slow });
      state.player.play(createAudioResource(url));
      await entersState(state.player, AudioPlayerStatus.Playing, 10_000);
      await entersState(state.player, AudioPlayerStatus.Idle, 30_000);
    } catch (err) {
      console.error('VC announce error:', err.message);
    }
    state.playing = false;
    playNext(guild);
  }

  function speak(channel, text, settings) {
    getState(channel.guild.id).queue.push({
      channel, text, lang: settings.lang, slow: settings.slow,
    });
    playNext(channel.guild);
  }

  const cleanName = (s) => s.replace(/[^\p{L}\p{N} ]/gu, '').trim().slice(0, 40) || 'Someone';
  const fill = (tpl, member, channel) =>
    tpl.replace(/\{user\}/gi, cleanName(member.displayName)).replace(/\{channel\}/gi, cleanName(channel.name));

  // ---------- Voice events ----------
  async function joinHome(guild) {
    const home = cfg(guild.id).home;
    const ch = home && guild.channels.cache.get(home);
    if (!ch) return;
    try { await connect(ch); } catch (e) { console.error('VC home join error:', e.message); }
  }

  const rejoinAll = () => client.guilds.cache.forEach((g) => joinHome(g));
  if (client.isReady()) rejoinAll(); else client.once('clientReady', rejoinAll);

  client.on('voiceStateUpdate', (oldState, newState) => {
    const member = newState.member || oldState.member;
    const guild = newState.guild;
    const s = cfg(guild.id);

    // If the bot got kicked/disconnected from its home channel, go back
    if (member && member.id === client.user.id) {
      if (s.home && !newState.channelId) setTimeout(() => joinHome(guild), 3000);
      return;
    }
    if (!member || member.user.bot) return;

    if (s.enabled) {
      // Joined or switched into a channel (with a home set, only the home channel)
      if (newState.channelId && oldState.channelId !== newState.channelId
          && (!s.home || newState.channelId === s.home)
          && !s.ignored.includes(newState.channelId)) {
        speak(newState.channel, fill(s.joinMsg, member, newState.channel), s);
      }
      // Left (only if the bot is in that channel and humans remain)
      else if (s.announceLeave && oldState.channelId && oldState.channelId !== newState.channelId
          && !s.ignored.includes(oldState.channelId)) {
        const conn = getVoiceConnection(guild.id);
        const ch = oldState.channel;
        if (conn && ch && conn.joinConfig.channelId === ch.id
            && ch.members.filter((m) => !m.user.bot).size > 0) {
          speak(ch, fill(s.leaveMsg, member, ch), s);
        }
      }
    }

    // Bot leaves once nobody is left (waits for queued speech to finish)
    const st = getState(guild.id);
    if (!st.playing && st.queue.length === 0) leaveIfEmpty(guild);
  });

  // ---------- Commands ----------
  const HELP = [
    '**🔊 VC Announcer commands**',
    `\`${PREFIX}${CMD} on\` / \`off\` - turn announcements on or off`,
    `\`${PREFIX}${CMD} status\` - show current settings`,
    `\`${PREFIX}${CMD} join <text>\` - set join message (use {user} and {channel})`,
    `\`${PREFIX}${CMD} leavemsg <text>\` - set leave message`,
    `\`${PREFIX}${CMD} leave on\` / \`off\` - announce when people leave`,
    `\`${PREFIX}${CMD} lang <code>\` - voice language (en, hi, es, fr, de, ja...)`,
    `\`${PREFIX}${CMD} slow on\` / \`off\` - slower speech`,
    `\`${PREFIX}${CMD} ignore\` - ignore/unignore the voice channel you are in`,
    `\`${PREFIX}${CMD} test\` - play a test announcement in your voice channel`,
    `\`${PREFIX}${CMD} summon\` - bot joins your voice channel, stays, and welcomes everyone who joins`,
    `\`${PREFIX}${CMD} unsummon\` - bot leaves and goes back to auto mode`,
    `\`${PREFIX}${CMD} disconnect\` - make the bot leave voice`,
    `\`${PREFIX}${CMD} reset\` - reset all settings`,
    '*Settings commands need the Manage Server permission.*',
  ].join('\n');

  client.on('messageCreate', async (msg) => {
    if (msg.author.bot || !msg.guild) return;
    if (!msg.content.toLowerCase().startsWith(`${PREFIX}${CMD}`)) return;

    const args = msg.content.slice(PREFIX.length + CMD.length).trim().split(/\s+/).filter(Boolean);
    const sub = (args.shift() || 'help').toLowerCase();
    const rest = args.join(' ');
    const gid = msg.guild.id;
    const s = cfg(gid);
    const isAdmin = msg.member.permissions.has('ManageGuild');
    const onOff = (v) => (v === 'on' ? true : v === 'off' ? false : null);

    if (sub === 'help') return msg.reply(HELP);

    if (sub === 'status') {
      const ig = s.ignored.length ? s.ignored.map((id) => `<#${id}>`).join(', ') : 'none';
      return msg.reply([
        '**🔊 VC Announcer settings**',
        `Status: ${s.enabled ? '✅ on' : '❌ off'}`,
        `Home channel: ${s.home ? `<#${s.home}>` : 'none (auto mode)'}`,
        `Language: \`${s.lang}\` | Slow: ${s.slow ? 'yes' : 'no'}`,
        `Join message: \`${s.joinMsg}\``,
        `Leave announcements: ${s.announceLeave ? 'on' : 'off'} (\`${s.leaveMsg}\`)`,
        `Ignored channels: ${ig}`,
      ].join('\n'));
    }

    if (!isAdmin && sub !== 'test') return msg.reply('You need the **Manage Server** permission for that.');

    switch (sub) {
      case 'on':
      case 'off':
        setCfg(gid, { enabled: sub === 'on' });
        return msg.reply(sub === 'on' ? '🔊 VC announcements turned **on**.' : '🔇 VC announcements turned **off**.');

      case 'join':
        if (!rest) return msg.reply('Give me a message, e.g. `' + `${PREFIX}${CMD} join Welcome {user}!` + '`');
        setCfg(gid, { joinMsg: rest.slice(0, 150) });
        return msg.reply(`✅ Join message set to: \`${rest.slice(0, 150)}\``);

      case 'leavemsg':
        if (!rest) return msg.reply('Give me a message, e.g. `' + `${PREFIX}${CMD} leavemsg Bye {user}!` + '`');
        setCfg(gid, { leaveMsg: rest.slice(0, 150) });
        return msg.reply(`✅ Leave message set to: \`${rest.slice(0, 150)}\``);

      case 'leave': {
        const v = onOff((args[0] || '').toLowerCase());
        if (v === null) return msg.reply(`Use \`${PREFIX}${CMD} leave on\` or \`off\`.`);
        setCfg(gid, { announceLeave: v });
        return msg.reply(`✅ Leave announcements turned **${v ? 'on' : 'off'}**.`);
      }

      case 'lang': {
        const code = (args[0] || '').toLowerCase();
        if (!/^[a-z]{2}(-[a-z]{2})?$/.test(code)) return msg.reply('Give a language code like `en`, `hi`, `es`, `fr`, `de`, `ja`.');
        setCfg(gid, { lang: code });
        return msg.reply(`✅ Language set to \`${code}\`.`);
      }

      case 'slow': {
        const v = onOff((args[0] || '').toLowerCase());
        if (v === null) return msg.reply(`Use \`${PREFIX}${CMD} slow on\` or \`off\`.`);
        setCfg(gid, { slow: v });
        return msg.reply(`✅ Slow speech **${v ? 'on' : 'off'}**.`);
      }

      case 'ignore': {
        const vc = msg.member.voice.channel;
        if (!vc) return msg.reply('Join the voice channel you want to ignore first.');
        const ignored = s.ignored.includes(vc.id) ? s.ignored.filter((i) => i !== vc.id) : [...s.ignored, vc.id];
        setCfg(gid, { ignored });
        return msg.reply(ignored.includes(vc.id) ? `🔕 **${vc.name}** will no longer be announced.` : `🔔 **${vc.name}** will be announced again.`);
      }

      case 'test': {
        const vc = msg.member.voice.channel;
        if (!vc) return msg.reply('Join a voice channel first.');
        speak(vc, fill(s.joinMsg, msg.member, vc), s);
        return msg.reply('🔊 Playing a test announcement...');
      }

      case 'summon': {
        const vc = msg.member.voice.channel;
        if (!vc) return msg.reply('Join the voice channel you want me in first.');
        const me = msg.guild.members.me;
        const perms = vc.permissionsFor(me);
        if (!perms.has('Connect') || !perms.has('Speak'))
          return msg.reply('I need **Connect** and **Speak** permission in that channel.');
        setCfg(gid, { home: vc.id, enabled: true });
        try {
          await connect(vc);
        } catch {
          return msg.reply('I could not join that channel, try again.');
        }
        return msg.reply(`✅ Joined **${vc.name}**. I'll stay here and welcome everyone who joins.`);
      }

      case 'unsummon': {
        setCfg(gid, { home: null });
        const conn = getVoiceConnection(gid);
        if (conn) { getState(gid).queue.length = 0; conn.destroy(); }
        return msg.reply('👋 Left the channel. Back to auto mode (I join when someone joins a VC).');
      }

      case 'disconnect': {
        if (s.home) return msg.reply(`I'm set to stay in my home channel. Use \`${PREFIX}${CMD} unsummon\` to make me leave.`);
        const conn = getVoiceConnection(gid);
        if (!conn) return msg.reply('I am not in a voice channel.');
        getState(gid).queue.length = 0;
        conn.destroy();
        return msg.reply('👋 Disconnected.');
      }

      case 'reset':
        delete data[gid];
        save();
        return msg.reply('♻️ All VC announcer settings reset to default.');

      default:
        return msg.reply(HELP);
    }
  });
};
