const axios = require('axios');
const ConfigManager = require('../config/config-manager');
const logger = require('../utils/logger');

class AIEngine {
  constructor() {
    this.apiBase = 'https://text.pollinations.ai';
    this.userWarnings = new Map(); // userId -> warning count
    this.recentMessages = new Map(); // channelId -> last N messages for context
    this.maxContext = 10;
  }

  _buildSystemPrompt(rules) {
    const enabledRules = rules.filter(r => r.enabled);
    const settings = ConfigManager.getSettings();

    return `You are ColorGG, an AI Discord moderator. You are part of the server staff and act like a friendly, fair community member who also happens to moderate.

YOUR PERSONALITY:
- You are calm, reasonable, and fair
- You are NOT overly strict — you understand context, humor, sarcasm, and friendly banter
- You only take action when there is a genuine violation
- You give people the benefit of the doubt
- You act like a normal chill member who keeps the peace
- You are helpful and approachable

MODERATION STYLE: ${settings.moderationStyle || 'balanced'}

YOUR MODERATION RULES (only flag if GENUINELY violated):
${enabledRules.map(r => `- [${r.id}] ${r.name} (severity: ${r.severity}, action: ${r.action}): ${r.aiPrompt}`).join('\n')}

RESPONSE FORMAT — You MUST respond with ONLY valid JSON, no extra text:
{
  "flagged": true/false,
  "violations": ["ruleId1"],
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation",
  "suggestedAction": "none|warn|timeout|kick|request_ban",
  "suggestedDuration": seconds_or_0,
  "replyMessage": "Optional friendly message to send in chat (null if not needed)"
}

IMPORTANT GUIDELINES:
- confidence must be > 0.7 to flag a message
- Normal conversation, jokes, memes, gaming talk = NOT flagged
- Mild profanity in casual conversation = NOT flagged (unless directed as harassment)
- Only flag genuinely harmful, dangerous, or rule-breaking content
- When in doubt, do NOT flag — false positives are worse than false negatives
- If you do flag, provide a clear, concise reasoning
- The replyMessage should be friendly and explain why action was taken, like a real mod would`;
  }

  _trackMessage(channelId, message) {
    if (!this.recentMessages.has(channelId)) {
      this.recentMessages.set(channelId, []);
    }
    const msgs = this.recentMessages.get(channelId);
    msgs.push({
      author: message.author?.username || 'Unknown',
      content: message.content,
      timestamp: Date.now()
    });
    if (msgs.length > this.maxContext) {
      msgs.shift();
    }
  }

  _getChannelContext(channelId) {
    const msgs = this.recentMessages.get(channelId) || [];
    if (msgs.length === 0) return '';
    return '\nRECENT CHAT CONTEXT:\n' + msgs.map(m => `${m.author}: ${m.content}`).join('\n');
  }

  async analyzeMessage(message) {
    const rules = ConfigManager.getRules();
    const enabledRules = rules.filter(r => r.enabled);

    if (enabledRules.length === 0) {
      return { flagged: false, violations: [], confidence: 0, reasoning: 'No rules enabled' };
    }

    this._trackMessage(message.channel?.id || 'unknown', message);

    const systemPrompt = this._buildSystemPrompt(rules);
    const channelContext = this._getChannelContext(message.channel?.id || 'unknown');

    const userPrompt = `Analyze this Discord message for rule violations:

Author: ${message.author?.username || 'Unknown'} (ID: ${message.author?.id || 'unknown'})
Channel: #${message.channel?.name || 'unknown'}
Message: "${message.content}"
${channelContext}

Respond with ONLY the JSON object.`;

    try {
      const response = await axios.post(this.apiBase, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        model: 'openai',
        jsonMode: true,
        seed: Math.floor(Math.random() * 100000)
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ConfigManager.getPollinationsKey()}`
        },
        timeout: 30000
      });

      let result;
      const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

      // Extract JSON from response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in AI response');
      }

      // Validate and normalize
      result.flagged = result.flagged === true && (result.confidence || 0) > 0.7;
      result.violations = Array.isArray(result.violations) ? result.violations : [];
      result.confidence = typeof result.confidence === 'number' ? result.confidence : 0;
      result.reasoning = result.reasoning || 'No reasoning provided';
      result.suggestedAction = result.suggestedAction || 'none';
      result.suggestedDuration = result.suggestedDuration || 0;

      // Log analysis
      logger.aiAnalysis({
        userId: message.author?.id,
        username: message.author?.username,
        channelId: message.channel?.id,
        channelName: message.channel?.name,
        messageContent: message.content,
        flagged: result.flagged,
        violations: result.violations,
        confidence: result.confidence,
        reasoning: result.reasoning
      });

      return result;
    } catch (error) {
      logger.error({
        error: error.message,
        context: 'AI analysis failed',
        stack: error.stack
      });

      return {
        flagged: false,
        violations: [],
        confidence: 0,
        reasoning: `AI analysis failed: ${error.message}`,
        suggestedAction: 'none',
        suggestedDuration: 0,
        replyMessage: null
      };
    }
  }

  getWarningCount(userId) {
    return this.userWarnings.get(userId) || 0;
  }

  addWarning(userId) {
    const count = this.getWarningCount(userId) + 1;
    this.userWarnings.set(userId, count);
    return count;
  }

  resetWarnings(userId) {
    this.userWarnings.delete(userId);
  }

  async generateReply(context, prompt) {
    try {
      const response = await axios.post(this.apiBase, {
        messages: [
          {
            role: 'system',
            content: 'You are ColorGG, a friendly Discord moderator bot. Respond naturally and helpfully. Keep responses concise and casual.'
          },
          { role: 'user', content: `Context: ${context}\n\nRespond to: ${prompt}` }
        ],
        model: 'openai',
        seed: Math.floor(Math.random() * 100000)
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ConfigManager.getPollinationsKey()}`
        },
        timeout: 30000
      });

      return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    } catch (error) {
      logger.error({ error: error.message, context: 'AI reply generation failed' });
      return null;
    }
  }

  /**
   * Summarize an array of Discord messages using AI
   */
  async summarizeChat(messages, channelName, guildName) {
    const formatted = messages.map(m => `[${m.author?.tag || m.author?.username || 'Unknown'}] ${m.content}`).join('\n');

    try {
      const response = await axios.post(this.apiBase, {
        messages: [
          {
            role: 'system',
            content: `You are ColorGG, an AI Discord moderator. Summarize the following chat conversation from #${channelName} in ${guildName}. Provide:
1. **Overview** — A 2-3 sentence summary of what was discussed
2. **Key Topics** — Bullet list of main topics/themes
3. **Notable Users** — Who was most active and what they talked about
4. **Mood/Tone** — Overall vibe of the conversation
5. **Moderation Notes** — Any concerning patterns or potential issues (or "None" if clean)

Keep it concise and useful for a moderator reviewing the chat.`
          },
          { role: 'user', content: `Summarize this chat (${messages.length} messages from #${channelName}):\n\n${formatted}` }
        ],
        model: 'openai',
        seed: Math.floor(Math.random() * 100000)
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ConfigManager.getPollinationsKey()}`
        },
        timeout: 45000
      });

      const summary = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      return {
        summary,
        channelName,
        guildName,
        messageCount: messages.length,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error({ error: error.message, context: 'AI chat summary failed' });
      return { summary: `Summary failed: ${error.message}`, channelName, guildName, messageCount: messages.length, timestamp: new Date().toISOString() };
    }
  }

  /**
   * Analyze messages for AI purge — returns which messages violate rules
   */
  async analyzeForPurge(messages, channelName) {
    const rules = ConfigManager.getRules();
    const enabledRules = rules.filter(r => r.enabled);
    const formatted = messages.map((m, i) => `[${i}] ${m.author?.tag || 'Unknown'}: ${m.content}`).join('\n');

    try {
      const response = await axios.post(this.apiBase, {
        messages: [
          {
            role: 'system',
            content: `You are ColorGG, an AI moderator. Analyze these messages and identify which ones violate the rules. Be fair — only flag genuinely bad messages.

RULES:
${enabledRules.map(r => `- [${r.id}] ${r.name}: ${r.aiPrompt}`).join('\n')}

Respond with ONLY valid JSON:
{
  "flaggedIndexes": [0, 3, 7],
  "reasons": { "0": "reason", "3": "reason", "7": "reason" },
  "totalFlagged": 3,
  "summary": "Brief overview of what was found"
}`
          },
          { role: 'user', content: `Analyze these ${messages.length} messages from #${channelName}:\n\n${formatted}` }
        ],
        model: 'openai',
        jsonMode: true,
        seed: Math.floor(Math.random() * 100000)
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ConfigManager.getPollinationsKey()}`
        },
        timeout: 45000
      });

      const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      return { flaggedIndexes: [], reasons: {}, totalFlagged: 0, summary: 'Could not parse AI response' };
    } catch (error) {
      logger.error({ error: error.message, context: 'AI purge analysis failed' });
      return { flaggedIndexes: [], reasons: {}, totalFlagged: 0, summary: `Analysis failed: ${error.message}` };
    }
  }
}

module.exports = new AIEngine();
