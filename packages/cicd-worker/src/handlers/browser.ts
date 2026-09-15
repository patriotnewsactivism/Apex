// ─── Browser check job handler (browser_check) ─────────────────────────────
//
// Ported from packages/core/src/tool-registry.ts's browserCheck tool
// definition (lines ~377-442 there). Same Playwright/Chromium approach.
//
// Behavior difference from the original (deliberate): the old code hard
// REQUIRED a system Chromium binary at /usr/bin/chromium-browser or
// /usr/bin/chromium and threw if neither existed -- because the prod image
// installs with --ignore-scripts, so Playwright's own bundled Chromium is
// never downloaded there. This worker isn't pinned to that image: on a dev
// machine neither path exists. Rather than hard-failing, it falls back to
// Playwright's bundled Chromium (undefined executablePath), which requires
// `npx playwright install chromium` to have been run once in that
// environment. A system binary at either path still wins, matching the
// original behavior exactly where one is present.
//
// Both paths stay in the list: the prod runtime image was Alpine
// (/usr/bin/chromium-browser) until 2026-09-15 and is Debian
// (/usr/bin/chromium) after it.
import { existsSync } from 'fs';

export interface BrowserCheckPayload {
  url: string;
  maxConsoleMessages?: number;
}

export interface BrowserCheckResult {
  url: string;
  status: number | null;
  loadError: string | null;
  title: string | null;
  consoleErrors: Array<{ type: string; text: string }>;
  pageErrors: string[];
  renderedSuccessfully: boolean;
}

export async function handleBrowserCheck(payload: BrowserCheckPayload): Promise<BrowserCheckResult> {
  const { chromium } = await import('playwright');

  const candidatePaths = ['/usr/bin/chromium-browser', '/usr/bin/chromium'];
  const executablePath = candidatePaths.find((p) => existsSync(p));

  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    const consoleMessages: { type: string; text: string }[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') {
        consoleMessages.push({ type: msg.type(), text: msg.text().slice(0, 300) });
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(String(err?.message || err).slice(0, 300));
    });

    let status: number | null = null;
    let loadError: string | null = null;
    try {
      const response = await page.goto(payload.url, { waitUntil: 'networkidle', timeout: 20000 });
      status = response ? response.status() : null;
    } catch (e: any) {
      loadError = String(e?.message || e).slice(0, 300);
    }

    const title = loadError ? null : await page.title().catch(() => null);
    const limit = payload.maxConsoleMessages ?? 20;

    return {
      url: payload.url,
      status,
      loadError,
      title,
      consoleErrors: consoleMessages.slice(0, limit),
      pageErrors: pageErrors.slice(0, limit),
      renderedSuccessfully: !loadError && status !== null && status < 400,
    };
  } finally {
    await browser.close();
  }
}
