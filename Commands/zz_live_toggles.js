// Loads last among Commands/*.js. It attaches the live switch panels (Engine/toggles.js) to the bot
// when client.login() runs, so it works no matter how index.js is written.
// It registers NO slash command of its own.
const { Client } = require('discord.js');

function attach(client) {
  try {
    require('../Engine/toggles').registerToggles(client);
    console.log('[toggles] live switch panels attached');
  } catch (err) {
    console.error('[toggles] could not attach live switch panels:', err);
  }
}

if (!Client.prototype._liveLoginPatched) {
  const login = Client.prototype.login;
  Client.prototype.login = function (...args) {
    attach(this);
    return login.apply(this, args);
  };
  Client.prototype._liveLoginPatched = true;
}

module.exports = { commands: [], execute: async () => {} };
