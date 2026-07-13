// ─── Browser Session Manager ──────────────────────────────────────────────────
//
// Manages Playwright browser sessions for agent tool calls. Each session is a
// full browser context (isolated cookies/storage) with one active page.
// Sessions auto-close after a configurable idle timeout to prevent leaks.
//
// Playwright is lazily imported — the first browserLaunch call loads it. If
// playwright is not installed, tools surface a clear error rather than crashing.

import type { Browser, BrowserContext, Page } from 'playwright';

interface BrowserSession {
  id: string;
  context: BrowserContext;
  page: Page;
  createdAt: Date;
  lastUsedAt: Date;
  idleTimeout: ReturnType<typeof setTimeout>;
}

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

class BrowserSessionManager {
  private sessions = new Map<string, BrowserSession>();
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;

  /** Lazily launch the shared Playwright browser instance */
  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    // Avoid double-launch from concurrent calls
    if (this.launching) return this.launching;

    this.launching = (async () => {
      try {
        const pw = await import('playwright');
        const browser = await pw.chromium.launch({
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
          ],
        });
        this.browser = browser;
        return browser;
      } finally {
        this.launching = null;
      }
    })();

    return this.launching;
  }

  /** Create a new isolated browser session */
  async createSession(options?: {
    viewport?: { width: number; height: number };
    userAgent?: string;
  }): Promise<string> {
    const browser = await this.getBrowser();

    const { randomUUID } = await import('crypto');
    const id = randomUUID();

    const context = await browser.newContext({
      viewport: options?.viewport ?? { width: 1280, height: 720 },
      userAgent: options?.userAgent ?? 'APEX-QA-Agent/2.0 (Playwright)',
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();

    // Set reasonable defaults
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(30_000);

    const session: BrowserSession = {
      id,
      context,
      page,
      createdAt: new Date(),
      lastUsedAt: new Date(),
      idleTimeout: this.scheduleIdleClose(id),
    };

    this.sessions.set(id, session);
    return id;
  }

  /** Get a session by ID, refreshing its idle timer */
  getSession(sessionId: string): BrowserSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastUsedAt = new Date();
      clearTimeout(session.idleTimeout);
      session.idleTimeout = this.scheduleIdleClose(sessionId);
    }
    return session;
  }

  /** Close and clean up a session */
  async closeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    clearTimeout(session.idleTimeout);
    try {
      await session.context.close();
    } catch {
      // Context may already be closed
    }
    this.sessions.delete(sessionId);
    return true;
  }

  /** Close all sessions and the browser */
  async shutdown(): Promise<void> {
    for (const [id] of this.sessions) {
      await this.closeSession(id);
    }
    if (this.browser?.isConnected()) {
      await this.browser.close();
    }
    this.browser = null;
  }

  /** Get count of active sessions */
  get activeCount(): number {
    return this.sessions.size;
  }

  private scheduleIdleClose(sessionId: string): ReturnType<typeof setTimeout> {
    return setTimeout(async () => {
      console.warn(`[BrowserSession] Auto-closing idle session ${sessionId}`);
      await this.closeSession(sessionId);
    }, IDLE_TIMEOUT_MS);
  }
}

// Singleton
let _manager: BrowserSessionManager | null = null;

export function getBrowserSessionManager(): BrowserSessionManager {
  if (!_manager) {
    _manager = new BrowserSessionManager();
  }
  return _manager;
}

export type { BrowserSession };
