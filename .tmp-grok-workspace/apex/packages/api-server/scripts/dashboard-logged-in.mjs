import { spawn } from 'child_process';
import { WebSocket } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';

const DASHBOARD_URL = 'https://apex.donmatthews.live/';
const PASSWORD = process.env.APEX_ADMIN_PASSWORD;

if (!PASSWORD) {
  console.error('APEX_ADMIN_PASSWORD not set');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getToken() {
  const res = await fetch('https://apex.donmatthews.live/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const data = await res.json();
  if (!data.token) throw new Error('login failed: ' + JSON.stringify(data));
  return data.token;
}

async function cdpSend(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1_000_000);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 10_000);
    const listener = (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.id === id) {
          ws.off('message', listener);
          clearTimeout(timer);
          resolve(msg);
        }
      } catch {}
    };
    ws.on('message', listener);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  console.log('Getting token...');
  const token = await getToken();
  console.log('Token acquired');

  console.log('Launching headless Chrome...');
  const chrome = spawn(
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    [
      '--remote-debugging-port=9223',
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1280,720',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  try {
    let browserStarted = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await new Promise((resolve, reject) => {
          http.get('http://localhost:9223/json/version', (r) => {
            let b = '';
            r.on('data', (c) => (b += c));
            r.on('end', () => resolve(b));
          }).on('error', reject);
        });
        JSON.parse(res);
        browserStarted = true;
        break;
      } catch {
        await sleep(500);
      }
    }
    if (!browserStarted) throw new Error('Chrome did not start');

    console.log('Connecting to CDP...');
    const pageUrl = await new Promise((resolve, reject) => {
      http.get('http://localhost:9223/json/list', (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => {
          try {
            const list = JSON.parse(b);
            const page = list.find((p) => p.type === 'page');
            resolve(page.webSocketDebuggerUrl);
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });

    const ws = new WebSocket(pageUrl);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    console.log('Enabling CDP domains...');
    await cdpSend(ws, 'Runtime.enable');
    await cdpSend(ws, 'Page.enable');

    console.log('Navigating to dashboard...');
    await cdpSend(ws, 'Page.navigate', { url: DASHBOARD_URL });
    await sleep(3000);

    console.log('Setting localStorage token...');
    await cdpSend(ws, 'Runtime.evaluate', {
      expression: `localStorage.setItem('apex_token', ${JSON.stringify(token)});`,
      returnByValue: true,
    });

    console.log('Reloading to apply token...');
    await cdpSend(ws, 'Page.reload', { ignoreCache: true });
    await sleep(8000);

    console.log('Capturing screenshot...');
    const screenshot = await cdpSend(ws, 'Page.captureScreenshot', { format: 'png' });
    const outPath = path.resolve('C:\\Apex\\dashboard-logged-in.png');
    fs.writeFileSync(outPath, Buffer.from(screenshot.result.data, 'base64'));
    console.log('Screenshot saved to', outPath);

    ws.close();
  } finally {
    chrome.kill();
  }
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
