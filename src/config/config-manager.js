const path = require('path');
const fs = require('fs');

const defaultRules = require('./default-rules.json');

// ─── JSON File Storage (replaces electron-store) ────────────
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getDefaults() {
  return {
    rules: JSON.parse(JSON.stringify(defaultRules.moderationRules)),
    settings: JSON.parse(JSON.stringify(defaultRules.globalSettings)),
    botToken: process.env.BOT_TOKEN || '',
    pollinationsKey: process.env.POLLINATIONS_KEY || 'pk_74dZ9pYlU7ufjX7O'
  };
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      const saved = JSON.parse(raw);
      // Merge with defaults so new fields are always present
      const defaults = getDefaults();
      return {
        rules: saved.rules || defaults.rules,
        settings: { ...defaults.settings, ...saved.settings },
        botToken: saved.botToken || defaults.botToken,
        pollinationsKey: saved.pollinationsKey || defaults.pollinationsKey
      };
    }
  } catch (e) {
    console.error('Failed to load config, using defaults:', e.message);
  }
  return getDefaults();
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('Failed to save config:', e.message);
  }
}

let config = loadConfig();

class ConfigManager {
  static getRules() {
    return config.rules;
  }

  static setRules(rules) {
    config.rules = rules;
    saveConfig();
  }

  static getRule(ruleId) {
    const rules = this.getRules();
    return rules.find(r => r.id === ruleId);
  }

  static updateRule(ruleId, updates) {
    const rules = this.getRules();
    const idx = rules.findIndex(r => r.id === ruleId);
    if (idx !== -1) {
      rules[idx] = { ...rules[idx], ...updates };
      this.setRules(rules);
    }
    return rules[idx];
  }

  static getSettings() {
    return config.settings;
  }

  static updateSettings(updates) {
    const current = this.getSettings();
    config.settings = { ...current, ...updates };
    saveConfig();
    return config.settings;
  }

  static getBotToken() {
    return config.botToken || process.env.BOT_TOKEN || '';
  }

  static setBotToken(token) {
    config.botToken = token;
    saveConfig();
  }

  static getPollinationsKey() {
    return config.pollinationsKey || process.env.POLLINATIONS_KEY || 'pk_74dZ9pYlU7ufjX7O';
  }

  static resetToDefaults() {
    const defaults = getDefaults();
    config.rules = defaults.rules;
    config.settings = defaults.settings;
    saveConfig();
  }

  static exportConfig() {
    return {
      rules: this.getRules(),
      settings: this.getSettings()
    };
  }

  static importConfig(cfg) {
    if (cfg.rules) this.setRules(cfg.rules);
    if (cfg.settings) this.updateSettings(cfg.settings);
  }
}

module.exports = ConfigManager;
