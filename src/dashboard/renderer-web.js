// ─── Web API Layer (replaces Electron IPC) ──────────────────
const api = {
  // Auth
  login: (password) => _post('/api/auth/login', { password }),
  logout: () => _post('/api/auth/logout'),
  checkAuth: () => _get('/api/auth/check'),

  // Bot controls
  startBot: () => _post('/api/bot/start'),
  stopBot: () => _post('/api/bot/stop'),
  getBotStatus: () => _get('/api/bot/status'),

  // Config
  getRules: () => _get('/api/rules'),
  updateRule: (ruleId, updates) => _put(`/api/rules/${ruleId}`, updates),
  setRules: (rules) => _put('/api/rules', rules),
  getSettings: () => _get('/api/settings'),
  updateSettings: (updates) => _put('/api/settings', updates),
  getBotToken: async () => { const r = await _get('/api/settings/token'); return r.token; },
  setBotToken: (token) => _put('/api/settings/token', { token }),
  resetConfig: () => _post('/api/config/reset'),

  // Logs
  getLogs: (options) => _get('/api/logs?' + new URLSearchParams(options || {}).toString()),
  getRecentLogs: (count) => _get(`/api/logs/recent/${count || 100}`),
  getStats: () => _get('/api/stats'),
  clearLogs: () => _delete('/api/logs'),

  // Summaries
  getSummaries: () => _get('/api/summaries'),

  // Event listeners (SSE)
  _statusCallbacks: [],
  _logCallbacks: [],
  onBotStatus: (cb) => api._statusCallbacks.push(cb),
  onLogEntry: (cb) => api._logCallbacks.push(cb)
};

async function _get(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 401) { showLogin(); throw new Error('Unauthorized'); }
  return res.json();
}

async function _post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin'
  });
  if (res.status === 401 && !url.includes('/auth/')) { showLogin(); throw new Error('Unauthorized'); }
  return res.json();
}

async function _put(url, body) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin'
  });
  if (res.status === 401) { showLogin(); throw new Error('Unauthorized'); }
  return res.json();
}

async function _delete(url) {
  const res = await fetch(url, { method: 'DELETE', credentials: 'same-origin' });
  if (res.status === 401) { showLogin(); throw new Error('Unauthorized'); }
  return res.json();
}

// ─── SSE (Server-Sent Events) — replaces Electron IPC push ──
let eventSource = null;

function connectSSE() {
  if (eventSource) { eventSource.close(); }

  eventSource = new EventSource('/api/events');

  eventSource.addEventListener('bot-status', (e) => {
    const status = JSON.parse(e.data);
    api._statusCallbacks.forEach(cb => { try { cb(status); } catch (err) {} });
  });

  eventSource.addEventListener('log-entry', (e) => {
    const entry = JSON.parse(e.data);
    api._logCallbacks.forEach(cb => { try { cb(entry); } catch (err) {} });
  });

  eventSource.addEventListener('connected', () => {
    console.log('SSE connected');
  });

  eventSource.onerror = () => {
    // Auto-reconnect is built into EventSource
    console.log('SSE connection lost, reconnecting...');
  };
}

function disconnectSSE() {
  if (eventSource) { eventSource.close(); eventSource = null; }
}

// ─── Login / Logout ─────────────────────────────────────────
function showLogin() {
  document.getElementById('login-overlay').classList.add('active');
  document.getElementById('app-container').style.display = 'none';
  disconnectSSE();
}

function hideLogin() {
  document.getElementById('login-overlay').classList.remove('active');
  document.getElementById('app-container').style.display = 'block';
  connectSSE();
}

async function handleLogin(e) {
  e.preventDefault();
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');

  errorEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'AUTHENTICATING...';

  try {
    const result = await api.login(password);
    if (result.success) {
      hideLogin();
      initDashboard();
    } else {
      errorEl.textContent = result.error || 'Login failed';
    }
  } catch (err) {
    const msg = err.message || 'Connection failed';
    if (msg === 'Unauthorized') {
      errorEl.textContent = 'Invalid password';
    } else {
      try {
        const body = await err.response?.json();
        errorEl.textContent = body?.error || msg;
      } catch {
        errorEl.textContent = msg;
      }
    }
  }

  btn.disabled = false;
  btn.textContent = 'AUTHENTICATE';
}

async function handleLogout() {
  await api.logout();
  showLogin();
}

// ─── State ──────────────────────────────────────────────────
let currentPage = 'overview';
let botRunning = false;
let botStatus = {};
let activityCount = 0;

// ─── Navigation ─────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const page = item.dataset.page;
    switchPage(page);
  });
});

function switchPage(page) {
  currentPage = page;

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-page="${page}"]`).classList.add('active');

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');

  if (page === 'overview') refreshOverview();
  if (page === 'rules') loadRules();
  if (page === 'logs') refreshLogs();
  if (page === 'settings') loadSettings();
  if (page === 'summary') loadSummaries();
  if (page === 'activity') {
    activityCount = 0;
    updateActivityBadge();
  }
}

// ─── Bot Controls ───────────────────────────────────────────
async function toggleBot() {
  const btn = document.getElementById('power-btn');
  btn.disabled = true;

  if (!botRunning) {
    updateBotUI('starting');
    const result = await api.startBot();
    if (result.success) {
      botRunning = true;
      updateBotUI('online');
      toast('Bot started successfully!', 'success');
    } else {
      updateBotUI('offline');
      toast(`Failed to start: ${result.error}`, 'error');
    }
  } else {
    const result = await api.stopBot();
    if (result.success) {
      botRunning = false;
      updateBotUI('offline');
      toast('Bot stopped', 'info');
    }
  }

  btn.disabled = false;
}

function updateBotUI(state) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  const sub = document.getElementById('status-sub');
  const btn = document.getElementById('power-btn');

  dot.className = 'status-dot ' + (state === 'online' ? 'online' : state === 'starting' ? 'starting' : 'offline');

  if (state === 'online') {
    label.textContent = botStatus.username || 'Online';
    sub.textContent = `${botStatus.guilds || 0} servers · ${botStatus.members || 0} members`;
    btn.className = 'btn-power running';
    btn.innerHTML = '⏻ Stop Bot';
  } else if (state === 'starting') {
    label.textContent = 'Starting...';
    sub.textContent = 'Connecting to Discord';
    btn.className = 'btn-power';
    btn.innerHTML = '⏳ Starting...';
  } else {
    label.textContent = 'Offline';
    sub.textContent = 'Not connected';
    btn.className = 'btn-power';
    btn.innerHTML = '⏻ Start Bot';
  }
}

// ─── Event Listeners (from SSE) ─────────────────────────────
api.onBotStatus((status) => {
  botStatus = status;
  botRunning = status.running;

  if (status.running) updateBotUI('online');
  else updateBotUI('offline');

  if (currentPage === 'overview') refreshOverview();
});

api.onLogEntry((entry) => {
  // Live activity feed
  addToLiveFeed(entry);

  if (currentPage !== 'activity') {
    activityCount++;
    updateActivityBadge();
  }

  if (currentPage === 'overview') refreshOverview();
  if (currentPage === 'logs') appendLog(entry);
});

// ─── Overview Page ──────────────────────────────────────────
async function refreshOverview() {
  try {
    const [stats, status] = await Promise.all([
      api.getStats(),
      api.getBotStatus()
    ]);

    botStatus = status;

    document.getElementById('stat-messages').textContent = formatNum(status.messageCount || 0);
    document.getElementById('stat-clean').textContent = formatNum(stats.last24h?.clean || 0);
    document.getElementById('stat-flagged').textContent = formatNum(stats.last24h?.flagged || 0);
    document.getElementById('stat-timeouts').textContent = formatNum(stats.last24h?.timeouts || 0);
    document.getElementById('stat-kicks').textContent = formatNum(stats.last24h?.kicks || 0);
    document.getElementById('stat-bans').textContent = formatNum(stats.last24h?.banRequests || 0);

    // Server pills
    const pillsEl = document.getElementById('server-pills');
    if (status.guildList && status.guildList.length > 0) {
      pillsEl.innerHTML = status.guildList.map(g => `
        <div class="server-pill">
          <div class="server-icon">${g.name[0]}</div>
          ${g.name} <span style="color:var(--text3)">· ${g.memberCount} members</span>
        </div>
      `).join('');
    } else {
      pillsEl.innerHTML = '';
    }

    // Chart
    renderActionChart(stats.last24h);

    // Recent activity
    const logs = await api.getRecentLogs(8);
    const feedEl = document.getElementById('overview-feed');
    if (logs.length === 0) {
      feedEl.innerHTML = '<div class="empty-state"><p>No recent activity</p></div>';
    } else {
      feedEl.innerHTML = logs.reverse().map(l => renderActivityItem(l)).join('');
    }
  } catch (e) {
    console.error('Failed to refresh overview:', e);
  }
}

function renderActionChart(data) {
  if (!data) return;
  const container = document.getElementById('chart-actions');
  const values = [
    { label: 'Warns', value: data.warns || 0, color: 'var(--orange)' },
    { label: 'Timeouts', value: data.timeouts || 0, color: 'var(--pink)' },
    { label: 'Kicks', value: data.kicks || 0, color: 'var(--red)' },
    { label: 'Bans', value: data.banRequests || 0, color: '#d63031' },
    { label: 'Flagged', value: data.flagged || 0, color: 'var(--cyan)' },
    { label: 'Clean', value: data.clean || 0, color: 'var(--green)' }
  ];

  const max = Math.max(...values.map(v => v.value), 1);

  container.innerHTML = values.map(v => `
    <div class="chart-bar" style="height: ${Math.max((v.value / max) * 100, 4)}%; background: ${v.color};">
      <span class="label">${v.label}<br><strong>${v.value}</strong></span>
    </div>
  `).join('');
}

function renderActivityItem(entry) {
  let icon = '📋';
  let iconClass = 'info';
  let title = '';
  let desc = '';

  if (entry.type === 'mod_action') {
    const actionMap = { warn: ['⚠️', 'warn'], timeout: ['🔇', 'timeout'], kick: ['👢', 'kick'], request_ban: ['🚨', 'ban'], ban: ['🔨', 'ban'] };
    const [emoji, cls] = actionMap[entry.action] || ['📋', 'info'];
    icon = emoji;
    iconClass = cls;
    title = `${entry.action.replace('_', ' ').toUpperCase()} — ${entry.username || 'Unknown'}`;
    desc = entry.reason || entry.messageContent || '';
  } else if (entry.type === 'ai_analysis') {
    icon = entry.flagged ? '🔍' : '✅';
    iconClass = entry.flagged ? 'warn' : 'info';
    title = `${entry.flagged ? 'Flagged' : 'Clean'} — ${entry.username || 'Unknown'}`;
    desc = entry.flagged ? entry.reasoning : (entry.messageContent || '').substring(0, 80);
  } else if (entry.type === 'bot_event') {
    icon = '🤖';
    title = entry.event?.replace(/_/g, ' ');
    desc = entry.details || '';
  } else if (entry.type === 'error') {
    icon = '❌';
    iconClass = 'kick';
    title = 'Error';
    desc = entry.error || '';
  }

  return `
    <div class="activity-item">
      <div class="activity-icon ${iconClass}">${icon}</div>
      <div class="activity-content">
        <div class="activity-title">${escapeHtml(title)}</div>
        <div class="activity-desc">${escapeHtml((desc || '').substring(0, 120))}</div>
      </div>
      <div class="activity-time">${formatTime(entry.timestamp)}</div>
    </div>
  `;
}

// ─── Live Activity ──────────────────────────────────────────
function addToLiveFeed(entry) {
  const feed = document.getElementById('live-feed');
  const empty = feed.querySelector('.empty-state');
  if (empty) empty.remove();

  const html = renderActivityItem(entry);
  feed.insertAdjacentHTML('afterbegin', html);

  // Keep max 200 items
  while (feed.children.length > 200) {
    feed.lastElementChild.remove();
  }
}

function clearActivityFeed() {
  document.getElementById('live-feed').innerHTML = `
    <div class="empty-state">
      <div class="icon">📡</div>
      <h3>Feed cleared</h3>
      <p>New events will appear here</p>
    </div>
  `;
}

function updateActivityBadge() {
  const badge = document.getElementById('activity-badge');
  if (activityCount > 0) {
    badge.style.display = 'inline';
    badge.textContent = activityCount > 99 ? '99+' : activityCount;
  } else {
    badge.style.display = 'none';
  }
}

// ─── Rules Page ─────────────────────────────────────────────
async function loadRules() {
  const rules = await api.getRules();
  const grid = document.getElementById('rules-grid');

  grid.innerHTML = rules.map(rule => `
    <div class="rule-card ${rule.enabled ? '' : 'disabled'}" id="rule-${rule.id}">
      <div class="rule-header">
        <span class="rule-name">${escapeHtml(rule.name)}</span>
        <span class="severity-badge ${rule.severity}">${rule.severity}</span>
      </div>
      <div class="rule-desc">${escapeHtml(rule.description)}</div>
      <div class="rule-meta">
        <span>🎯 ${rule.action.replace('_', ' ')}</span>
        ${rule.timeoutDuration ? `<span>⏱ ${Math.floor(rule.timeoutDuration / 60)}m</span>` : ''}
      </div>
      <div class="rule-actions">
        <label class="toggle">
          <input type="checkbox" ${rule.enabled ? 'checked' : ''} onchange="toggleRule('${rule.id}', this.checked)" />
          <span class="toggle-slider"></span>
        </label>
        <button class="btn btn-sm" onclick="editRule('${rule.id}')">✏️ Edit</button>
      </div>
      <div class="rule-edit-area" id="edit-${rule.id}">
        <div class="input-group">
          <label class="input-label">Action</label>
          <select class="select" id="action-${rule.id}">
            <option value="warn" ${rule.action === 'warn' ? 'selected' : ''}>Warn</option>
            <option value="timeout" ${rule.action === 'timeout' ? 'selected' : ''}>Timeout</option>
            <option value="kick" ${rule.action === 'kick' ? 'selected' : ''}>Kick</option>
            <option value="request_ban" ${rule.action === 'request_ban' ? 'selected' : ''}>Request Ban</option>
          </select>
        </div>
        <div class="input-group">
          <label class="input-label">Timeout Duration (seconds)</label>
          <input type="number" class="input" id="duration-${rule.id}" value="${rule.timeoutDuration || 0}" min="0" />
        </div>
        <div class="input-group">
          <label class="input-label">Severity</label>
          <select class="select" id="severity-${rule.id}">
            <option value="low" ${rule.severity === 'low' ? 'selected' : ''}>Low</option>
            <option value="medium" ${rule.severity === 'medium' ? 'selected' : ''}>Medium</option>
            <option value="high" ${rule.severity === 'high' ? 'selected' : ''}>High</option>
            <option value="critical" ${rule.severity === 'critical' ? 'selected' : ''}>Critical</option>
          </select>
        </div>
        <div class="input-group">
          <label class="input-label">AI Prompt</label>
          <textarea class="textarea" id="prompt-${rule.id}" rows="3">${escapeHtml(rule.aiPrompt)}</textarea>
        </div>
        <button class="btn btn-primary btn-sm" onclick="saveRule('${rule.id}')">💾 Save</button>
      </div>
    </div>
  `).join('');
}

async function toggleRule(ruleId, enabled) {
  await api.updateRule(ruleId, { enabled });
  toast(`${ruleId} ${enabled ? 'enabled' : 'disabled'}`, 'info');
  const card = document.getElementById(`rule-${ruleId}`);
  card.classList.toggle('disabled', !enabled);
}

function editRule(ruleId) {
  const card = document.getElementById(`rule-${ruleId}`);
  card.classList.toggle('editing');
}

async function saveRule(ruleId) {
  const updates = {
    action: document.getElementById(`action-${ruleId}`).value,
    timeoutDuration: parseInt(document.getElementById(`duration-${ruleId}`).value) || 0,
    severity: document.getElementById(`severity-${ruleId}`).value,
    aiPrompt: document.getElementById(`prompt-${ruleId}`).value
  };

  await api.updateRule(ruleId, updates);
  toast('Rule saved!', 'success');
  loadRules();
}

async function resetRules() {
  await api.resetConfig();
  toast('Rules reset to defaults', 'info');
  loadRules();
}

// ─── Logs Page ──────────────────────────────────────────────
async function refreshLogs() {
  const type = document.getElementById('log-filter-type').value;
  const severity = document.getElementById('log-filter-severity').value;

  const options = { limit: 500 };
  if (type) options.type = type;
  if (severity) options.severity = severity;

  const logs = await api.getLogs(options);
  const container = document.getElementById('log-container');

  if (logs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">📋</div>
        <h3>No logs found</h3>
        <p>Try changing the filters or wait for bot activity</p>
      </div>
    `;
    return;
  }

  container.innerHTML = logs.reverse().map(l => renderLogEntry(l)).join('');
}

function appendLog(entry) {
  if (currentPage !== 'logs') return;
  const container = document.getElementById('log-container');
  const empty = container.querySelector('.empty-state');
  if (empty) empty.remove();

  container.insertAdjacentHTML('afterbegin', renderLogEntry(entry));
}

function renderLogEntry(entry) {
  const typeLabel = entry.action || entry.type;
  let detail = '';

  if (entry.type === 'mod_action') {
    detail = `${entry.username || 'Unknown'} in #${entry.channelName || '?'} — ${entry.reason || entry.messageContent || ''}`;
  } else if (entry.type === 'ai_analysis') {
    detail = `${entry.username || 'Unknown'}: ${entry.flagged ? '🚩 ' + entry.reasoning : '✅ Clean'} — "${(entry.messageContent || '').substring(0, 60)}"`;
  } else if (entry.type === 'bot_event') {
    detail = `${entry.event}: ${entry.details || ''}`;
  } else if (entry.type === 'error') {
    detail = `${entry.context || ''}: ${entry.error || ''}`;
  }

  return `
    <div class="log-entry">
      <span class="log-time">${formatTime(entry.timestamp)}</span>
      <span class="log-type ${typeLabel}">${typeLabel}</span>
      <span class="log-severity" style="color: ${severityColor(entry.severity)}">${entry.severity || '—'}</span>
      <span class="log-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</span>
    </div>
  `;
}

async function clearLogs() {
  await api.clearLogs();
  toast('Logs cleared', 'info');
  refreshLogs();
}

// ─── Settings Page ──────────────────────────────────────────
async function loadSettings() {
  const [settings, token] = await Promise.all([
    api.getSettings(),
    api.getBotToken()
  ]);

  document.getElementById('setting-token').value = token || '';
  document.getElementById('setting-style').value = settings.moderationStyle || 'balanced';
  document.getElementById('setting-warnings').value = settings.warningsBeforeAction || 2;
  document.getElementById('setting-ban-user').value = settings.banRequestUser || 'devloafyt';
  document.getElementById('setting-dm-on-action').checked = settings.dmOnAction !== false;
  document.getElementById('setting-notify-user').checked = settings.notifyUser !== false;
  document.getElementById('setting-log-flagged').checked = settings.logFlaggedOnly !== false;
  document.getElementById('setting-ignored-channels').value = (settings.ignoredChannels || []).join(',');
  document.getElementById('setting-ignored-roles').value = (settings.ignoredRoles || []).join(',');
  document.getElementById('setting-trusted-roles').value = (settings.trustedRoles || []).join(',');
}

async function saveConnectionSettings() {
  const token = document.getElementById('setting-token').value.trim();
  if (token) {
    await api.setBotToken(token);
    toast('Connection settings saved!', 'success');
  }
}

async function saveAISettings() {
  await api.updateSettings({
    moderationStyle: document.getElementById('setting-style').value,
    warningsBeforeAction: parseInt(document.getElementById('setting-warnings').value) || 2,
    banRequestUser: document.getElementById('setting-ban-user').value.trim() || 'devloafyt'
  });
  toast('AI settings saved!', 'success');
}

async function saveNotificationSettings() {
  await api.updateSettings({
    dmOnAction: document.getElementById('setting-dm-on-action').checked,
    notifyUser: document.getElementById('setting-notify-user').checked,
    logFlaggedOnly: document.getElementById('setting-log-flagged').checked
  });
  toast('Notification settings saved!', 'success');
}

async function saveAdvancedSettings() {
  const parseCsv = (val) => val.split(',').map(s => s.trim()).filter(Boolean);
  await api.updateSettings({
    ignoredChannels: parseCsv(document.getElementById('setting-ignored-channels').value),
    ignoredRoles: parseCsv(document.getElementById('setting-ignored-roles').value),
    trustedRoles: parseCsv(document.getElementById('setting-trusted-roles').value)
  });
  toast('Advanced settings saved!', 'success');
}

async function resetAllSettings() {
  await api.resetConfig();
  toast('All settings reset to defaults', 'info');
  loadSettings();
}

// ─── Summaries Page ─────────────────────────────────────────
async function loadSummaries() {
  const container = document.getElementById('summaries-container');
  try {
    const summaries = await api.getSummaries();
    if (!summaries || summaries.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="icon">📝</div>
          <h3>No summaries yet</h3>
          <p>Use <code>/summary</code> in Discord to generate AI chat summaries</p>
        </div>
      `;
      return;
    }

    const badge = document.getElementById('summary-badge');
    if (badge) {
      badge.textContent = summaries.length;
      badge.style.display = summaries.length > 0 ? 'inline-block' : 'none';
    }

    container.innerHTML = summaries.slice().reverse().map(s => {
      const time = s.timestamp ? new Date(s.timestamp).toLocaleString() : '—';
      const summaryHtml = escapeHtml(s.summary || '').replace(/\n/g, '<br>');
      return `
        <div class="card" style="margin-bottom: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div>
              <strong style="color: var(--pink);">#${escapeHtml(s.channelName || 'unknown')}</strong>
              <span style="color: var(--text3); margin-left: 8px;">${escapeHtml(s.guildName || '')}</span>
            </div>
            <div style="color: var(--text3); font-size: 12px; font-family: var(--monospace);">
              ${time} · ${s.messageCount || 0} msgs
            </div>
          </div>
          <div style="color: var(--text2); line-height: 1.6; font-size: 13px;">
            ${summaryHtml}
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">⚠️</div>
        <h3>Failed to load summaries</h3>
        <p>${escapeHtml(err.message)}</p>
      </div>
    `;
  }
}

// ─── Utilities ──────────────────────────────────────────────
function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function severityColor(severity) {
  const map = { low: 'var(--green)', medium: 'var(--orange)', high: 'var(--pink)', critical: 'var(--red)' };
  return map[severity] || 'var(--text3)';
}

// ─── Dashboard Init ─────────────────────────────────────────
async function initDashboard() {
  try {
    const status = await api.getBotStatus();
    botStatus = status;
    botRunning = status.running;
    updateBotUI(status.running ? 'online' : 'offline');
    refreshOverview();
  } catch (e) {
    console.error('Init error:', e);
  }
}

// ─── Initial Auth Check ─────────────────────────────────────
(async function boot() {
  try {
    const result = await api.checkAuth();
    if (result.authenticated) {
      hideLogin();
      initDashboard();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
})();

// Auto-refresh overview every 10s
setInterval(() => {
  if (currentPage === 'overview' && botRunning) {
    refreshOverview();
  }
}, 10000);
