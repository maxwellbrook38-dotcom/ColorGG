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
        timeout: 15000
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
        timeout: 15000
      });

      return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    } catch (error) {
      logger.error({ error: error.message, context: 'AI reply generation failed' });
      return null;
    }
  }
}

module.exports = new AIEngine();
