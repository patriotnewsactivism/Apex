import { useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api.js';
import { WebSocketProvider, useWebSocket } from './hooks/useWebSocket.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MissionControl } from './components/MissionControl.js';
import { AgentNetwork } from './components/AgentNetwork.js';
import { TaskBoard } from './components/TaskBoard.js';
import { LogStream } from './components/LogStream.js';
import { ApprovalQueue } from './components/ApprovalQueue.js';
import {
  Target,
  Network,
  Kanban,
  Terminal,
  ShieldCheck,
  Brain,
  Wifi,
  WifiOff,
} from 'lucide-react';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 2 } },
});

// ─── Nav ──────────────────────────────────────────────────────────────────────

type NavItem = {
  id: string;
  label: string;
  icon: ReactNode;
  badge?: () => ReactNode;
};

function Sidebar({
  active,
  onNavigate,
}: {
  active: string;
  onNavigate: (id: string) => void;
}) {
  const { connected, events } = useWebSocket();
  const pendingApprovals = events.filter((e) => e.type === 'approval:requested').length;

  const navItems: NavItem[] = [
    { id: 'mission', label: 'Mission Control', icon: <Target size={18} /> },
    { id: 'agents', label: 'Agent Network', icon: <Network size={18} /> },
    { id: 'tasks', label: 'Task Board', icon: <Kanban size={18} /> },
    { id: 'logs', label: 'Log Stream', icon: <Terminal size={18} /> },
    {
      id: 'approvals',
      label: 'Approvals',
      icon: <ShieldCheck size={18} />,
    },
  ];

  return (
    <aside
      style={{
        width: 220,
        flexShrink: 0,
        background: 'rgba(13,17,23,0.95)',
        borderRight: '1px solid rgba(0,229,255,0.08)',
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        position: 'sticky',
        top: 0,
      }}
    >
      {/* Logo */}
      <div style={{ padding: '24px 20px 20px', borderBottom: '1px solid rgba(0,229,255,0.08)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: 'linear-gradient(135deg, #00e5ff, #b84cff)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 20px rgba(0,229,255,0.3)',
            }}
          >
            <Brain size={20} color="#000" />
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: 'white', letterSpacing: '0.05em' }}>
              APEX
            </div>
            <div style={{ fontSize: 10, color: 'var(--color-apex-muted)', marginTop: -1 }}>
              AI Workforce
            </div>
          </div>
        </div>

        {/* Connection status */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 14,
            padding: '5px 10px',
            borderRadius: 6,
            background: connected ? 'rgba(0,255,136,0.08)' : 'rgba(255,59,92,0.08)',
            border: `1px solid ${connected ? 'rgba(0,255,136,0.2)' : 'rgba(255,59,92,0.2)'}`,
          }}
        >
          {connected ? <Wifi size={12} color="#00ff88" /> : <WifiOff size={12} color="#ff3b5c" />}
          <span style={{ fontSize: 10, fontWeight: 600, color: connected ? '#00ff88' : '#ff3b5c' }}>
            {connected ? 'LIVE' : 'RECONNECTING'}
          </span>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {navItems.map((item) => {
          const isActive = active === item.id;
          return (
            <button
              key={item.id}
              id={`nav-${item.id}`}
              onClick={() => onNavigate(item.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 8,
                border: 'none',
                cursor: 'pointer',
                background: isActive ? 'rgba(0,229,255,0.1)' : 'transparent',
                color: isActive ? '#00e5ff' : 'var(--color-apex-muted)',
                fontFamily: 'var(--font-sans)',
                fontSize: 13,
                fontWeight: isActive ? 600 : 400,
                transition: 'all 0.15s',
                width: '100%',
                textAlign: 'left',
                borderLeft: isActive ? '2px solid #00e5ff' : '2px solid transparent',
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)';
                  (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-apex-text)';
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                  (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-apex-muted)';
                }
              }}
            >
              {item.icon}
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div style={{ padding: '14px 20px', borderTop: '1px solid rgba(0,229,255,0.08)', fontSize: 10, color: 'var(--color-apex-muted)' }}>
        <div style={{ fontFamily: 'var(--font-mono)' }}>APEX v1.0.0</div>
        <div style={{ marginTop: 2 }}>Autonomous AI Workforce</div>
      </div>
    </aside>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

function AppContent() {
  const [activePage, setActivePage] = useState('mission');
  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents.list(),
    refetchInterval: 15000,
  });

  const pages: Record<string, ReactNode> = {
    mission: <MissionControl />,
    agents: <AgentNetwork agents={agents} />,
    tasks: <TaskBoard />,
    logs: (
      <div className="glass-card" style={{ height: 'calc(100vh - 120px)', overflow: 'hidden' }}>
        <LogStream />
      </div>
    ),
    approvals: <ApprovalQueue />,
  };

  const pageTitles: Record<string, string> = {
    mission: '🎯 Mission Control',
    agents: '🤖 Agent Network',
    tasks: '📋 Task Board',
    logs: '🖥 Live Log Stream',
    approvals: '🛡 Approval Queue',
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--color-apex-bg)' }}>
      {/* Sidebar */}
      <Sidebar active={activePage} onNavigate={setActivePage} />

      {/* Main Content */}
      <main style={{ flex: 1, overflow: 'auto' }}>
        {/* Header */}
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            padding: '16px 28px',
            background: 'rgba(7,8,13,0.9)',
            backdropFilter: 'blur(12px)',
            borderBottom: '1px solid rgba(0,229,255,0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <h1
            style={{
              margin: 0,
              fontSize: 20,
              fontWeight: 700,
              color: 'var(--color-apex-text)',
            }}
          >
            {pageTitles[activePage]}
          </h1>
          <div
            style={{
              fontSize: 11,
              color: 'var(--color-apex-muted)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
          </div>
        </div>

        {/* Page Content */}
        <div style={{ padding: '24px 28px' }}>
          <AnimatePresence mode="wait">
            <motion.div
              key={activePage}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              {pages[activePage]}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WebSocketProvider>
        <AppContent />
      </WebSocketProvider>
    </QueryClientProvider>
  );
}
