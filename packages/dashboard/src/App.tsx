import { useState, type ReactNode, useEffect } from 'react';
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
import { QuickChat } from './components/QuickChat.js';
import { Settings } from './components/Settings.js';
import { HealthPanel } from './components/HealthPanel.js';
import { LoginScreen } from './components/LoginScreen.js';
import {
  Target,
  Network,
  Kanban,
  Terminal,
  ShieldCheck,
  Brain,
  Wifi,
  WifiOff,
  LogOut,
  MessageSquare,
  Settings as SettingsIcon,
  Activity,
  Menu,
  X,
} from 'lucide-react';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 2 } },
});

// ─── Mobile detection hook ────────────────────────────────────────────────────

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return isMobile;
}

// ─── Nav ──────────────────────────────────────────────────────────────────────

type NavItem = {
  id: string;
  label: string;
  icon: ReactNode;
  mobileIcon?: ReactNode;
};

function Sidebar({
  active,
  onNavigate,
  onLogout,
  mobileOpen,
  onMobileClose,
}: {
  active: string;
  onNavigate: (id: string) => void;
  onLogout: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}) {
  const { connected, events } = useWebSocket();
  const isMobile = useIsMobile();

  const navItems: NavItem[] = [
    { id: 'chat', label: 'Quick Chat', icon: <MessageSquare size={18} /> },
    { id: 'mission', label: 'Mission Control', icon: <Target size={18} /> },
    { id: 'agents', label: 'Agent Network', icon: <Network size={18} /> },
    { id: 'tasks', label: 'Task Board', icon: <Kanban size={18} /> },
    { id: 'logs', label: 'Log Stream', icon: <Terminal size={18} /> },
    { id: 'approvals', label: 'Approvals', icon: <ShieldCheck size={18} /> },
    { id: 'health', label: 'Health System', icon: <Activity size={18} /> },
    { id: 'settings', label: 'Settings', icon: <SettingsIcon size={18} /> },
  ];

  const handleNav = (id: string) => {
    onNavigate(id);
    if (isMobile) onMobileClose();
  };

  // Mobile: overlay sidebar
  if (isMobile && !mobileOpen) return null;

  return (
    <>
      {/* Mobile overlay backdrop */}
      {isMobile && mobileOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onMobileClose}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            zIndex: 40,
          }}
        />
      )}

      <aside
        style={{
          width: isMobile ? 260 : 220,
          flexShrink: 0,
          background: 'rgba(13,17,23,0.98)',
          borderRight: '1px solid rgba(0,229,255,0.08)',
          display: 'flex',
          flexDirection: 'column',
          height: '100vh',
          position: isMobile ? 'fixed' : 'sticky',
          top: 0,
          left: 0,
          zIndex: isMobile ? 50 : 'auto',
          ...(isMobile
            ? { boxShadow: '4px 0 30px rgba(0,0,0,0.5)' }
            : {}),
        }}
      >
        {/* Logo + close button on mobile */}
        <div
          style={{
            padding: '20px 16px 16px',
            borderBottom: '1px solid rgba(0,229,255,0.08)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  background: 'linear-gradient(135deg, #00e5ff, #b84cff)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 0 20px rgba(0,229,255,0.3)',
                }}
              >
                <Brain size={18} color="#000" />
              </div>
              <div>
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 800,
                    color: 'white',
                    letterSpacing: '0.05em',
                  }}
                >
                  APEX
                </div>
                <div
                  style={{
                    fontSize: 9,
                    color: 'var(--color-apex-muted)',
                    marginTop: -1,
                  }}
                >
                  AI Workforce
                </div>
              </div>
            </div>
            {isMobile && (
              <button
                onClick={onMobileClose}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--color-apex-muted)',
                  cursor: 'pointer',
                  padding: 4,
                }}
              >
                <X size={20} />
              </button>
            )}
          </div>

          {/* Connection status */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 12,
              padding: '4px 10px',
              borderRadius: 6,
              background: connected
                ? 'rgba(0,255,136,0.08)'
                : 'rgba(255,59,92,0.08)',
              border: `1px solid ${connected ? 'rgba(0,255,136,0.2)' : 'rgba(255,59,92,0.2)'}`,
            }}
          >
            {connected ? (
              <Wifi size={12} color="#00ff88" />
            ) : (
              <WifiOff size={12} color="#ff3b5c" />
            )}
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: connected ? '#00ff88' : '#ff3b5c',
              }}
            >
              {connected ? 'LIVE' : 'RECONNECTING'}
            </span>
          </div>
        </div>

        {/* Nav */}
        <nav
          style={{
            flex: 1,
            padding: '10px 8px',
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
            overflowY: 'auto',
          }}
        >
          {navItems.map((item) => {
            const isActive = active === item.id;
            return (
              <button
                key={item.id}
                id={`nav-${item.id}`}
                onClick={() => handleNav(item.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: isMobile ? '12px 14px' : '10px 12px',
                  borderRadius: 8,
                  border: 'none',
                  cursor: 'pointer',
                  background: isActive ? 'rgba(0,229,255,0.1)' : 'transparent',
                  color: isActive ? '#00e5ff' : 'var(--color-apex-muted)',
                  fontFamily: 'var(--font-sans)',
                  fontSize: isMobile ? 14 : 13,
                  fontWeight: isActive ? 600 : 400,
                  transition: 'all 0.15s',
                  width: '100%',
                  textAlign: 'left',
                  borderLeft: isActive
                    ? '2px solid #00e5ff'
                    : '2px solid transparent',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      'rgba(255,255,255,0.04)';
                    (e.currentTarget as HTMLButtonElement).style.color =
                      'var(--color-apex-text)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLButtonElement).style.background =
                      'transparent';
                    (e.currentTarget as HTMLButtonElement).style.color =
                      'var(--color-apex-muted)';
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
        <div
          style={{
            padding: '12px 16px',
            borderTop: '1px solid rgba(0,229,255,0.08)',
            fontSize: 10,
            color: 'var(--color-apex-muted)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <div style={{ fontFamily: 'var(--font-mono)' }}>APEX v1.0.0</div>
          </div>
          <button
            onClick={onLogout}
            title="Log Out"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--color-apex-muted)',
              padding: '6px',
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255,59,92,0.1)';
              e.currentTarget.style.color = '#ff3b5c';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--color-apex-muted)';
            }}
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>
    </>
  );
}

// ─── Mobile Bottom Bar ────────────────────────────────────────────────────────

function MobileBottomBar({
  active,
  onNavigate,
}: {
  active: string;
  onNavigate: (id: string) => void;
}) {
  const quickNav = [
    { id: 'chat', icon: <MessageSquare size={20} />, label: 'Chat' },
    { id: 'mission', icon: <Target size={20} />, label: 'Mission' },
    { id: 'tasks', icon: <Kanban size={20} />, label: 'Tasks' },
    { id: 'agents', icon: <Network size={20} />, label: 'Agents' },
    { id: 'settings', icon: <SettingsIcon size={20} />, label: 'Settings' },
  ];

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        background: 'rgba(7,8,13,0.95)',
        backdropFilter: 'blur(12px)',
        borderTop: '1px solid rgba(0,229,255,0.08)',
        display: 'flex',
        justifyContent: 'space-around',
        padding: '6px 0 max(6px, env(safe-area-inset-bottom))',
        zIndex: 30,
      }}
    >
      {quickNav.map((item) => {
        const isActive = active === item.id;
        return (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2,
              padding: '6px 12px',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: isActive ? '#00e5ff' : 'var(--color-apex-muted)',
              fontFamily: 'var(--font-sans)',
              fontSize: 9,
              fontWeight: isActive ? 600 : 400,
              transition: 'color 0.15s',
              minWidth: 48,
            }}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

function AppContent({ onLogout }: { onLogout: () => void }) {
  const [activePage, setActivePage] = useState('chat');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const isMobile = useIsMobile();
  const { data: agents = [] } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents.list(),
    refetchInterval: 15000,
  });

  const pages: Record<string, ReactNode> = {
    chat: <QuickChat />,
    mission: <MissionControl />,
    agents: <AgentNetwork agents={agents} />,
    tasks: <TaskBoard />,
    logs: (
      <div
        className="glass-card"
        style={{
          height: isMobile ? 'calc(100vh - 160px)' : 'calc(100vh - 120px)',
          overflow: 'hidden',
        }}
      >
        <LogStream />
      </div>
    ),
    approvals: <ApprovalQueue />,
    health: <HealthPanel />,
    settings: <Settings />,
  };

  const pageTitles: Record<string, string> = {
    chat: '💬 Quick Chat',
    mission: '🎯 Mission Control',
    agents: '🤖 Agent Network',
    tasks: '📋 Task Board',
    logs: '🖥 Live Log Stream',
    approvals: '🛡 Approval Queue',
    health: '🩺 System Health & Observability',
    settings: '⚙️ Settings & Integrations',
  };

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        background: 'var(--color-apex-bg)',
      }}
    >
      {/* Sidebar — hidden on mobile unless menu open */}
      <AnimatePresence>
        <Sidebar
          active={activePage}
          onNavigate={setActivePage}
          onLogout={onLogout}
          mobileOpen={mobileMenuOpen}
          onMobileClose={() => setMobileMenuOpen(false)}
        />
      </AnimatePresence>

      {/* Main Content */}
      <main
        style={{
          flex: 1,
          overflow: 'auto',
          paddingBottom: isMobile ? 72 : 0,
        }}
      >
        {/* Header */}
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            padding: isMobile ? '12px 16px' : '16px 28px',
            background: 'rgba(7,8,13,0.9)',
            backdropFilter: 'blur(12px)',
            borderBottom: '1px solid rgba(0,229,255,0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          {isMobile && (
            <button
              onClick={() => setMobileMenuOpen(true)}
              style={{
                background: 'transparent',
                border: '1px solid rgba(0,229,255,0.12)',
                borderRadius: 8,
                padding: 8,
                cursor: 'pointer',
                color: 'var(--color-apex-text)',
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
              }}
            >
              <Menu size={18} />
            </button>
          )}
          <h1
            style={{
              margin: 0,
              fontSize: isMobile ? 16 : 20,
              fontWeight: 700,
              color: 'var(--color-apex-text)',
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {pageTitles[activePage]}
          </h1>
          <div
            style={{
              fontSize: 11,
              color: 'var(--color-apex-muted)',
              fontFamily: 'var(--font-mono)',
              flexShrink: 0,
              display: isMobile ? 'none' : 'block',
            }}
          >
            {new Date().toLocaleDateString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
            })}
          </div>
        </div>

        {/* Page Content */}
        <div style={{ padding: isMobile ? '16px' : '24px 28px' }}>
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

      {/* Mobile bottom nav */}
      {isMobile && (
        <MobileBottomBar active={activePage} onNavigate={setActivePage} />
      )}
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    const token = localStorage.getItem('apex_token');
    if (token) {
      setAuthed(true);
    }
    setLoading(false);
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('apex_token');
    setAuthed(false);
  };

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: '#07080d',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            color: '#00e5ff',
            fontFamily: 'var(--font-mono)',
            fontSize: '14px',
          }}
        >
          INITIALIZING APEX COMMAND CENTER...
        </div>
      </div>
    );
  }

  if (!authed) {
    return <LoginScreen onLogin={() => setAuthed(true)} />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <WebSocketProvider>
        <AppContent onLogout={handleLogout} />
      </WebSocketProvider>
    </QueryClientProvider>
  );
}
