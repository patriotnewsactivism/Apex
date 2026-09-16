import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { MessageSquare, Phone } from 'lucide-react';
import { ChatPanel } from './QuickChat.js';
import { useIsMobile } from '../hooks/useIsMobile.js';
import type { LiveVoiceStatus } from '../hooks/useLiveVoiceCall.js';

// FloatingChat mounts ChatPanel ONCE, outside the page swap in App.tsx.
// That is the whole point: the chat (and any live voice call) survives
// navigation — Don can jump around Apex and keep talking. It also feeds the
// panel the page he is currently viewing, so the agent "sees his screen"
// (text chat gets the page name in its context; a live call receives
// mid-call context updates when the page changes).
//
// Shell behavior:
//  - Desktop: fixed bottom-right, 420px wide, cap min(72vh, 640px) tall.
//    The ChatPanel header doubles as a drag handle (pointer events,
//    clamped to the viewport) so it can be parked anywhere.
//  - Mobile: full-width bottom sheet sitting above the bottom nav.
//  - Minimized: collapses to a corner FAB — the panel keeps running behind
//    it (voice calls keep streaming audio); a pulsing dot marks an active
//    call. Nothing is unmounted, ever.
//  - Navigating to the "chat" page auto-expands the panel.

interface FloatingChatProps {
  pageId: string;
  pageTitle: string;
}

export function FloatingChat({ pageId, pageTitle }: FloatingChatProps) {
  const isMobile = useIsMobile();
  // Desktop starts open; mobile starts minimized so it doesn't cover
  // content on arrival (the Chat nav item or the FAB expands it).
  const [open, setOpen] = useState(!isMobile);
  const [voiceStatus, setVoiceStatus] = useState<LiveVoiceStatus>('idle');
  const shellRef = useRef<HTMLDivElement>(null);
  // Position once dragged: {left, top} in px. null = default docked corner.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origLeft: number; origTop: number } | null>(null);

  // Navigating to the Chat page brings the panel up.
  useEffect(() => {
    if (pageId === 'chat') setOpen(true);
  }, [pageId]);

  // Keep the shell inside the viewport across resizes.
  useEffect(() => {
    if (!pos) return;
    const clamp = () => {
      const el = shellRef.current;
      if (!el) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      setPos((prev) =>
        prev
          ? {
              left: Math.min(Math.max(8, prev.left), Math.max(8, window.innerWidth - w - 8)),
              top: Math.min(Math.max(8, prev.top), Math.max(8, window.innerHeight - h - 8)),
            }
          : prev,
      );
    };
    window.addEventListener('resize', clamp);
    clamp();
    return () => window.removeEventListener('resize', clamp);
  }, [pos]);

  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (isMobile) return; // touch scrolling owns pointer events on mobile
    if ((e.target as HTMLElement).closest('button')) return; // don't drag from a control
    const el = shellRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const origLeft = pos ? pos.left : rect.left;
    const origTop = pos ? pos.top : rect.top;
    dragRef.current = { startX: e.clientX, startY: e.clientY, origLeft, origTop };
    setPos({ left: origLeft, top: origTop });

    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const left = Math.min(
        Math.max(8, drag.origLeft + (ev.clientX - drag.startX)),
        Math.max(8, window.innerWidth - w - 8),
      );
      const top = Math.min(
        Math.max(8, drag.origTop + (ev.clientY - drag.startY)),
        Math.max(8, window.innerHeight - h - 8),
      );
      setPos({ left, top });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const liveCall = voiceStatus === 'live' || voiceStatus === 'connecting';

  if (!open) {
    return (
      <motion.button
        onClick={() => setOpen(true)}
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.94 }}
        aria-label="Open chat"
        style={{
          position: 'fixed',
          right: 16,
          bottom: isMobile ? 84 : 24,
          zIndex: 60,
          width: 54,
          height: 54,
          borderRadius: '50%',
          border: '1px solid rgba(90,158,174,0.3)',
          background: 'linear-gradient(135deg, rgba(90,158,174,0.25), rgba(139,126,200,0.18))',
          backdropFilter: 'blur(10px)',
          color: 'var(--color-apex-text)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
        }}
      >
        {liveCall ? <Phone size={20} /> : <MessageSquare size={20} />}
        {liveCall && (
          <motion.span
            animate={{ opacity: [1, 0.25, 1] }}
            transition={{ repeat: Infinity, duration: 1.4 }}
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: '#6a9f78',
              boxShadow: '0 0 8px #6a9f78',
            }}
          />
        )}
      </motion.button>
    );
  }

  const shellStyle: React.CSSProperties = isMobile
    ? {
        position: 'fixed',
        left: 8,
        right: 8,
        bottom: 76, // above the bottom nav
        height: 'min(58vh, 500px)',
        zIndex: 60,
      }
    : {
        position: 'fixed',
        ...(pos ? { left: pos.left, top: pos.top } : { right: 24, bottom: 24 }),
        width: 420,
        height: 'min(72vh, 640px)',
        zIndex: 60,
      };

  return (
    <div
      ref={shellRef}
      style={{
        ...shellStyle,
        borderRadius: 16,
        background: 'rgba(13,17,23,0.94)',
        border: '1px solid rgba(90,158,174,0.22)',
        backdropFilter: 'blur(14px)',
        boxShadow: '0 18px 60px rgba(0,0,0,0.5)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <ChatPanel
        pageId={pageId}
        pageTitle={pageTitle}
        onMinimize={() => setOpen(false)}
        onHeaderPointerDown={onHeaderPointerDown}
        onVoiceStatus={setVoiceStatus}
      />
    </div>
  );
}
