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
const monitorServer = require('./server.js');

let mainWindow = null;
let CONFIG_FILE;
const WIDGET_BASE_WIDTH = 140;
const WIDGET_BASE_HEIGHT = 410;
const WIDGET_MIN_SCALE = 0.4;
const WIDGET_MAX_SCALE = 2.0;

function initConfigPath() {
  if (!CONFIG_FILE) {
    CONFIG_FILE = path.join(app.getPath('userData'), 'traffic-light-config.json');
  }
}

function getSavedPosition() {
  initConfigPath();
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
  initConfigPath();
  const savedPos = getSavedPosition();
  let x = savedPos ? savedPos.x : undefined;
  let y = savedPos ? savedPos.y : undefined;

  let scale = 1.0;
  let currentConfig = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      currentConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (currentConfig.scale !== undefined) {
        scale = parseFloat(currentConfig.scale) || 1.0;
      }
    } catch (e) {}
  }

  if (x === undefined || y === undefined) {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    x = width - Math.round((WIDGET_BASE_WIDTH * scale) + 40);
    y = (height - Math.round(WIDGET_BASE_HEIGHT * scale)) / 2;
  }

  mainWindow = new BrowserWindow({
    width: Math.round(WIDGET_BASE_WIDTH * scale),
    height: Math.round(WIDGET_BASE_HEIGHT * scale),
    x: x,
    y: y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true, 
    hasShadow: false, 
    skipTaskbar: true, 
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.setAspectRatio(WIDGET_BASE_WIDTH / WIDGET_BASE_HEIGHT);
  mainWindow.setMinimumSize(Math.round(WIDGET_BASE_WIDTH * WIDGET_MIN_SCALE), Math.round(WIDGET_BASE_HEIGHT * WIDGET_MIN_SCALE));
  mainWindow.setMaximumSize(Math.round(WIDGET_BASE_WIDTH * WIDGET_MAX_SCALE), Math.round(WIDGET_BASE_HEIGHT * WIDGET_MAX_SCALE));

  mainWindow.loadURL('http://localhost:19001/widget.html');

  mainWindow.webContents.on('did-finish-load', () => {
    monitorServer.broadcastConfig(currentConfig);
  });

  const { Menu, MenuItem } = require('electron');
  const contextMenu = new Menu();
  contextMenu.append(new MenuItem({
    label: '设置 (Settings)',
    click: () => { require('electron').shell.openExternal('http://localhost:19001'); }
  }));
  contextMenu.append(new MenuItem({ type: 'separator' }));
  contextMenu.append(new MenuItem({
    label: '退出应用 (Quit)',
    click: () => { app.quit(); }
  }));

  mainWindow.webContents.on('context-menu', (e) => {
    contextMenu.popup(mainWindow);
  });

  mainWindow.on('resize', () => {
    if (!mainWindow) return;
    const [width, height] = mainWindow.getSize();
    const currentScale = width / WIDGET_BASE_WIDTH;

    try {
      let config = {};
      if (fs.existsSync(CONFIG_FILE)) {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      }
      config.scale = parseFloat(currentScale.toFixed(2));
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
      monitorServer.broadcastConfig(config);
    } catch (err) {
      console.error('[Electron] Failed to update scale on window resize:', err.message);
    }
  });

  let saveTimeout = null;
  mainWindow.on('move', () => {
    if (!mainWindow) return;
    const [currX, currY] = mainWindow.getPosition();
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      savePosition(currX, currY);
    }, 500);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

monitorServer.onCodexDetected = () => {
  if (mainWindow) {
    if (!mainWindow.isVisible()) {
      mainWindow.showInactive();
    }
  } else {
    createWindow();
  }
};

monitorServer.onQuitRequested = () => {
  app.quit();
};

monitorServer.onConfigUpdated = (newConfig) => {
  if (mainWindow) {
    const scale = Math.max(WIDGET_MIN_SCALE, Math.min(WIDGET_MAX_SCALE, parseFloat(newConfig.scale) || 1.0));
    const [currWidth, currHeight] = mainWindow.getSize();
    const newWidth = Math.round(WIDGET_BASE_WIDTH * scale);
    const newHeight = Math.round(WIDGET_BASE_HEIGHT * scale);
    
    if (currWidth !== newWidth || currHeight !== newHeight) {
      const [x, y] = mainWindow.getPosition();
      const newX = x + Math.round((currWidth - newWidth) / 2);
      const newY = y + Math.round((currHeight - newHeight) / 2);
      mainWindow.setBounds({
        x: newX,
        y: newY,
        width: newWidth,
        height: newHeight
      }, true);
    }
  }
};

app.whenReady().then(() => {
  autoUpdater.checkForUpdatesAndNotify();
  if (process.platform === 'darwin') {
    app.dock.hide();
  }
  createWindow();
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
