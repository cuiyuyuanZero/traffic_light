#!/usr/bin/env node

/**
 * Codex Turn Ended Notification Hook
 * This script is executed by Codex when a turn ends.
 * It notifies the local Traffic Light Service server to turn the light green.
 */

const http = require('http');

// Default server port is 19001
const PORT = 19001;

const data = JSON.stringify({
  tool: 'codex',
  state: 'finished',
  timestamp: Date.now()
});

const options = {
  hostname: '127.0.0.1',
  port: PORT,
  path: '/api/event',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  },
  timeout: 1000 // 1 second timeout
};

console.log('[TrafficLightHook] Sending turn-ended event to Traffic Light Service...');

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    console.log(`[TrafficLightHook] Response status: ${res.statusCode}`);
    console.log(`[TrafficLightHook] Response: ${body}`);
    process.exit(0);
  });
});

req.on('error', (e) => {
  console.error(`[TrafficLightHook] Connection failed: ${e.message}`);
  console.log('[TrafficLightHook] Please make sure the Traffic Light Service is running (npm run start)');
  process.exit(0); // Exit gracefully so it doesn't block Codex
});

req.on('timeout', () => {
  console.error('[TrafficLightHook] Request timed out');
  req.destroy();
  process.exit(0);
});

req.write(data);
req.end();
