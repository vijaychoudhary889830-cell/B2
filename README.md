# Spidey Bot

A Discord bot with a web dashboard.

**Bot features:** anti-nuke and whitelist, automod, tickets, giveaways, reaction roles, custom prefix, music, and live on/off switch panels.
**Dashboard:** Discord login, per-server module pages, shop/checkout for premium (Cashfree), docs, status and legal pages.

## Setup

1. Install Node 22.12 or newer, plus `ffmpeg` if you use music.
2. `npm install`
3. Copy `.env.example` to `.env` and fill in the values.
4. `npm start` (the dashboard runs on port 3000).

## Project layout

```
index.js          bot + dashboard entry point
database.js       JSON-file storage
Commands/         slash commands (each file is loaded automatically)
Engine/           feature logic (antinuke, automod, music, tickets, payments, ...)
views/            dashboard pages (EJS)
public/           logo and favicon
scripts/          one-time helpers (e.g. upload toggle emojis)
extras/           optional modules that are not loaded by default (voice-channel announcer)
```

## Notes

- Runtime data (`database.json`, `premium-keys.json`, `payments.json`, `giveaways.json`) is created automatically and is git-ignored. Back it up, or set `DATA_DIR` to a persistent volume.
- To refresh the toggle emojis: `node scripts/uploadToggleEmojis.js`, then restart the bot.
- To enable the voice announcer, see the top of `extras/vcAnnounce.js`.
