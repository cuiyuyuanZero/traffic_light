const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');

const os = require('os');

// Configuration
let config = {
  syncLaunch: true,
  scale: 1.0,
  codexLogPath: '',
  claudeLogPath: '',
  codexRolloutDir: path.join(os.homedir(), '.codex', 'sessions'),
  codexDesktopLogDir: path.join(os.homedir(), '.codex', 'logs')
};

const CONFIG_FILE = path.join(os.homedir(), '.traffic-light-service-config.json');

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      config = { ...config, ...data };
    } catch (e) {
      console.error('Failed to load config:', e.message);
    }
  }
  
  // Defaults for macOS if paths not set
  if (!config.claudeLogPath) {
    config.claudeLogPath = path.join(os.homedir(), 'Library', 'Logs', 'Claude', 'main.log');
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save config:', e.message);
  }
}

loadConfig();

// System State
const state = {
  codexSessions: {}, // Map of filePath -> { state, detail, lastActive }
  codexActiveFilePath: null,
  claude: { state: 'finished', lastActive: Date.now() }
};

// Aggregated Codex State Helper
function normalizeCodexSessions(now = Date.now()) {
  Object.values(state.codexSessions).forEach((session) => {
    if (session.state !== 'finished' && (now - session.lastActive) > CODEX_IDLE_TIMEOUT_MS) {
      session.state = 'finished';
      session.detail = '自动超时恢复';
    }
  });
}

function getAggregateCodexState() {
  normalizeCodexSessions();
  const sessions = Object.entries(state.codexSessions).map(([filePath, session]) => ({
    filePath,
    ...session
  }));
  const counts = { error: 0, executing: 0, thinking: 0, finished: 0, offline: 0 };
  
  sessions.forEach(s => {
    if (counts[s.state] !== undefined) counts[s.state]++;
  });

  const activeSessions = sessions
    .filter(s => s.state !== 'finished' && s.state !== 'offline')
    .sort((a, b) => b.lastActive - a.lastActive);
  const thinkingSessions = sessions
    .filter(s => s.state === 'thinking')
    .sort((a, b) => b.lastActive - a.lastActive);
  const executingSessions = sessions
    .filter(s => s.state === 'executing')
    .sort((a, b) => b.lastActive - a.lastActive);
  const latestActive = activeSessions[0] || null;
  const latestSession = sessions.slice().sort((a, b) => b.lastActive - a.lastActive)[0] || null;

  let aggregateState = 'finished';
  let detail = '所有会话空闲';

  if (counts.error > 0) {
    aggregateState = 'error';
    detail = `${counts.error} 个会话需要干预`;
  } else if (thinkingSessions.length > 0) {
    aggregateState = 'thinking';
    detail = thinkingSessions[0].detail || `${thinkingSessions.length} 个会话正在思考`;
  } else if (executingSessions.length > 0) {
    aggregateState = 'executing';
    detail = executingSessions[0].detail || `${executingSessions.length} 个会话正在输出/执行`;
  } else {
    aggregateState = 'finished';
    detail = '执行完毕 / 空闲中';
  }

  state.codexActiveFilePath = thinkingSessions[0]?.filePath || executingSessions[0]?.filePath || latestActive?.filePath || latestSession?.filePath || null;

  return {
    state: aggregateState,
    detail,
    counts,
    activeSession: state.codexActiveFilePath ? path.basename(state.codexActiveFilePath) : ''
  };
}

const knownFileSizes = {}; // Persistent tracking of file positions to handle session switching
const CODEX_INFER_BYTES = 512 * 1024;
const CODEX_IDLE_TIMEOUT_MS = 60000;
const CODEX_WATCH_COUNT = 100;
const CODEX_DISCOVERY_INTERVAL_MS = 300;

let lastCodexAggregateSignature = '';

function broadcastCodexAggregate(force = false) {
  const aggregate = getAggregateCodexState();
  const signature = JSON.stringify({
    state: aggregate.state,
    detail: aggregate.detail,
    counts: aggregate.counts,
    activeSession: aggregate.activeSession
  });

  if (!force && signature === lastCodexAggregateSignature) return;
  lastCodexAggregateSignature = signature;
  broadcast('event', { agent: 'codex', ...aggregate });
}

// Express Setup
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// WebSocket broadcast helper
function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Update Agent State
function updateAgentState(agent, newState, detail = '', filePath = 'default') {
  if (agent === 'codex') {
    if (!state.codexSessions[filePath]) {
      state.codexSessions[filePath] = { state: 'finished', detail: '已连接', lastActive: Date.now() };
    }

    const session = state.codexSessions[filePath];
    if (session.state !== newState || session.detail !== detail) {
      console.log(`[Session Change] ${path.basename(filePath)}: ${session.state} -> ${newState} (${detail})`);
      
      session.state = newState;
      session.detail = detail;
      session.lastActive = Date.now();
      
      broadcastCodexAggregate();
    } else {
      session.lastActive = Date.now();
      broadcastCodexAggregate();
    }
  } else {
    if (state[agent].state !== newState || (detail && detail !== state[agent].detail)) {
      state[agent].state = newState;
      state[agent].detail = detail;
      state[agent].lastActive = Date.now();
      console.log(`[Claude Change] ${newState} (${detail})`);
      broadcast('event', { agent, state: newState, detail });
    } else {
      state[agent].lastActive = Date.now();
    }
  }
}

// Log Tailer Engine
class LogTailer {
  constructor(filePath, onLine, options = {}) {
    this.filePath = filePath;
    this.onLine = onLine;
    this.watcher = null;
    this.pollInterval = null;
    this.position = options.startPos || 0;
    this.startAtEnd = options.startAtEnd || false;
    this.lineBuffer = '';
    console.log(`[LogTailer] Initializing for ${path.basename(filePath)} at pos ${this.position}`);
    this.start();
  }

  start() {
    if (!fs.existsSync(this.filePath)) {
      console.log(`[LogTailer] File does not exist: ${this.filePath}. Waiting...`);
      setTimeout(() => this.start(), 1000);
      return;
    }

    try {
      const stats = fs.statSync(this.filePath);
      if (this.startAtEnd) {
        this.position = stats.size;
        this.startAtEnd = false; 
      }
      knownFileSizes[this.filePath] = this.position;
      console.log(`[LogTailer] Started tailing ${path.basename(this.filePath)} (Size: ${stats.size}, WatchPos: ${this.position})`);

      this.readNewContent();

      if (this.watcher) this.watcher.close();
      this.watcher = fs.watch(this.filePath, (eventType) => {
        if (eventType === 'change') {
          this.readNewContent();
        } else if (eventType === 'rename') {
          console.log(`[LogTailer] File renamed/rotated: ${this.filePath}. Restarting...`);
          setTimeout(() => this.start(), 500);
        }
      });

      if (this.pollInterval) clearInterval(this.pollInterval);
      this.pollInterval = setInterval(() => {
        this.readNewContent();
      }, 300); 

    } catch (err) {
      console.error(`[LogTailer] Failed to tail ${this.filePath}:`, err.message);
      setTimeout(() => this.start(), 1000);
    }
  }

  readNewContent() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const stats = fs.statSync(this.filePath);
      
      if (stats.size < this.position) {
        console.log(`[LogTailer] File truncated/reset: ${path.basename(this.filePath)} (${this.position} -> 0)`);
        this.position = 0;
        this.lineBuffer = '';
      }

      const bytesToRead = stats.size - this.position;
      if (bytesToRead <= 0) return;

      console.log(`[LogTailer] ${path.basename(this.filePath)} grew: +${bytesToRead} bytes`);

      const buffer = Buffer.alloc(bytesToRead);
      const fd = fs.openSync(this.filePath, 'r');
      fs.readSync(fd, buffer, 0, bytesToRead, this.position);
      fs.closeSync(fd);

      this.position = stats.size;
      knownFileSizes[this.filePath] = this.position;
      
      const newText = this.lineBuffer + buffer.toString('utf8');
      const lines = newText.split(/\r?\n/);
      
      this.lineBuffer = lines.pop() || '';
      
      lines.forEach((line) => {
        if (line.trim()) {
          try {
            this.onLine(line);
          } catch (e) {
            console.error(`[LogTailer] Callback error:`, e.message);
          }
        }
      });
    } catch (err) {
      console.error(`[LogTailer] Error reading ${this.filePath}:`, err.message);
    }
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}

function classifyCodexLogLine(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch (e) {
    return null;
  }

  const payload = entry.payload || entry;
  const rawString = line.toLowerCase();

  const isError =
    payload.type === 'error' ||
    payload.status === 'failed' ||
    payload.status === 'error' ||
    rawString.includes('"type":"error"') ||
    rawString.includes('"status":"failed"');

  const isIntervention =
    payload.type === 'ask_user' ||
    payload.name === 'ask_user' ||
    payload.type === 'user_intervention' ||
    payload.status === 'requires_action' ||
    rawString.includes('ask_user') ||
    rawString.includes('authorization_required') ||
    rawString.includes('requires_action');

  if (isError) {
    return { state: 'error', detail: `错误: ${payload.message || '执行失败'}` };
  }

  if (isIntervention) {
    return { state: 'error', detail: '等待用户授权/输入...' };
  }

  if (entry.type === 'compacted') {
    return { state: 'thinking', detail: '正在压缩上下文...' };
  }

  if (entry.type === 'session_meta' || entry.type === 'turn_context') {
    return { state: 'thinking', detail: '正在准备上下文...' };
  }

  if (entry.type !== 'response_item' && entry.type !== 'event_msg' && entry.type !== 'tool_call') {
    return null;
  }

  if (payload.type === 'task_complete') {
    return { state: 'finished', detail: '任务执行完毕' };
  }

  if (payload.phase === 'final_answer') {
    return { state: 'finished', detail: '任务执行完毕' };
  }

  if (payload.type === 'reasoning' || payload.type === 'task_started') {
    return { state: 'thinking', detail: '正在深度思考中...' };
  }

  if (payload.type === 'agent_message' || payload.type === 'message') {
    return { state: 'executing', detail: '正在输出回复...' };
  }

  if (
    payload.type === 'custom_tool_call' ||
    payload.type === 'function_call' ||
    payload.type === 'web_search_call' ||
    payload.type === 'tool_call'
  ) {
    const toolName = payload.name || payload.tool || '工具';
    return { state: 'executing', detail: `正在执行: ${toolName}` };
  }

  if (
    payload.type === 'custom_tool_call_output' ||
    payload.type === 'function_call_output' ||
    payload.type === 'web_search_end' ||
    payload.type === 'patch_apply_end'
  ) {
    return { state: 'executing', detail: '处理执行结果...' };
  }

  if (payload.type === 'thread_goal_updated') {
    return { state: 'thinking', detail: '正在规划任务...' };
  }

  return null;
}

function inferCodexSessionFromTail(filePath, stats) {
  try {
    if (!stats || stats.size <= 0) return null;

    const bytesToRead = Math.min(stats.size, CODEX_INFER_BYTES);
    const buffer = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, bytesToRead, stats.size - bytesToRead);
    fs.closeSync(fd);

    const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
    let inferred = null;

    lines.forEach((line) => {
      const parsed = classifyCodexLogLine(line);
      if (parsed) inferred = parsed;
    });

    return inferred;
  } catch (e) {
    console.error(`[Infer] Failed to infer Codex state from ${path.basename(filePath)}:`, e.message);
    return null;
  }
}

// Helpers to find the latest log files
function getRecentCodexRollouts(count = 5) {
  try {
    const baseDir = config.codexRolloutDir;
    if (!fs.existsSync(baseDir)) return [];
    
    let allFiles = [];
    const years = fs.readdirSync(baseDir).filter(y => /^\d{4}$/.test(y));
    years.sort((a, b) => b - a).slice(0, 2).forEach(year => {
      const yearDir = path.join(baseDir, year);
      const months = fs.readdirSync(yearDir).filter(m => /^\d{2}$/.test(m));
      months.sort((a, b) => b - a).slice(0, 2).forEach(month => {
        const monthDir = path.join(yearDir, month);
        const days = fs.readdirSync(monthDir).filter(d => /^\d{2}$/.test(d));
        days.sort((a, b) => b - a).slice(0, 15).forEach(day => {
          const dayDir = path.join(monthDir, day);
          try {
            const files = fs.readdirSync(dayDir)
              .filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl'))
              .map(f => {
                const fullPath = path.join(dayDir, f);
                const stats = fs.statSync(fullPath);
                return { name: f, path: fullPath, mtime: stats.mtimeMs, size: stats.size };
              });
            allFiles = allFiles.concat(files);
          } catch (e) {}
        });
      });
    });

    if (allFiles.length === 0) return [];
    allFiles.sort((a, b) => b.mtime - a.mtime);
    return allFiles.slice(0, count).map(f => f.path);
  } catch (e) {
    console.error('[Finder] Error finding Codex rollouts:', e.message);
  }
  return [];
}

function getLatestCodexDesktopLog() {
  try {
    const baseDir = config.codexDesktopLogDir;
    if (!fs.existsSync(baseDir)) return null;
    
    let allFiles = [];
    const years = fs.readdirSync(baseDir).filter(y => /^\d{4}$/.test(y));
    years.sort((a, b) => b - a).slice(0, 2).forEach(year => {
      const yearDir = path.join(baseDir, year);
      const months = fs.readdirSync(yearDir).filter(m => /^\d{2}$/.test(m));
      months.sort((a, b) => b - a).slice(0, 2).forEach(month => {
        const monthDir = path.join(yearDir, month);
        const days = fs.readdirSync(monthDir).filter(d => /^\d{2}$/.test(d));
        days.sort((a, b) => b - a).slice(0, 10).forEach(day => {
          const dayDir = path.join(monthDir, day);
          try {
            const files = fs.readdirSync(dayDir)
              .filter(f => f.startsWith('codex-desktop-') && f.endsWith('.log'))
              .map(f => ({ path: path.join(dayDir, f), mtime: fs.statSync(path.join(dayDir, f)).mtimeMs }));
            allFiles = allFiles.concat(files);
          } catch (e) {}
        });
      });
    });

    if (allFiles.length === 0) return null;
    allFiles.sort((a, b) => b.mtime - a.mtime);
    return allFiles[0].path;
  } catch (e) {
    console.error('[Finder] Error finding Codex desktop log:', e.message);
  }
  return null;
}

// Log watch instances
let codexRolloutWatchers = [];
let codexDesktopWatcher = null;
let claudeWatcher = null;

function createCodexRolloutWatcher(rolloutPath, isInitialLoad = false) {
  let startPos = 0;
  const stats = fs.existsSync(rolloutPath) ? fs.statSync(rolloutPath) : { size: 0 };

  if (knownFileSizes[rolloutPath] !== undefined) {
    startPos = knownFileSizes[rolloutPath];
  } else if (isInitialLoad) {
    startPos = stats.size;
  } else {
    startPos = Math.max(0, stats.size - 10240);
  }

  const isRecent = (Date.now() - stats.mtimeMs) < CODEX_IDLE_TIMEOUT_MS;
  const inferred = isRecent ? inferCodexSessionFromTail(rolloutPath, stats) : null;
  state.codexSessions[rolloutPath] = {
    state: inferred ? inferred.state : 'finished',
    detail: inferred ? inferred.detail : '已连接',
    lastActive: stats.mtimeMs || Date.now()
  };

  return new LogTailer(rolloutPath, (line) => {
    try {
      const entry = JSON.parse(line);
      console.log(`[Parser] ${path.basename(rolloutPath)}: ${entry.type}`);
      const parsed = classifyCodexLogLine(line);
      if (parsed) {
        updateAgentState('codex', parsed.state, parsed.detail, rolloutPath);
      } else if (state.codexSessions[rolloutPath]) {
        state.codexSessions[rolloutPath].lastActive = Date.now();
      }
    } catch (e) {}
  }, { startPos });
}

function syncCodexRolloutWatchers(isInitialLoad = false) {
  const rolloutPaths = getRecentCodexRollouts(CODEX_WATCH_COUNT);
  const latestSet = new Set(rolloutPaths);
  const currentSet = new Set(codexRolloutWatchers.map(w => w.filePath));
  let changed = false;

  codexRolloutWatchers = codexRolloutWatchers.filter((watcher) => {
    if (latestSet.has(watcher.filePath)) return true;
    watcher.stop();
    delete state.codexSessions[watcher.filePath];
    changed = true;
    return false;
  });

  rolloutPaths.forEach((rolloutPath) => {
    if (currentSet.has(rolloutPath)) return;
    console.log(`[Watcher] Adding Codex rollout watcher: ${path.basename(rolloutPath)}`);
    codexRolloutWatchers.push(createCodexRolloutWatcher(rolloutPath, isInitialLoad));
    changed = true;
  });

  if (changed) {
    broadcastCodexAggregate(true);
  }
}

function initLogWatchers(isInitialLoad = false) {
  codexRolloutWatchers.forEach(w => w.stop());
  codexRolloutWatchers = [];
  if (codexDesktopWatcher) codexDesktopWatcher.stop();
  if (claudeWatcher) claudeWatcher.stop();

  // Clear stale session states to prevent 'stuck' aggregate results
  state.codexSessions = {};
  state.codexActiveFilePath = null;
  lastCodexAggregateSignature = '';

  console.log(`[Watcher] Initializing Codex rollout watchers. isInitialLoad: ${isInitialLoad}`);
  syncCodexRolloutWatchers(isInitialLoad);

  const desktopLogPath = getLatestCodexDesktopLog();

  if (desktopLogPath) {
    codexDesktopWatcher = new LogTailer(desktopLogPath, (line) => {}, { startAtEnd: true });
  }

  claudeWatcher = new LogTailer(config.claudeLogPath, (line) => {
    if (line.includes('[Auth]') || line.includes('Connecting to')) {
      updateAgentState('claude', 'thinking', '正在思考中...');
    } else if (line.includes('MCP server registered') || line.includes('[LocalMcpServerManager]')) {
      updateAgentState('claude', 'executing', '正在执行 MCP 工具...');
    } else if (line.includes('Successully ran all onQuitCleanup') || line.includes('beforeQuit')) {
      updateAgentState('claude', 'finished', '任务结束');
    }
  }, { startAtEnd: true });

  broadcastCodexAggregate(true);
}

// Status Heartbeat
setInterval(() => {
  const aggregate = getAggregateCodexState();
  broadcast('status', { codex: aggregate, claude: state.claude, config: config });
}, 5000);

// Detect session changes
setInterval(() => {
  syncCodexRolloutWatchers(false);
}, CODEX_DISCOVERY_INTERVAL_MS);

// Auto-Idle
setInterval(() => {
  const now = Date.now();
  let changed = false;
  Object.keys(state.codexSessions).forEach(p => {
    const s = state.codexSessions[p];
    if (s.state !== 'finished' && (now - s.lastActive) > CODEX_IDLE_TIMEOUT_MS) {
      s.state = 'finished';
      s.detail = '自动超时恢复';
      changed = true;
    }
  });
  if (changed) {
    broadcastCodexAggregate();
  }
  if (state.claude.state !== 'finished' && (now - state.claude.lastActive) > CODEX_IDLE_TIMEOUT_MS) {
    updateAgentState('claude', 'finished', '自动超时恢复');
  }
}, 5000);

// Sync Launch Process Daemon
let isCodexRunning = false;
let isBrowserOpened = false;

function scanProcesses() {
  exec('ps aux | grep -iE "Codex.app|codex app-server" | grep -v grep', (err, stdout) => {
    const isNowRunning = stdout.trim().length > 0;
    if (isNowRunning && !isCodexRunning) {
      isCodexRunning = true;
      if (config.syncLaunch && module.exports.onCodexDetected) module.exports.onCodexDetected();
      if (codexRolloutWatchers.length === 0) {
        initLogWatchers(false);
      } else {
        syncCodexRolloutWatchers(false);
      }
    } else if (!isNowRunning && isCodexRunning) {
      isCodexRunning = false;
      isBrowserOpened = false;
    }
  });
}
setInterval(scanProcesses, 3000);

// API Endpoints
app.post('/api/event', (req, res) => {
  const { tool, state: newState, detail } = req.body;
  if (tool && newState) {
    updateAgentState(tool.toLowerCase(), newState, detail);
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'Missing params' });
  }
});

app.post('/api/refresh-status', (req, res) => {
  syncCodexRolloutWatchers(false);
  broadcastCodexAggregate(true);
  res.json({ success: true });
});

app.get('/api/config', (req, res) => res.json(config));
app.post('/api/config', (req, res) => {
  Object.assign(config, req.body);
  saveConfig();
  initLogWatchers(false);
  if (module.exports.onConfigUpdated) module.exports.onConfigUpdated(config);
  broadcast('config', config);
  res.json({ success: true });
});

app.post('/api/quit', (req, res) => {
  res.json({ success: true });
  if (module.exports.onQuitRequested) {
    module.exports.onQuitRequested();
  } else {
    process.exit(0);
  }
});

wss.on('connection', (ws) => {
  const aggregate = getAggregateCodexState();
  ws.send(JSON.stringify({ 
    type: 'status', 
    data: { codex: aggregate, claude: state.claude }, 
    config: config 
  }));
});

initLogWatchers(true);
server.listen(19001, () => {
  console.log(`🚦 Monitor Service Live on http://localhost:19001`);
});

module.exports = {
  onCodexDetected: null,
  onConfigUpdated: null,
  broadcastConfig: (newConfig) => {
    config = { ...config, ...newConfig };
    broadcast('config', config);
  }
};
