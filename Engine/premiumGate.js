// "Server Premium Required" message, shown when a server without Premium uses a premium-only command.
//
//   const { requirePremium } = require('../Engine/premiumGate');
//   if (!(await requirePremium(interaction))) return;     // <- add this line to ANY command to make it premium-only
//
// Works for slash commands and prefix commands. The Premium / Support buttons use the same
// env links as your website: PREMIUM_CONTACT_URL and SUPPORT_URL (a button is hidden if its link isn't set).
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../database');

const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s || ''));

function premiumRequiredPayload() {
  const premiumUrl = [process.env.PREMIUM_CONTACT_URL, process.env.SUPPORT_URL].find(isUrl);
  const supportUrl = [process.env.SUPPORT_URL, process.env.PREMIUM_CONTACT_URL].find(isUrl);
  const name = premiumUrl ? `[SPIDEY Premium](${premiumUrl})` : '**SPIDEY Premium**';

  const embed = new EmbedBuilder()
    .setColor(0x7c5cff)
    .setTitle('Server Premium Required')
    .setDescription(`This server needs ${name} to use this command.\nAlready subscribed? Use \`/premium redeem\`.`);

  const buttons = [];
  if (premiumUrl) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Premium').setEmoji('⭐').setURL(premiumUrl));
  if (supportUrl) buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Support').setURL(supportUrl));
  return { embeds: [embed], components: buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [] };
}

// true = the server has Premium, carry on. false = the message was sent, stop the command.
async function requirePremium(interaction) {
  if (!interaction.guild) return false;
  if (db.isPremium(interaction.guild.id)) return true;
  const payload = { ...premiumRequiredPayload(), ephemeral: false };
  try {
    if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
    else await interaction.reply(payload);
  } catch (err) { console.error('[premium] could not send the premium-required message:', err.message); }
  return false;
}

module.exports = { requirePremium, premiumRequiredPayload };
