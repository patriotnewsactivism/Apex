import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { CostAndMonitoring, SingleCallLauncher, AutomationLauncher } from './SalesOpsPanel.js';
import { LeadCampaignsSection } from './CampaignsPanel.js';
import { EmailCampaignsPanel } from './EmailCampaignsPanel.js';
import { SmsPanel } from './SmsPanel.js';
import { Activity, PhoneCall, MessageSquare, Mail, Zap, Crosshair } from 'lucide-react';

// ─── Sales Operations — the one-stop shop ──────────────────────────────────
//
// Every outbound/inbound channel (calls, SMS, email) plus the levers that run
// them (manual one-off, campaign, full autonomy) live under this single nav
// destination, sub-divided by an in-page tab strip rather than scattered
// across separate top-level pages. Overview (live monitoring) is the default
// tab — the point of a "one-stop shop" is that oversight is the FIRST thing
// you see, not something you have to navigate to find.
//
// Each sub-tab is composed from a component that already existed elsewhere
// (SalesOpsPanel.tsx, CampaignsPanel.tsx, EmailCampaignsPanel.tsx) or, for
// SMS, was built fresh alongside this consolidation. Nothing here duplicates
// logic; this file is purely the tab shell + wiring.

type SubTab = 'overview' | 'calls' | 'sms' | 'email' | 'automation' | 'lead-campaigns';

const TABS: Array<{ id: SubTab; label: string; icon: ReactNode }> = [
  { id: 'overview', label: 'Overview', icon: <Activity size={14} /> },
  { id: 'calls', label: 'Calls', icon: <PhoneCall size={14} /> },
  { id: 'sms', label: 'SMS', icon: <MessageSquare size={14} /> },
  { id: 'email', label: 'Email', icon: <Mail size={14} /> },
  { id: 'automation', label: 'Automation', icon: <Zap size={14} /> },
  { id: 'lead-campaigns', label: 'Lead Campaigns', icon: <Crosshair size={14} /> },
];

/** The in-page tab strip. Plain buttons with exact-text labels — the mobile
 *  overflow guard clicks these the same way it clicks top-level nav items. */
function TabStrip({ active, onChange }: { active: SubTab; onChange: (tab: SubTab) => void }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        flexWrap: 'wrap',
        padding: 4,
        borderRadius: 8,
        background: 'rgba(0,0,0,0.2)',
        border: '1px solid var(--color-apex-line)',
      }}
    >
      {TABS.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '7px 12px',
              borderRadius: 6,
              border: 'none',
              cursor: 'pointer',
              background: isActive ? 'var(--color-apex-brass)' : 'transparent',
              color: isActive ? '#14120f' : 'var(--color-apex-muted)',
              fontFamily: 'var(--font-sans)',
              fontSize: 12.5,
              fontWeight: isActive ? 700 : 500,
              whiteSpace: 'nowrap',
              transition: 'background 0.12s, color 0.12s',
            }}
          >
            {tab.icon}
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** Load and compose the single Sales Operations destination: live monitoring
 *  always fetched (the Overview tab needs it, and the header strip could grow
 *  a persistent summary later), sub-tabs for every channel and lever. */
export function SalesOperationsPanel() {
  const [tab, setTab] = useState<SubTab>('overview');

  const { data: overview, isLoading, isError, error } = useQuery({
    queryKey: ['sales-ops-overview'],
    queryFn: () => api.salesOps.overview(),
    refetchInterval: 8000,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 24, minWidth: 0, overflowWrap: 'anywhere' }}>
      <TabStrip active={tab} onChange={setTab} />

      {/* Only Overview and Automation actually need the overview query — SMS,
          Email, Calls, and Lead Campaigns fetch their own data and must stay
          usable even while that one query is slow or erroring. */}
      {(tab === 'overview' || tab === 'automation') && isLoading && (
        <div className="glass-card" style={{ padding: 24, color: 'var(--color-apex-muted)', fontSize: 13 }}>
          Loading…
        </div>
      )}

      {(tab === 'overview' || tab === 'automation') && isError && (
        <div
          className="glass-card"
          style={{ padding: 24, color: 'var(--color-apex-red)', fontSize: 13, fontFamily: 'var(--font-mono)' }}
        >
          Failed to load: {error instanceof Error ? error.message : String(error)}
        </div>
      )}

      {tab === 'overview' && overview && <CostAndMonitoring data={overview} />}
      {tab === 'calls' && <SingleCallLauncher />}
      {tab === 'sms' && <SmsPanel />}
      {tab === 'email' && <EmailCampaignsPanel />}
      {tab === 'automation' && overview && <AutomationLauncher overview={overview} />}
      {tab === 'lead-campaigns' && <LeadCampaignsSection />}
    </div>
  );
}
