const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');

if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

class Logger {
  constructor() {
    this.logs = [];
    this.maxMemoryLogs = 5000;
    this.listeners = [];
  }

  _getLogFile() {
    const date = new Date().toISOString().split('T')[0];
    return path.join(LOG_DIR, `modlog-${date}.json`);
  }

  log(entry) {
    const logEntry = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      ...entry
    };

    this.logs.push(logEntry);
    if (this.logs.length > this.maxMemoryLogs) {
      this.logs = this.logs.slice(-this.maxMemoryLogs);
    }

    // Write to file
    try {
      const file = this._getLogFile();
      let existing = [];
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf8');
        existing = JSON.parse(raw);
      }
      existing.push(logEntry);
      fs.writeFileSync(file, JSON.stringify(existing, null, 2));
    } catch (e) {
      console.error('Failed to write log:', e.message);
    }

    // Notify listeners
    this.listeners.forEach(fn => {
      try { fn(logEntry); } catch (e) {}
    });

    return logEntry;
  }

  modAction(data) {
    return this.log({
      type: 'mod_action',
      action: data.action,
      userId: data.userId,
      username: data.username,
      channelId: data.channelId,
      channelName: data.channelName,
      guildId: data.guildId,
      guildName: data.guildName,
      messageContent: data.messageContent,
      reason: data.reason,
      ruleId: data.ruleId,
      severity: data.severity,
      aiConfidence: data.aiConfidence,
      duration: data.duration || null
    });
  }

  aiAnalysis(data) {
    return this.log({
      type: 'ai_analysis',
      userId: data.userId,
      username: data.username,
      channelId: data.channelId,
      channelName: data.channelName,
      messageContent: data.messageContent,
      flagged: data.flagged,
      violations: data.violations,
      confidence: data.confidence,
      reasoning: data.reasoning
    });
  }

  botEvent(data) {
    return this.log({
      type: 'bot_event',
      event: data.event,
      details: data.details
    });
  }

  error(data) {
    return this.log({
      type: 'error',
      error: data.error,
      context: data.context,
      stack: data.stack
    });
  }

  getLogs(options = {}) {
    let filtered = [...this.logs];

    if (options.type) {
      filtered = filtered.filter(l => l.type === options.type);
    }
    if (options.guildId) {
      filtered = filtered.filter(l => l.guildId === options.guildId);
    }
    if (options.userId) {
      filtered = filtered.filter(l => l.userId === options.userId);
    }
    if (options.severity) {
      filtered = filtered.filter(l => l.severity === options.severity);
    }
    if (options.since) {
      const since = new Date(options.since);
      filtered = filtered.filter(l => new Date(l.timestamp) >= since);
    }
    if (options.limit) {
      filtered = filtered.slice(-options.limit);
    }

    return filtered;
  }

  getRecentLogs(count = 100) {
    return this.logs.slice(-count);
  }

  getStats() {
    const now = new Date();
    const last24h = new Date(now - 24 * 60 * 60 * 1000);
    const last7d = new Date(now - 7 * 24 * 60 * 60 * 1000);

    const recent24h = this.logs.filter(l => new Date(l.timestamp) >= last24h);
    const recent7d = this.logs.filter(l => new Date(l.timestamp) >= last7d);

    const actions24h = recent24h.filter(l => l.type === 'mod_action');
    const actions7d = recent7d.filter(l => l.type === 'mod_action');

    return {
      total: this.logs.length,
      last24h: {
        total: recent24h.length,
        actions: actions24h.length,
        warns: actions24h.filter(a => a.action === 'warn').length,
        timeouts: actions24h.filter(a => a.action === 'timeout').length,
        kicks: actions24h.filter(a => a.action === 'kick').length,
        banRequests: actions24h.filter(a => a.action === 'request_ban').length,
        flagged: recent24h.filter(l => l.type === 'ai_analysis' && l.flagged).length,
        clean: recent24h.filter(l => l.type === 'ai_analysis' && !l.flagged).length
      },
      last7d: {
        total: recent7d.length,
        actions: actions7d.length,
        warns: actions7d.filter(a => a.action === 'warn').length,
        timeouts: actions7d.filter(a => a.action === 'timeout').length,
        kicks: actions7d.filter(a => a.action === 'kick').length,
        banRequests: actions7d.filter(a => a.action === 'request_ban').length
      },
      byRule: this._countByField(this.logs.filter(l => l.type === 'mod_action'), 'ruleId'),
      bySeverity: this._countByField(this.logs.filter(l => l.type === 'mod_action'), 'severity')
    };
  }

  _countByField(arr, field) {
    const counts = {};
    arr.forEach(item => {
      const key = item[field] || 'unknown';
      counts[key] = (counts[key] || 0) + 1;
    });
    return counts;
  }

  onLog(fn) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  clearMemory() {
    this.logs = [];
  }
}

module.exports = new Logger();
