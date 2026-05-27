/**
 * Frontend Application Code for Traffic Light Monitor Dashboard
 */

document.addEventListener('DOMContentLoaded', () => {
  // Websocket configuration
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}`;
  let ws = null;
  let reconnectInterval = 3000;

  // DOM Elements
  const codexWsStatus = document.getElementById('codex-ws-status');
  const claudeWsStatus = document.getElementById('claude-ws-status');
  const logConsole = document.getElementById('log-console');
  
  // Codex Lights & Texts
  const codexLights = {
    red: document.getElementById('codex-light-red'),
    orange: document.getElementById('codex-light-orange'),
    green: document.getElementById('codex-light-green')
  };
  const codexStateText = document.getElementById('codex-state-text');

  // Claude Lights & Texts
  const claudeLights = {
    red: document.getElementById('claude-light-red'),
    orange: document.getElementById('claude-light-orange'),
    green: document.getElementById('claude-light-green')
  };
  const claudeStateText = document.getElementById('claude-state-text');

  // Settings & Config
  const configForm = document.getElementById('config-form');
  const syncLaunchToggle = document.getElementById('sync-launch-toggle');
  const scaleSlider = document.getElementById('scale-slider');
  const scaleValueDisplay = document.getElementById('scale-value-display');
  const codexLogPathInput = document.getElementById('codex-log-path');
  const claudeLogPathInput = document.getElementById('claude-log-path');
  const saveSuccessMsg = document.getElementById('save-success-msg');
  
  // Realtime display scale value while sliding
  scaleSlider.addEventListener('input', () => {
    scaleValueDisplay.textContent = parseFloat(scaleSlider.value).toFixed(1);
  });
  
  // Actions
  const btnClearLogs = document.getElementById('btn-clear-logs');
  const btnCopyHook = document.getElementById('btn-copy-hook');
  const hookConfigLine = document.getElementById('hook-config-line');

  // Add system line to console helper
  function addLog(text, type = 'system') {
    const timestamp = new Date().toLocaleTimeString();
    const logLine = document.createElement('div');
    logLine.className = `log-line ${type}-line`;
    logLine.textContent = `[${timestamp}] ${text}`;
    logConsole.appendChild(logLine);
    
    // Auto scroll to bottom
    logConsole.scrollTop = logConsole.scrollHeight;
    
    // Cap at 200 lines to prevent memory issues
    while (logConsole.childNodes.length > 200) {
      logConsole.removeChild(logConsole.firstChild);
    }
  }

  // Update light rendering
  function setAgentLight(agent, state) {
    const lights = agent === 'codex' ? codexLights : claudeLights;
    const textEl = agent === 'codex' ? codexStateText : claudeStateText;

    // Reset classes
    lights.red.classList.remove('active');
    lights.orange.classList.remove('active');
    lights.green.classList.remove('active');
    
    textEl.classList.remove('red-text', 'orange-text', 'green-text');

    if (state === 'thinking') {
      lights.red.classList.add('active');
      textEl.textContent = '思考中 (Thinking)';
      textEl.classList.add('red-text');
      addLog(`${agent.toUpperCase()} 智能体当前状态: 🔴 思考中...`, `${agent}`);
    } else if (state === 'executing') {
      lights.orange.classList.add('active');
      textEl.textContent = '执行中 (Executing)';
      textEl.classList.add('orange-text');
      addLog(`${agent.toUpperCase()} 智能体当前状态: 🟡 执行中...`, `${agent}`);
    } else {
      lights.green.classList.add('active');
      textEl.textContent = '执行完毕 / 空闲中';
      textEl.classList.add('green-text');
      addLog(`${agent.toUpperCase()} 智能体当前状态: 🟢 已完成 / 空闲中`, `${agent}`);
    }
  }

  // Fetch Settings Config from server
  async function loadConfig() {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const config = await res.json();
        syncLaunchToggle.checked = !!config.syncLaunch;
        
        const scaleVal = parseFloat(config.scale) || 1.0;
        scaleSlider.value = scaleVal;
        scaleValueDisplay.textContent = scaleVal.toFixed(1);
        
        codexLogPathInput.value = config.codexLogPath || '';
        claudeLogPathInput.value = config.claudeLogPath || '';
        addLog('[SYSTEM] 系统配置载入成功');
      }
    } catch (e) {
      addLog('[ERROR] 无法拉取系统配置，使用默认设置', 'error');
    }
  }

  // Save Settings Config to server
  configForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const config = {
      syncLaunch: syncLaunchToggle.checked,
      scale: parseFloat(scaleSlider.value) || 1.0,
      codexLogPath: codexLogPathInput.value.trim(),
      claudeLogPath: claudeLogPathInput.value.trim()
    };

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });

      if (res.ok) {
        addLog('[SYSTEM] 系统设置已更新');
        saveSuccessMsg.classList.add('show');
        setTimeout(() => saveSuccessMsg.classList.remove('show'), 3000);
      } else {
        throw new Error('更新失败');
      }
    } catch (err) {
      addLog(`[ERROR] 保存配置出错: ${err.message}`, 'error');
    }
  });

  // Copy hook config command
  btnCopyHook.addEventListener('click', () => {
    navigator.clipboard.writeText(hookConfigLine.textContent).then(() => {
      const originalText = btnCopyHook.textContent;
      btnCopyHook.textContent = '已复制！';
      btnCopyHook.style.background = 'var(--green-color)';
      btnCopyHook.style.color = '#000';
      
      setTimeout(() => {
        btnCopyHook.textContent = originalText;
        btnCopyHook.style.background = '';
        btnCopyHook.style.color = '';
      }, 2000);
    }).catch(err => {
      addLog('[ERROR] 无法复制到剪贴板，请手动复制', 'error');
    });
  });

  // Clear Terminal logs
  btnClearLogs.addEventListener('click', () => {
    logConsole.innerHTML = '<div class="log-line system-line">[SYSTEM] 控制台已清空。正在等待信号数据流...</div>';
  });

  // Connect to Websocket server
  function connectWebSocket() {
    addLog(`[SYSTEM] 正在连接 WebSocket 服务: ${wsUrl}...`);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      addLog('[SYSTEM] WebSocket 连接已建立，实时监听启动中');
      codexWsStatus.textContent = '实时监控中';
      codexWsStatus.classList.add('online');
      claudeWsStatus.textContent = '实时监控中';
      claudeWsStatus.classList.add('online');
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        
        // Handle init status payload
        if (message.type === 'status') {
          setAgentLight('codex', message.data.codex.state);
          setAgentLight('claude', message.data.claude.state);
        } 
        // Handle realtime event status update
        else if (message.type === 'event') {
          const { agent, state, detail } = message.data;
          setAgentLight(agent, state);
          if (detail) {
            addLog(`[${agent.toUpperCase()}] ${detail}`, `${agent}`);
          }
        }
      } catch (err) {
        addLog(`[ERROR] 解析推送事件时出错: ${err.message}`, 'error');
      }
    };

    ws.onclose = () => {
      addLog('[WARNING] WebSocket 连接已断开，正在尝试重连...', 'error');
      codexWsStatus.textContent = '连接已断开';
      codexWsStatus.classList.remove('online');
      claudeWsStatus.textContent = '连接已断开';
      claudeWsStatus.classList.remove('online');
      
      setTimeout(connectWebSocket, reconnectInterval);
    };

    ws.onerror = (e) => {
      console.error('WebSocket Error: ', e);
    };
  }

  // Initialize
  loadConfig();
  connectWebSocket();
});
