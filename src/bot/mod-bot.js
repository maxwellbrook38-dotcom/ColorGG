const { Client, GatewayIntentBits, Partials, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const aiEngine = require('./ai-engine');
const ConfigManager = require('../config/config-manager');
const logger = require('../utils/logger');

class ModBot {
  constructor() {
    this.client = null;
    this.isRunning = false;
    this.statusListeners = [];
    this.messageCount = 0;
    this.actionCount = 0;
    this.startTime = null;
    this.pendingBans = new Map(); // Store pending bans so dashboard can see them
  }

  async start(token) {
    if (this.isRunning) {
      throw new Error('Bot is already running');
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildPresences
      ],
      partials: [Partials.Message, Partials.Channel, Partials.GuildMember]
    });

    this._setupEventHandlers();

    try {
      await this.client.login(token);
      this.isRunning = true;
      this.startTime = Date.now();
      logger.botEvent({ event: 'bot_started', details: 'Bot logged in successfully' });
      this._emitStatus('running');
    } catch (error) {
      logger.error({ error: error.message, context: 'Bot login failed', stack: error.stack });
      throw error;
    }
  }

  async stop() {
    if (!this.isRunning || !this.client) return;

    try {
      this.client.destroy();
      this.isRunning = false;
      this.startTime = null;
      logger.botEvent({ event: 'bot_stopped', details: 'Bot shut down gracefully' });
      this._emitStatus('stopped');
    } catch (error) {
      logger.error({ error: error.message, context: 'Bot shutdown failed' });
    }
  }

  _setupEventHandlers() {
    this.client.once('ready', () => {
      console.log(`✅ ColorGG logged in as ${this.client.user.tag}`);
      logger.botEvent({
        event: 'ready',
        details: `Logged in as ${this.client.user.tag}, serving ${this.client.guilds.cache.size} guilds`
      });
      this._emitStatus('ready');

      this.client.user.setPresence({
        status: 'online',
        activities: [{ name: '🛡️ Moderating | ColorGG', type: 3 }]
      });
    });

    this.client.on('messageCreate', async (message) => {
      await this._handleMessage(message);
    });

    this.client.on('guildMemberAdd', async (member) => {
      logger.botEvent({
        event: 'member_join',
        details: `${member.user.tag} joined ${member.guild.name}`
      });
    });

    this.client.on('interactionCreate', async (interaction) => {
      await this._handleInteraction(interaction);
    });

    this.client.on('error', (error) => {
      logger.error({ error: error.message, context: 'Discord client error', stack: error.stack });
    });

    this.client.on('warn', (warning) => {
      logger.botEvent({ event: 'warning', details: warning });
    });
  }

  async _handleMessage(message) {
    // Ignore bots and system messages
    if (message.author.bot || message.system) return;
    if (!message.guild) return;

    this.messageCount++;
    this._emitStatus('message');

    const settings = ConfigManager.getSettings();

    // Check ignored channels
    if (settings.ignoredChannels && settings.ignoredChannels.includes(message.channel.id)) return;

    // Check ignored/trusted roles
    if (settings.ignoredRoles && message.member) {
      const hasIgnoredRole = message.member.roles.cache.some(r => settings.ignoredRoles.includes(r.id));
      if (hasIgnoredRole) return;
    }

    if (settings.trustedRoles && message.member) {
      const hasTrustedRole = message.member.roles.cache.some(r => settings.trustedRoles.includes(r.id));
      if (hasTrustedRole) return;
    }

    // AI analysis
    try {
      const analysis = await aiEngine.analyzeMessage(message);

      if (analysis.flagged && analysis.confidence > 0.7) {
        await this._takeAction(message, analysis);
      }
    } catch (error) {
      logger.error({ error: error.message, context: 'Message handling failed', stack: error.stack });
    }
  }

  async _takeAction(message, analysis) {
    const settings = ConfigManager.getSettings();
    const rules = ConfigManager.getRules();
    let action = analysis.suggestedAction;
    let duration = analysis.suggestedDuration;

    // Get rule config for the primary violation
    const primaryViolation = analysis.violations[0];
    const rule = primaryViolation ? rules.find(r => r.id === primaryViolation) : null;
    if (rule) {
      action = rule.action;
      if (rule.timeoutDuration) duration = rule.timeoutDuration;
    }

    // Warning tracking
    const warningCount = aiEngine.getWarningCount(message.author.id);
    const maxWarnings = settings.warningsBeforeAction || 2;

    // If action is warn and under threshold, just warn
    if (action === 'warn' || (action === 'timeout' && warningCount < maxWarnings)) {
      aiEngine.addWarning(message.author.id);

      if (analysis.replyMessage) {
        try {
          await message.reply({
            content: `⚠️ ${analysis.replyMessage}`,
            allowedMentions: { repliedUser: true }
          });
        } catch (e) {}
      }

      logger.modAction({
        action: 'warn',
        userId: message.author.id,
        username: message.author.tag,
        channelId: message.channel.id,
        channelName: message.channel.name,
        guildId: message.guild.id,
        guildName: message.guild.name,
        messageContent: message.content,
        reason: analysis.reasoning,
        ruleId: primaryViolation,
        severity: rule?.severity || 'low',
        aiConfidence: analysis.confidence
      });

      this.actionCount++;
      this._emitStatus('action');
      return;
    }

    // Delete the offending message
    try {
      await message.delete();
    } catch (e) {
      logger.error({ error: e.message, context: 'Failed to delete message' });
    }

    // Perform action
    switch (action) {
      case 'timeout':
        await this._timeoutUser(message, analysis, duration, rule);
        break;
      case 'kick':
        await this._kickUser(message, analysis, rule);
        break;
      case 'request_ban':
        await this._requestBan(message, analysis, rule);
        break;
      default:
        // Just delete message
        break;
    }

    // DM the user if configured
    if (settings.dmOnAction && action !== 'warn') {
      try {
        const dm = await message.author.createDM();
        const embed = new EmbedBuilder()
          .setTitle('⚠️ Moderation Notice — ColorGG')
          .setColor(action === 'request_ban' ? 0xFF0000 : action === 'kick' ? 0xFF8800 : 0xFFCC00)
          .setDescription(`Action was taken on your message in **${message.guild.name}**.`)
          .addFields(
            { name: 'Action', value: action.replace('_', ' ').toUpperCase(), inline: true },
            { name: 'Reason', value: analysis.reasoning, inline: false }
          )
          .setTimestamp()
          .setFooter({ text: 'ColorGG AI Moderation' });

        if (duration > 0) {
          embed.addFields({ name: 'Duration', value: `${Math.floor(duration / 60)} minutes`, inline: true });
        }

        await dm.send({ embeds: [embed] });
      } catch (e) {
        // Can't DM user, that's okay
      }
    }

    this.actionCount++;
    this._emitStatus('action');
  }

  async _timeoutUser(message, analysis, duration, rule) {
    try {
      const member = message.member || await message.guild.members.fetch(message.author.id);
      await member.timeout(duration * 1000, `[ColorGG] ${analysis.reasoning}`);

      if (analysis.replyMessage) {
        try {
          await message.channel.send({
            content: `🔇 ${message.author.tag} has been timed out. ${analysis.replyMessage}`
          });
        } catch (e) {}
      }

      logger.modAction({
        action: 'timeout',
        userId: message.author.id,
        username: message.author.tag,
        channelId: message.channel.id,
        channelName: message.channel.name,
        guildId: message.guild.id,
        guildName: message.guild.name,
        messageContent: message.content,
        reason: analysis.reasoning,
        ruleId: analysis.violations[0],
        severity: rule?.severity || 'medium',
        aiConfidence: analysis.confidence,
        duration
      });
    } catch (error) {
      logger.error({ error: error.message, context: 'Timeout failed' });
    }
  }

  async _kickUser(message, analysis, rule) {
    try {
      const member = message.member || await message.guild.members.fetch(message.author.id);
      if (member.kickable) {
        await member.kick(`[ColorGG] ${analysis.reasoning}`);

        try {
          await message.channel.send({
            content: `👢 ${message.author.tag} has been kicked. Reason: ${analysis.reasoning}`
          });
        } catch (e) {}

        logger.modAction({
          action: 'kick',
          userId: message.author.id,
          username: message.author.tag,
          channelId: message.channel.id,
          channelName: message.channel.name,
          guildId: message.guild.id,
          guildName: message.guild.name,
          messageContent: message.content,
          reason: analysis.reasoning,
          ruleId: analysis.violations[0],
          severity: rule?.severity || 'high',
          aiConfidence: analysis.confidence
        });
      }
    } catch (error) {
      logger.error({ error: error.message, context: 'Kick failed' });
    }
  }

  async _requestBan(message, analysis, rule) {
    const settings = ConfigManager.getSettings();
    const banRequestUser = settings.banRequestUser || 'devloafyt';
    const guild = message.guild;

    // ── STEP 1: KICK THEM FIRST ──────────────────────────────────
    // For critical violations, kick immediately so they can't do more damage
    let kicked = false;
    try {
      const member = message.member || await guild.members.fetch(message.author.id);
      if (member.kickable) {
        await member.kick(`[ColorGG] Critical violation — ban request pending: ${analysis.reasoning}`);
        kicked = true;
        logger.modAction({
          action: 'kick',
          userId: message.author.id,
          username: message.author.tag,
          channelId: message.channel.id,
          channelName: message.channel.name,
          guildId: guild.id,
          guildName: guild.name,
          messageContent: message.content,
          reason: `[Auto-kick before ban request] ${analysis.reasoning}`,
          ruleId: analysis.violations[0],
          severity: 'critical',
          aiConfidence: analysis.confidence
        });

        try {
          await message.channel.send({
            content: `👢 **${message.author.tag}** has been kicked for a critical violation. A ban request has been sent for review.`
          });
        } catch (e) {}
      } else {
        // Can't kick — at least timeout them
        try {
          await member.timeout(7 * 24 * 60 * 60 * 1000, `[ColorGG] Pending ban review: ${analysis.reasoning}`);
        } catch (e) {}
      }
    } catch (e) {
      logger.error({ error: e.message, context: 'Failed to kick user before ban request' });
    }

    // ── STEP 2: FIND DEVLOAFYT ───────────────────────────────────
    try {
      let admin = null;
      let adminUserId = null;

      const matchesName = (m) => {
        const u = m.user || m;
        return (
          u.username?.toLowerCase() === banRequestUser.toLowerCase() ||
          u.displayName?.toLowerCase() === banRequestUser.toLowerCase() ||
          u.globalName?.toLowerCase() === banRequestUser.toLowerCase()
        );
      };

      // Search current guild
      try {
        const guildMembers = await guild.members.fetch();
        admin = guildMembers.find(matchesName);
      } catch (e) {
        logger.error({ error: e.message, context: 'Failed to fetch guild members for ban request' });
      }

      // Search all other guilds
      if (!admin) {
        for (const [, g] of this.client.guilds.cache) {
          if (g.id === guild.id) continue;
          try {
            const members = await g.members.fetch();
            const found = members.find(matchesName);
            if (found) { admin = found; break; }
          } catch (e) { /* skip */ }
        }
      }

      // Search user cache
      if (!admin) {
        const foundUser = this.client.users.cache.find(matchesName);
        if (foundUser) {
          adminUserId = foundUser.id;
          admin = { user: foundUser, id: foundUser.id };
        }
      }

      if (admin) {
        adminUserId = admin.id || admin.user?.id;
      }

      // ── STEP 3: BUILD THE EMBED ─────────────────────────────────
      const embed = new EmbedBuilder()
        .setTitle('🚨 BAN REQUEST — ColorGG')
        .setColor(0xFF0000)
        .setDescription(`**A critical violation was detected. The user has been ${kicked ? 'KICKED' : 'timed out'} and a ban is recommended.**\n\nPlease review and approve or deny.`)
        .addFields(
          { name: '👤 Offender', value: `${message.author.tag}\n\`${message.author.id}\``, inline: true },
          { name: '🏠 Server', value: guild.name, inline: true },
          { name: '📍 Channel', value: `#${message.channel.name}`, inline: true },
          { name: '💬 Message Content', value: `\`\`\`${message.content.substring(0, 900) || 'N/A'}\`\`\``, inline: false },
          { name: '⚠️ Violation', value: analysis.violations.join(', ') || 'Unknown', inline: true },
          { name: '📊 Confidence', value: `**${(analysis.confidence * 100).toFixed(1)}%**`, inline: true },
          { name: '🧠 Reasoning', value: analysis.reasoning, inline: false },
          { name: '⚔️ Action Taken', value: kicked ? 'User was **kicked** from the server' : 'User was **timed out** (7 days)', inline: false }
        )
        .setTimestamp()
        .setFooter({ text: 'ColorGG AI Moderation — Ban Request' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`ban_approve_${message.author.id}_${guild.id}`)
          .setLabel('Approve Ban')
          .setEmoji('✅')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`ban_deny_${message.author.id}_${guild.id}`)
          .setLabel('Deny')
          .setEmoji('❌')
          .setStyle(ButtonStyle.Secondary)
      );

      // ── STEP 4: DELIVER BAN REQUEST (multi-fallback) ────────────
      let delivered = false;

      // Attempt 1: DM the admin directly
      if (admin) {
        try {
          const userObj = admin.user || admin;
          const dm = await userObj.createDM();
          await dm.send({ embeds: [embed], components: [row] });
          delivered = true;
          logger.botEvent({ event: 'ban_request_dm_sent', details: `Ban request DM sent to ${banRequestUser} for ${message.author.tag}` });
        } catch (e) {
          logger.botEvent({ event: 'ban_request_dm_failed', details: `Could not DM ${banRequestUser}: ${e.message} — trying channel fallbacks` });
        }
      }

      // Attempt 2: Find a mod/admin/log channel in the guild
      if (!delivered) {
        const modChannelNames = ['mod-log', 'mod-logs', 'modlog', 'modlogs', 'admin', 'admin-log', 'admin-logs', 'staff', 'staff-chat', 'moderator', 'mod-chat', 'ban-requests', 'log', 'logs', 'bot-logs'];
        const textChannels = guild.channels.cache.filter(c => c.isTextBased() && !c.isVoiceBased());

        let modChannel = null;
        for (const name of modChannelNames) {
          modChannel = textChannels.find(c => c.name.toLowerCase() === name);
          if (modChannel) break;
        }

        if (modChannel) {
          try {
            await modChannel.send({
              content: adminUserId ? `<@${adminUserId}> — **Ban request requires your attention:**` : '⚠️ **Ban request for admin review:**',
              embeds: [embed],
              components: [row]
            });
            delivered = true;
            logger.botEvent({ event: 'ban_request_channel', details: `Ban request sent to #${modChannel.name} (DM failed/unavailable)` });
          } catch (e) { /* no perms, try next */ }
        }
      }

      // Attempt 3: Send in the channel where the violation happened
      if (!delivered) {
        try {
          await message.channel.send({
            content: adminUserId ? `<@${adminUserId}> — **Ban request pending your review:**` : '⚠️ **Ban request for admin review:**',
            embeds: [embed],
            components: [row]
          });
          delivered = true;
          logger.botEvent({ event: 'ban_request_violation_channel', details: `Ban request sent to #${message.channel.name} as fallback` });
        } catch (e) {
          logger.error({ error: e.message, context: 'Failed to send ban request in violation channel' });
        }
      }

      // Attempt 4: Try the first text channel we have permission to send in
      if (!delivered) {
        const anyChannel = guild.channels.cache.find(c => c.isTextBased() && !c.isVoiceBased() && c.permissionsFor(guild.members.me)?.has('SendMessages'));
        if (anyChannel) {
          try {
            await anyChannel.send({
              content: '⚠️ **Ban request — all other delivery methods failed:**',
              embeds: [embed],
              components: [row]
            });
            delivered = true;
          } catch (e) {}
        }
      }

      // Store as pending ban in memory (dashboard can show these)
      this.pendingBans.set(`${message.author.id}_${guild.id}`, {
        userId: message.author.id,
        username: message.author.tag,
        guildId: guild.id,
        guildName: guild.name,
        reason: analysis.reasoning,
        violations: analysis.violations,
        confidence: analysis.confidence,
        kicked,
        delivered,
        timestamp: new Date().toISOString()
      });

      if (!delivered) {
        logger.error({ error: `All delivery methods failed for ban request (user: ${message.author.tag})`, context: 'Ban request delivery exhausted' });
      }

      logger.modAction({
        action: 'request_ban',
        userId: message.author.id,
        username: message.author.tag,
        channelId: message.channel.id,
        channelName: message.channel.name,
        guildId: guild.id,
        guildName: guild.name,
        messageContent: message.content,
        reason: analysis.reasoning,
        ruleId: analysis.violations[0],
        severity: 'critical',
        aiConfidence: analysis.confidence
      });
    } catch (error) {
      logger.error({ error: error.message, context: 'Ban request failed', stack: error.stack });
    }
  }

  async _handleInteraction(interaction) {
    if (!interaction.isButton()) return;

    const [action, type, userId, guildId] = interaction.customId.split('_');
    if (action !== 'ban') return;

    if (type === 'approve') {
      try {
        const guild = this.client.guilds.cache.get(guildId) || await this.client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member && member.bannable) {
          await member.ban({ reason: '[ColorGG] Ban approved by admin' });
          await interaction.update({
            content: `✅ **Ban approved** — ${member.user.tag} has been banned.`,
            embeds: [],
            components: []
          });
          logger.modAction({
            action: 'ban',
            userId,
            username: member.user.tag,
            guildId,
            guildName: guild.name,
            reason: 'Ban approved by admin',
            severity: 'critical'
          });
        } else {
          // User was kicked and left — try banning by ID
          try {
            await guild.bans.create(userId, { reason: '[ColorGG] Ban approved by admin (user already left)' });
            await interaction.update({
              content: `✅ **Ban approved** — User ID ${userId} has been banned (they were already kicked/left).`,
              embeds: [],
              components: []
            });
            logger.modAction({
              action: 'ban',
              userId,
              username: 'Unknown (left server)',
              guildId,
              guildName: guild.name,
              reason: 'Ban approved by admin (user already left)',
              severity: 'critical'
            });
          } catch (banErr) {
            await interaction.update({
              content: `⚠️ Could not ban user — they may have already left and I lack ban permissions. Error: ${banErr.message}`,
              embeds: [],
              components: []
            });
          }
        }
        this.pendingBans.delete(`${userId}_${guildId}`);
      } catch (error) {
        await interaction.update({
          content: `❌ Ban failed: ${error.message}`,
          embeds: [],
          components: []
        });
      }
    } else if (type === 'deny') {
      try {
        const guild = this.client.guilds.cache.get(guildId) || await this.client.guilds.fetch(guildId);
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member) {
          await member.timeout(null, '[ColorGG] Ban request denied by admin');
        }
        await interaction.update({
          content: '❌ **Ban denied** — User timeout has been removed.',
          embeds: [],
          components: []
        });
        this.pendingBans.delete(`${userId}_${guildId}`);
      } catch (error) {
        await interaction.update({
          content: `Ban denied, but could not remove timeout: ${error.message}`,
          embeds: [],
          components: []
        });
      }
    }
  }

  getStatus() {
    return {
      running: this.isRunning,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      username: this.client?.user?.tag || null,
      avatar: this.client?.user?.displayAvatarURL() || null,
      guilds: this.client?.guilds?.cache?.size || 0,
      members: this.client?.guilds?.cache?.reduce((a, g) => a + g.memberCount, 0) || 0,
      messageCount: this.messageCount,
      actionCount: this.actionCount,
      pendingBans: Array.from(this.pendingBans.values()),
      guildList: this.client?.guilds?.cache?.map(g => ({
        id: g.id,
        name: g.name,
        memberCount: g.memberCount,
        icon: g.iconURL()
      })) || []
    };
  }

  onStatus(fn) {
    this.statusListeners.push(fn);
    return () => {
      this.statusListeners = this.statusListeners.filter(l => l !== fn);
    };
  }

  _emitStatus(event) {
    const status = { ...this.getStatus(), event };
    this.statusListeners.forEach(fn => {
      try { fn(status); } catch (e) {}
    });
  }
}

module.exports = new ModBot();
