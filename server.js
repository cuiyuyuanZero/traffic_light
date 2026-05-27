const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');

const os = require('os');
const HOME = os.homedir();

const PORT = 19001;
const CONFIG_FILE = path.join(__dirname, '.config.json');

// Default configurations
const defaultConfig = {
  syncLaunch: true,
  scale: 1.0,
  codexLogPath: path.join(HOME, '.codex/log/codex-tui.log'),
  claudeLogPath: path.join(HOME, 'Library/Logs/Claude/main.log'),
  codexRolloutDir: path.join(HOME, '.codex/sessions'),
  codexDesktopLogDir: path.join(HOME, 'Library/Logs/com.openai.codex')
};

// Load or initialize configuration
let config = { ...defaultConfig };
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config = { ...defaultConfig, ...savedConfig };
  } catch (err) {
    console.error('Failed to parse config file, using defaults:', err.message);
  }
}

// Save configuration helper
function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save config file:', err.message);
  }
}

// System State
const state = {
  codex: { state: 'finished', lastActive: Date.now() },
  claude: { state: 'finished', lastActive: Date.now() }
};

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
function updateAgentState(agent, newState, detail = '') {
  if (state[agent].state !== newState || (detail && detail !== state[agent].detail)) {
    state[agent].state = newState;
    state[agent].detail = detail;
    state[agent].lastActive = Date.now();
    console.log(`[STATE CHANGE] ${agent.toUpperCase()} -> ${newState} (${detail})`);
    broadcast('event', { agent, state: newState, detail });
  } else {
    // Refresh last active time to prevent auto-idle
    state[agent].lastActive = Date.now();
  }
}

// Log Tailer Engine
class LogTailer {
  constructor(filePath, onLine, startAtEnd = false) {
    this.filePath = filePath;
    this.onLine = onLine;
    this.watcher = null;
    this.position = 0;
    this.startAtEnd = startAtEnd;
    this.lineBuffer = '';
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
      }
      console.log(`[LogTailer] Started tailing ${this.filePath} at pos ${this.position} (startAtEnd: ${this.startAtEnd})`);

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
        this.position = 0;
        this.lineBuffer = '';
      }

      const bytesToRead = stats.size - this.position;
      if (bytesToRead <= 0) return;

      const buffer = Buffer.alloc(bytesToRead);
      const fd = fs.openSync(this.filePath, 'r');
      fs.readSync(fd, buffer, 0, bytesToRead, this.position);
      fs.closeSync(fd);

      this.position = stats.size;
      
      const newText = this.lineBuffer + buffer.toString('utf8');
      const lines = newText.split('\n');
      
      // The last element might be a partial line if the file doesn't end with \n
      this.lineBuffer = lines.pop() || '';
      
      lines.forEach((line) => {
        if (line.trim()) {
          this.onLine(line);
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
  }
}

// Helpers to find the latest log files
function getLatestCodexRollout() {
  try {
    const year = new Date().getFullYear().toString();
    const month = (new Date().getMonth() + 1).toString().padStart(2, '0');
    const baseDir = path.join(config.codexRolloutDir, year, month);
    if (!fs.existsSync(baseDir)) return null;
    
    // Collect all rollout files from the most recent 3 days
    const days = fs.readdirSync(baseDir).filter(d => /^\d+$/.test(d)).sort((a, b) => b - a).slice(0, 3);
    let allFiles = [];

    for (const day of days) {
      const dayDir = path.join(baseDir, day);
      const files = fs.readdirSync(dayDir)
        .filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl'))
        .map(f => ({ path: path.join(dayDir, f), mtime: fs.statSync(path.join(dayDir, f)).mtimeMs }));
      allFiles = allFiles.concat(files);
    }

    if (allFiles.length === 0) return null;
    
    // Sort all files by modification time descending
    allFiles.sort((a, b) => b.mtime - a.mtime);
    return allFiles[0].path;
  } catch (e) {
    console.error('[Finder] Error finding Codex rollout:', e.message);
  }
  return null;
}

function getLatestCodexDesktopLog() {
  try {
    const year = new Date().getFullYear().toString();
    const month = (new Date().getMonth() + 1).toString().padStart(2, '0');
    const baseDir = path.join(config.codexDesktopLogDir, year, month);
    if (!fs.existsSync(baseDir)) return null;
    
    // Collect all logs from the most recent 3 days
    const days = fs.readdirSync(baseDir).filter(d => /^\d+$/.test(d)).sort((a, b) => b - a).slice(0, 3);
    let allFiles = [];

    for (const day of days) {
      const dayDir = path.join(baseDir, day);
      const files = fs.readdirSync(dayDir)
        .filter(f => f.startsWith('codex-desktop-') && f.endsWith('.log'))
        .map(f => ({ path: path.join(dayDir, f), mtime: fs.statSync(path.join(dayDir, f)).mtimeMs }));
      allFiles = allFiles.concat(files);
    }

    if (allFiles.length === 0) return null;

    allFiles.sort((a, b) => b.mtime - a.mtime);
    return allFiles[0].path;
  } catch (e) {
    console.error('[Finder] Error finding Codex desktop log:', e.message);
  }
  return null;
}

// Log watch instances
let codexRolloutWatcher = null;
let codexDesktopWatcher = null;
let claudeWatcher = null;

function initLogWatchers() {
  if (codexRolloutWatcher) codexRolloutWatcher.stop();
  if (codexDesktopWatcher) codexDesktopWatcher.stop();
  if (claudeWatcher) claudeWatcher.stop();

  const rolloutPath = getLatestCodexRollout();
  const desktopLogPath = getLatestCodexDesktopLog();

  console.log(`[Watcher] Initializing. Rollout: ${rolloutPath}, Desktop: ${desktopLogPath}`);

  if (rolloutPath) {
    // For Rollout JSONL, we start from the beginning of the file to "warm up" the state
    codexRolloutWatcher = new LogTailer(rolloutPath, (line) => {
      try {
        const entry = JSON.parse(line);

        // Handle top-level event types (Compaction and Context Metadata)
        if (entry.type === 'compacted') {
          updateAgentState('codex', 'thinking', '正在压缩上下文...');
          return;
        } else if (entry.type === 'session_meta' || entry.type === 'turn_context') {
          updateAgentState('codex', 'thinking', '正在准备上下文...');
          return;
        }

        // JSONL Rollout Parsing - PRIMARY SOURCE FOR CODEX
        if (entry.type === 'response_item' || entry.type === 'event_msg') {
          const payload = entry.payload || {};
          
          // Refresh activity for any payload to prevent idle timeout
          state.codex.lastActive = Date.now();

          if (payload.type === 'reasoning' || payload.type === 'task_started') {
            updateAgentState('codex', 'thinking', '正在深度思考中...');
          } else if (payload.type === 'agent_message' || payload.type === 'message') {
            updateAgentState('codex', 'thinking', '正在生成回复...');
          } else if (payload.type === 'custom_tool_call' || payload.type === 'function_call' || payload.type === 'web_search_call') {
            const toolName = payload.name || '工具';
            updateAgentState('codex', 'executing', `正在执行: ${toolName}`);
          } else if (payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output' || payload.type === 'web_search_end' || payload.type === 'patch_apply_end') {
            updateAgentState('codex', 'executing', `处理执行结果...`);
          } else if (payload.type === 'thread_goal_updated') {
             updateAgentState('codex', 'thinking', '正在规划任务...');
          } else if (payload.type === 'task_complete') {
             updateAgentState('codex', 'finished', '任务执行完毕');
          }
        }
      } catch (e) {
        // Partial or invalid JSON
      }
    }, false); // startAtEnd = false
  }

  if (desktopLogPath) {
    // Desktop logs used only for Claude engine signals or generic engine state if needed
    // We REMOVE turn-complete from here for Codex because Rollout JSONL is more precise
    codexDesktopWatcher = new LogTailer(desktopLogPath, (line) => {
      // Logic for generic engine logs if needed
    }, true);
  }

  // Claude Log - Primary source for Claude
  claudeWatcher = new LogTailer(config.claudeLogPath, (line) => {
    if (line.includes('[Auth]') || line.includes('Connecting to')) {
      updateAgentState('claude', 'thinking', '正在思考中...');
    } else if (line.includes('MCP server registered') || line.includes('[LocalMcpServerManager]')) {
      updateAgentState('claude', 'executing', '正在执行 MCP 工具...');
    } else if (line.includes('Successully ran all onQuitCleanup') || line.includes('beforeQuit')) {
      updateAgentState('claude', 'finished', '任务结束');
    }
  }, true);
}

// Status Heartbeat to keep frontend in sync
setInterval(() => {
  broadcast('status', state);
}, 5000);

// Periodically check for newer log files
setInterval(() => {
  const currentRollout = codexRolloutWatcher ? codexRolloutWatcher.filePath : null;
  const latestRollout = getLatestCodexRollout();
  if (latestRollout && latestRollout !== currentRollout) {
    console.log(`[Watcher] New rollout file detected: ${latestRollout}. Re-initializing...`);
    initLogWatchers();
  }
}, 5000);

// Auto-Idle Timers
setInterval(() => {
  const idleTimeout = 300000; // 5 minutes 
  const now = Date.now();

  ['codex', 'claude'].forEach((agent) => {
    if (state[agent].state !== 'finished' && (now - state[agent].lastActive) > idleTimeout) {
      updateAgentState(agent, 'finished', '自动超时恢复');
    }
  });
}, 5000);

// Sync Launch Process Daemon
let isCodexRunning = false;
let isBrowserOpened = false;

function scanProcesses() {
  exec('ps aux | grep -iE "Codex.app|codex app-server" | grep -v grep', (err, stdout) => {
    const isNowRunning = stdout.trim().length > 0;
    if (isNowRunning && !isCodexRunning) {
      isCodexRunning = true;
      if (config.syncLaunch && module.exports.onCodexDetected) {
        module.exports.onCodexDetected();
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

app.get('/api/config', (req, res) => res.json(config));
app.post('/api/config', (req, res) => {
  Object.assign(config, req.body);
  saveConfig();
  initLogWatchers();
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
  ws.send(JSON.stringify({ type: 'status', data: state, config: config }));
});

initLogWatchers();
server.listen(PORT, () => {
  console.log(`🚦 Monitor Service Live on http://localhost:${PORT}`);
});

module.exports = {
  onCodexDetected: null,
  onConfigUpdated: null,
  broadcastConfig: (newConfig) => {
    config = { ...config, ...newConfig };
    broadcast('config', config);
  }
};

