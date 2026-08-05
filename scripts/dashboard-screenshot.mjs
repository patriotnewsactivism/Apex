import { WebSocket } from 'ws';
import http from 'http';
import fs from 'fs';

const DASHBOARD_URL = 'https://apex.donmatthews.live/';
const PASSWORD = process.env.APEX_ADMIN_PASSWORD;

if (!PASSWORD) {
  console.error('APEX_ADMIN_PASSWORD not set');
  process.exit(1);
}

function cdpRequest(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1000000);
    const listener = (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.id === id) {
          ws.off('message', listener);
          resolve(msg);
        }
      } catch {}
    };
    ws.on('message', listener);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function getToken() {
  const res = await fetch('https://apex.donmatthews.live/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const data = await res.json();
  if (!data.token) throw new Error('login failed');
  return data.token;
}

async function getPageWsUrl() {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:9222/json/list', (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          const list = JSON.parse(body);
          const page = list.find((p) => p.type === 'page');
          resolve(page.webSocketDebuggerUrl);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const token = await getToken();

  const pageWsUrl = await getPageWsUrl();
  const ws = new WebSocket(pageWsUrl);

  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  // Enable domains
  await cdpRequest(ws, 'Runtime.enable');
  await cdpRequest(ws, 'Page.enable');
  await cdpRequest(ws, 'Network.enable');

  // Navigate to dashboard to set origin, then set localStorage token
  await cdpRequest(ws, 'Page.navigate', { url: DASHBOARD_URL });
  await sleep(2000);

  // Set token in localStorage
  await cdpRequest(ws, 'Runtime.evaluate', {
    expression: `localStorage.setItem('apex_token', ${JSON.stringify(token)}); 'done';`,
    returnByValue: true,
  });

  // Reload to apply token
  await cdpRequest(ws, 'Page.reload', { ignoreCache: true });
  await sleep(5000);

  // Capture screenshot
  const screenshot = await cdpRequest(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('C:\\Apex\\dashboard-logged-in.png', Buffer.from(screenshot.result.data, 'base64'));

  console.log('Screenshot saved to dashboard-logged-in.png');
  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
