const { app, BrowserWindow, screen, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// Configure autoUpdater
autoUpdater.autoDownload = true;
autoUpdater.on('update-available', () => {
  console.log('[Updater] New version available. Downloading...');
});
autoUpdater.on('update-downloaded', (info) => {
  console.log('[Updater] Update downloaded. Ready to install.');
  dialog.showMessageBox({
    type: 'info',
    title: '更新可用',
    message: `新版本 ${info.version} 已下载，是否立即重启安装？`,
    buttons: ['是', '稍后']
  }).then((result) => {
    if (result.response === 0) autoUpdater.quitAndInstall();
  });
});
autoUpdater.on('error', (err) => {
  console.error('[Updater] Error checking for updates:', err.message);
});

// Start Express background monitoring server
// This boots Express, WebSockets, log watchers and process watchers on port 19001
const monitorServer = require('./server.js');

let mainWindow = null;
const CONFIG_FILE = path.join(__dirname, '.config.json');

// Helper to load screen position coordinates from config
function getSavedPosition() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (config.widgetX !== undefined && config.widgetY !== undefined) {
        return { x: config.widgetX, y: config.widgetY };
      }
    } catch (err) {
      console.error('Failed to parse config for position:', err.message);
    }
  }
  return null;
}

// Helper to save screen position coordinates to config
function savePosition(x, y) {
  try {
    let config = {};
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      } catch (e) {}
    }
    config.widgetX = x;
    config.widgetY = y;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save window position:', err.message);
  }
}

function createWindow() {
  const savedPos = getSavedPosition();
  let x = savedPos ? savedPos.x : undefined;
  let y = savedPos ? savedPos.y : undefined;

  // Load scale from config file
  let scale = 1.0;
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (config.scale !== undefined) {
        scale = parseFloat(config.scale) || 1.0;
      }
    } catch (e) {}
  }

  // Default position: Right side center of primary display
  if (x === undefined || y === undefined) {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    x = width - 180; // 180px from right side
    y = (height - Math.round(410 * scale)) / 2; // centered vertically
  }

  // Create transparent, frameless floating window
  mainWindow = new BrowserWindow({
    width: Math.round(140 * scale),
    height: Math.round(410 * scale),
    x: x,
    y: y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true, // NATIVELY RESIZABLE BY USER DRAGGING BORDERS!
    hasShadow: false, // standard rectangular shadows look bad on transparent circles
    skipTaskbar: true, // keeps dock clean on macOS
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Lock aspect ratio of 140 / 410 on macOS natively
  mainWindow.setAspectRatio(140 / 410);
  mainWindow.setMinimumSize(84, 246); // 0.6x minimum scale
  mainWindow.setMaximumSize(252, 738); // 1.8x maximum scale

  // Load the floating widget page
  mainWindow.loadURL('http://localhost:19001/widget.html');

  // Track window resizing to dynamically scale content in real-time
  mainWindow.on('resize', () => {
    if (!mainWindow) return;
    const [width, height] = mainWindow.getSize();
    
    // Scale factor is computed based on window width
    const currentScale = width / 140;

    try {
      let config = {};
      if (fs.existsSync(CONFIG_FILE)) {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      }
      config.scale = parseFloat(currentScale.toFixed(2));
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');

      // Update state and broadcast config scale via WebSockets
      monitorServer.broadcastConfig(config);
    } catch (err) {
      console.error('[Electron] Failed to update scale on window resize:', err.message);
    }
  });

  // Track window movement to persist coordinates
  let saveTimeout = null;
  mainWindow.on('move', () => {
    if (!mainWindow) return;
    const [currX, currY] = mainWindow.getPosition();
    
    // Debounce position saves to avoid excessive disk I/O
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      savePosition(currX, currY);
    }, 500);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Hook into server process watcher triggers
// When Codex is detected, we can force-show the widget window!
monitorServer.onCodexDetected = () => {
  if (mainWindow) {
    if (!mainWindow.isVisible()) {
      console.log('[Electron] Codex process detected. Showing floating widget.');
      mainWindow.showInactive(); // shows without stealing focus
    } else {
      // Flash or shake window subtly to alert
      console.log('[Electron] Codex detected. Widget already active.');
    }
  } else {
    // Recreate if closed
    createWindow();
  }
};

// Hook into config updates to resize window dynamically (e.g. from browser dashboard)
monitorServer.onConfigUpdated = (newConfig) => {
  if (mainWindow) {
    const scale = parseFloat(newConfig.scale) || 1.0;
    const [currWidth, currHeight] = mainWindow.getSize();
    const newWidth = Math.round(140 * scale);
    const newHeight = Math.round(410 * scale);
    
    if (currWidth !== newWidth || currHeight !== newHeight) {
      console.log(`[Electron] Resizing widget window: ${currWidth}x${currHeight} -> ${newWidth}x${newHeight} (scale: ${scale})`);
      
      // Preserve current center position while resizing
      const [x, y] = mainWindow.getPosition();
      const newX = x + Math.round((currWidth - newWidth) / 2);
      const newY = y + Math.round((currHeight - newHeight) / 2);
      
      mainWindow.setBounds({
        x: newX,
        y: newY,
        width: newWidth,
        height: newHeight
      });
    }
  }
};

app.whenReady().then(() => {
  // Check for updates on startup
  autoUpdater.checkForUpdatesAndNotify();

  // Hide from Dock on Mac to make it feel like a lightweight system widget
  if (process.platform === 'darwin') {
    app.dock.hide();
  }

  createWindow();
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // On macOS it is common for applications to stay open until explicit Quit
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
