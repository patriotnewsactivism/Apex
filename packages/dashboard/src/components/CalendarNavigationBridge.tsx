import { useEffect } from 'react';
import { CalendarClock } from 'lucide-react';
import { useIsMobile } from '../hooks/useIsMobile.js';

function relabelScheduledNavigation() {
  const scheduled = document.getElementById('nav-scheduled');
  if (scheduled) {
    const textNode = Array.from(scheduled.childNodes).find(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
    );
    if (textNode && textNode.textContent?.trim() !== 'Calendar / Scheduler') {
      textNode.textContent = ' Calendar / Scheduler';
    }
    scheduled.setAttribute('aria-label', 'Calendar / Scheduler');
    scheduled.setAttribute('title', 'Calendar / Scheduler');
  }

  const title = document.querySelector('main header h1');
  if (title?.textContent?.trim() === 'Cron Registry') {
    title.textContent = 'Calendar / Scheduler';
  }
}

function navigateToScheduledPage() {
  const existing = document.getElementById('nav-scheduled') as HTMLButtonElement | null;
  if (existing) {
    existing.click();
    return;
  }

  // On mobile the sidebar is not mounted while closed. Open it, then use the
  // real App navigation button so activePage and FloatingChat page context stay
  // authoritative instead of maintaining a second router in this bridge.
  const menu = document.querySelector('button[aria-label="Open menu"]') as HTMLButtonElement | null;
  menu?.click();
  window.setTimeout(() => {
    const scheduled = document.getElementById('nav-scheduled') as HTMLButtonElement | null;
    scheduled?.click();
  }, 80);
}

export function CalendarNavigationBridge() {
  const isMobile = useIsMobile();

  useEffect(() => {
    relabelScheduledNavigation();
    const observer = new MutationObserver(() => relabelScheduledNavigation());
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  if (!isMobile) return null;

  return (
    <button
      type="button"
      onClick={navigateToScheduledPage}
      aria-label="Open Calendar and Scheduler"
      title="Calendar / Scheduler"
      style={{
        position: 'fixed',
        right: 12,
        bottom: 'calc(74px + env(safe-area-inset-bottom))',
        zIndex: 29,
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        minHeight: 42,
        padding: '8px 11px',
        borderRadius: 7,
        border: '1px solid var(--color-apex-brass)',
        background: 'rgba(17,19,24,0.96)',
        color: 'var(--color-apex-brass)',
        fontFamily: 'var(--font-sans)',
        fontSize: 11,
        fontWeight: 650,
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
      }}
    >
      <CalendarClock size={16} />
      Calendar
    </button>
  );
}
