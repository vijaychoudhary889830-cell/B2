// Run ONCE:  node scripts/uploadToggleEmojis.js
// Uploads the 4 toggle tiles as *application emojis* (work in every server)
// and saves their ids to Engine/toggleEmojis.json. Then restart the bot.
try { require('dotenv').config(); } catch { /* Replit secrets are already in process.env */ }
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');

const FILES = {
  xRed: 'tg_x_red', xGray: 'tg_x_gray',
  checkGreen: 'tg_check_green', checkGray: 'tg_check_gray',
};

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', async () => {
  try {
    const existing = await client.application.emojis.fetch();
    const out = {};
    for (const [key, name] of Object.entries(FILES)) {
      let emoji = existing.find(e => e.name === name);
      if (!emoji) {
        const file = path.join(__dirname, 'toggle-emojis', `${name}.png`);
        emoji = await client.application.emojis.create({ attachment: file, name });
      }
      out[key] = `<:${emoji.name}:${emoji.id}>`;
      console.log('✔', key, out[key]);
    }
    fs.writeFileSync(path.join(__dirname, '..', 'Engine', 'toggleEmojis.json'), JSON.stringify(out, null, 2));
    console.log('Saved Engine/toggleEmojis.json — restart the bot.');
  } catch (e) { console.error('Failed:', e.message); }
  process.exit(0);
});
client.login(process.env.DISCORD_TOKEN);
