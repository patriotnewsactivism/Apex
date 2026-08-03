import { useState, type ReactNode, useEffect, useMemo } from 'react';
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
import { LearningPanel } from './components/LearningPanel.js';
import { PipelinePanel } from './components/PipelinePanel.js';
import { MultiAppPanel } from './components/MultiAppPanel.js';
import { LeadsPanel } from './components/LeadsPanel.js';
import { ControlRoom } from './components/ControlRoom.js';
import { SuggestionsPanel } from './components/SuggestionsPanel.js';
import { LoginScreen } from './components/LoginScreen.js';
import {
  Target,
  Network,
  Kanban,
  Terminal,
  ShieldCheck,
  Wifi,
  WifiOff,
  LogOut,
  MessageSquare,
  Settings as SettingsIcon,
  Activity,
  GitBranch,
  FolderGit2,
  Menu,
  X,
  Search,
  SlidersHorizontal,
  Lightbulb,
  Brain,
} from 'lucide-react';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, retry: 2 } },
});

// ─── Mobile detection ─────────────────────────────────────────────────────────

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return isMobile;
}

// ─── Status helpers ───────────────────────────────────────────────────────────

const STATUS_DOT: Record<string, string> = {
  idle: 'var(--color-apex-muted)',
  thinking: 'var(--color-apex-signal)',
  acting: 'var(--color-apex-purple)',
  blocked: 'var(--color-apex-orange)',
  error: 'var(--color-apex-red)',
  done: 'var(--color-apex-green)',
};

function liveColor(status: string | undefined): string {
  return STATUS_DOT[status ?? 'idle'] ?? STATUS_DOT.idle;
}

// ─── Signature: live hierarchy spine ──────────────────────────────────────────
// Encodes the real org chart (CEO → CTO/COO), not decorative numbering.

function HierarchySpine({
  agents,
  agentStatuses,
}: {
  agents: { id: string; role: string; name: string; tier: number }[];
  agentStatuses: Record<string, string>;
}) {
  const byRole = useMemo(() => {
    const map: Record<string, { id: string; name: string; status: string }> = {};
    for (const a of agents) {
      const status = agentStatuses[a.id] ?? 'idle';
      map[a.role] = { id: a.id, name: a.name, status };
    }
    return map;
  }, [agents, agentStatuses]);

  const ceo = byRole['CEO'];
  const cto = byRole['CTO'];
  const coo = byRole['COO'];

  const Node = ({
    label,
    status,
    accent,
  }: {
    label: string;
    status?: string;
    accent?: boolean;
  }) => {
    const color = liveColor(status);
    const active = status === 'thinking' || status === 'acting';
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
        }}
        title={status ? `${label}: ${status}` : label}
      >
        <span
          style={{
            width: accent ? 9 : 7,
            height: accent ? 9 : 7,
            borderRadius: '50%',
            background: color,
            flexShrink: 0,
            boxShadow: active ? `0 0 0 3px ${color}33` : 'none',
            animation: active ? 'pulse-live 1.8s ease-in-out infinite' : 'none',
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.06em',
            color: accent ? 'var(--color-apex-brass)' : 'var(--color-apex-muted)',
            fontWeight: accent ? 600 : 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
      </div>
    );
  };

  return (
    <div
      style={{
        marginTop: 14,
        padding: '10px 12px',
        borderRadius: 6,
        background: 'rgba(0,0,0,0.22)',
        border: '1px solid var(--color-apex-line)',
      }}
    >
      <div className="apex-eyebrow" style={{ marginBottom: 10 }}>
        Org spine
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Node label="CEO" status={ceo?.status} accent />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 8,
            paddingLeft: 4,
            borderLeft: '1px solid var(--color-apex-line)',
            marginLeft: 3,
          }}
        >
          <Node label="CTO" status={cto?.status} />
          <Node label="COO" status={coo?.status} />
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--color-apex-muted)',
            paddingLeft: 12,
            marginTop: 2,
          }}
        >
          {agents.length > 0 ? `${agents.length} agents seated` : 'Waiting for roster'}
        </div>
      </div>
    </div>
  );
}

// ─── Nav ──────────────────────────────────────────────────────────────────────

type NavItem = {
  id: string;
  label: string;
  icon: ReactNode;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

function Sidebar({
  active,
  onNavigate,
  onLogout,
  mobileOpen,
  onMobileClose,
  agents,
}: {
  active: string;
  onNavigate: (id: string) => void;
  onLogout: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
  agents: { id: string; role: string; name: string; tier: number }[];
}) {
  const { connected, agentStatuses } = useWebSocket();
  const isMobile = useIsMobile();

  // Groups mirror real org concerns — not a flat icon dump
  const groups: NavGroup[] = [
    {
      label: 'Command',
      items: [
        { id: 'chat', label: 'Quick Chat', icon: <MessageSquare size={16} /> },
        { id: 'mission', label: 'Mission Control', icon: <Target size={16} /> },
        { id: 'approvals', label: 'Approvals', icon: <ShieldCheck size={16} /> },
      ],
    },
    {
      label: 'Workforce',
      items: [
        { id: 'agents', label: 'Agent Network', icon: <Network size={16} /> },
        { id: 'tasks', label: 'Task Board', icon: <Kanban size={16} /> },
        { id: 'logs', label: 'Log Stream', icon: <Terminal size={16} /> },
      ],
    },
    {
      label: 'Business',
      items: [
        { id: 'leads', label: 'Leads', icon: <Search size={16} /> },
        { id: 'suggestions', label: 'Suggestions', icon: <Lightbulb size={16} /> },
        { id: 'multiapp', label: 'Portfolio', icon: <FolderGit2 size={16} /> },
      ],
    },
    {
      label: 'Systems',
      items: [
        { id: 'control', label: 'Control Room', icon: <SlidersHorizontal size={16} /> },
        { id: 'health', label: 'Health', icon: <Activity size={16} /> },
        { id: 'learning', label: 'Intelligence', icon: <Brain size={16} /> },
        { id: 'pipeline', label: 'CI/CD', icon: <GitBranch size={16} /> },
        { id: 'settings', label: 'Settings', icon: <SettingsIcon size={16} /> },
      ],
    },
  ];

  const handleNav = (id: string) => {
    onNavigate(id);
    if (isMobile) onMobileClose();
  };

  if (isMobile && !mobileOpen) return null;

  return (
    <>
      {isMobile && mobileOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onMobileClose}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(8,10,14,0.72)',
            zIndex: 40,
          }}
        />
      )}

      <aside
        style={{
          width: isMobile ? 272 : 236,
          flexShrink: 0,
          background: 'var(--color-apex-surface)',
          borderRight: '1px solid var(--color-apex-line)',
          display: 'flex',
          flexDirection: 'column',
          height: '100vh',
          position: isMobile ? 'fixed' : 'sticky',
          top: 0,
          left: 0,
          zIndex: isMobile ? 50 : 'auto',
          ...(isMobile ? { boxShadow: '8px 0 40px rgba(0,0,0,0.45)' } : {}),
        }}
      >
        {/* Brand */}
        <div
          style={{
            padding: '18px 16px 14px',
            borderBottom: '1px solid var(--color-apex-line)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 6,
                  background: 'var(--color-apex-brass)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: 'var(--font-display)',
                  fontWeight: 800,
                  fontSize: 13,
                  color: '#14120f',
                  letterSpacing: '0.02em',
                }}
              >
                Ax
              </div>
              <div>
                <div
                  className="apex-display"
                  style={{
                    fontSize: 16,
                    color: 'var(--color-apex-text)',
                    lineHeight: 1.1,
                  }}
                >
                  APEX
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: 'var(--color-apex-muted)',
                    fontFamily: 'var(--font-mono)',
                    marginTop: 1,
                  }}
                >
                  Workforce desk
                </div>
              </div>
            </div>
            {isMobile && (
              <button
                onClick={onMobileClose}
                aria-label="Close menu"
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

          {/* Link status */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 12,
              padding: '5px 10px',
              borderRadius: 4,
              background: connected ? 'rgba(106,159,120,0.1)' : 'rgba(196,92,102,0.1)',
              border: `1px solid ${connected ? 'rgba(106,159,120,0.28)' : 'rgba(196,92,102,0.28)'}`,
            }}
          >
            {connected ? (
              <Wifi size={12} color="var(--color-apex-green)" />
            ) : (
              <WifiOff size={12} color="var(--color-apex-red)" />
            )}
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                fontFamily: 'var(--font-mono)',
                letterSpacing: '0.08em',
                color: connected ? 'var(--color-apex-green)' : 'var(--color-apex-red)',
              }}
            >
              {connected ? 'LIVE' : 'RECONNECTING'}
            </span>
          </div>

          {/* Signature element */}
          <HierarchySpine agents={agents} agentStatuses={agentStatuses} />
        </div>

        {/* Grouped nav */}
        <nav
          style={{
            flex: 1,
            padding: '10px 8px 16px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          {groups.map((group) => (
            <div key={group.label}>
              <div
                className="apex-eyebrow"
                style={{ padding: '0 10px 6px' }}
              >
                {group.label}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {group.items.map((item) => {
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
                        padding: isMobile ? '11px 12px' : '8px 12px',
                        borderRadius: 5,
                        border: 'none',
                        cursor: 'pointer',
                        background: isActive ? 'var(--color-apex-brass-soft)' : 'transparent',
                        color: isActive ? 'var(--color-apex-brass)' : 'var(--color-apex-muted)',
                        fontFamily: 'var(--font-sans)',
                        fontSize: isMobile ? 14 : 13,
                        fontWeight: isActive ? 600 : 450,
                        transition: 'background 0.12s, color 0.12s',
                        width: '100%',
                        textAlign: 'left',
                        borderLeft: isActive
                          ? '2px solid var(--color-apex-brass)'
                          : '2px solid transparent',
                      }}
                      onMouseEnter={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
                          e.currentTarget.style.color = 'var(--color-apex-text)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.background = 'transparent';
                          e.currentTarget.style.color = 'var(--color-apex-muted)';
                        }
                      }}
                    >
                      {item.icon}
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div
          style={{
            padding: '12px 14px',
            borderTop: '1px solid var(--color-apex-line)',
            fontSize: 10,
            color: 'var(--color-apex-muted)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ fontFamily: 'var(--font-mono)' }}>v1.0 · desk</div>
          <button
            onClick={onLogout}
            title="Log out"
            aria-label="Log out"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--color-apex-muted)',
              padding: 6,
              borderRadius: 5,
              display: 'flex',
              alignItems: 'center',
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(196,92,102,0.12)';
              e.currentTarget.style.color = 'var(--color-apex-red)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.color = 'var(--color-apex-muted)';
            }}
          >
            <LogOut size={15} />
          </button>
        </div>
      </aside>
    </>
  );
}

// ─── Mobile bottom bar ────────────────────────────────────────────────────────

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
        background: 'rgba(17,19,24,0.96)',
        backdropFilter: 'blur(12px)',
        borderTop: '1px solid var(--color-apex-line)',
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
              color: isActive ? 'var(--color-apex-brass)' : 'var(--color-apex-muted)',
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

// ─── Main app ─────────────────────────────────────────────────────────────────

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
    leads: <LeadsPanel />,
    control: <ControlRoom />,
    suggestions: <SuggestionsPanel />,
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
    learning: <LearningPanel />,
    pipeline: <PipelinePanel />,
    multiapp: <MultiAppPanel />,
    settings: <Settings />,
  };

  // Plain titles — no emoji decoration
  const pageTitles: Record<string, { title: string; kicker: string }> = {
    chat: { title: 'Quick Chat', kicker: 'Command' },
    mission: { title: 'Mission Control', kicker: 'Command' },
    agents: { title: 'Agent Network', kicker: 'Workforce' },
    tasks: { title: 'Task Board', kicker: 'Workforce' },
    leads: { title: 'Lead Pipeline', kicker: 'Business' },
    control: { title: 'Control Room', kicker: 'Systems' },
    suggestions: { title: 'Suggestions', kicker: 'Business' },
    logs: { title: 'Log Stream', kicker: 'Workforce' },
    approvals: { title: 'Approval Queue', kicker: 'Command' },
    health: { title: 'System Health', kicker: 'Systems' },
    learning: { title: 'Intelligence', kicker: 'Systems' },
    pipeline: { title: 'CI/CD Pipeline', kicker: 'Systems' },
    multiapp: { title: 'Portfolio', kicker: 'Business' },
    settings: { title: 'Settings', kicker: 'Systems' },
  };

  const meta = pageTitles[activePage] ?? { title: activePage, kicker: '' };

  return (
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        background: 'var(--color-apex-bg)',
      }}
    >
      <AnimatePresence>
        <Sidebar
          active={activePage}
          onNavigate={setActivePage}
          onLogout={onLogout}
          mobileOpen={mobileMenuOpen}
          onMobileClose={() => setMobileMenuOpen(false)}
          agents={agents}
        />
      </AnimatePresence>

      <main
        style={{
          flex: 1,
          overflow: 'auto',
          paddingBottom: isMobile ? 72 : 0,
        }}
      >
        <header
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            padding: isMobile ? '12px 16px' : '14px 28px',
            background: 'rgba(17,19,24,0.92)',
            backdropFilter: 'blur(10px)',
            borderBottom: '1px solid var(--color-apex-line)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          {isMobile && (
            <button
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open menu"
              style={{
                background: 'transparent',
                border: '1px solid var(--color-apex-line)',
                borderRadius: 6,
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
          <div style={{ flex: 1, minWidth: 0 }}>
            {!isMobile && meta.kicker && (
              <div className="apex-eyebrow" style={{ marginBottom: 2 }}>
                {meta.kicker}
              </div>
            )}
            <h1
              className="apex-display"
              style={{
                margin: 0,
                fontSize: isMobile ? 16 : 20,
                color: 'var(--color-apex-text)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontWeight: 700,
                letterSpacing: '0.02em',
              }}
            >
              {meta.title}
            </h1>
          </div>
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
        </header>

        <div style={{ padding: isMobile ? '16px' : '24px 28px' }}>
          <AnimatePresence mode="wait">
            <motion.div
              key={activePage}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.18 }}
            >
              {pages[activePage]}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

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
          background: 'var(--color-apex-bg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            color: 'var(--color-apex-brass)',
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            letterSpacing: '0.08em',
          }}
        >
          Opening desk…
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
