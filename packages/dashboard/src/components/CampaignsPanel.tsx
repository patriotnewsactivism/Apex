import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type CampaignProgress, type CampaignSegment } from '../lib/api.js';
import { useApexEvent } from '../hooks/useWebSocket.js';
import { Play, Pause, X, Plus, AlertTriangle, Target, ChevronDown, ChevronRight } from 'lucide-react';

// A lead hunt runs for hours across dozens of territory cells. The job of this
// screen is to answer three questions at a glance: how far along is it, what is
// it working right now, and has it silently died. A flat table of leads (which
// is all LeadsPanel could offer) answers none of them.

const STATUS_COLOR: Record<string, string> = {
  running: '#5a9eae',
  stalled: '#c45c66',
  paused: '#c9a84a',
  completed: '#6a9f78',
  completed_short: '#c9a84a',
  cancelled: '#7d8a91',
  failed: '#c45c66',
};

const SEGMENT_COLOR: Record<string, string> = {
  done: '#6a9f78',
  in_progress: '#c9a84a',
  pending: 'rgba(255,255,255,0.07)',
  exhausted: 'rgba(196,92,102,0.28)',
  failed: '#c45c66',
  cancelled: 'rgba(255,255,255,0.04)',
};

const STATUS_LABEL: Record<string, string> = {
  completed_short: 'came up short',
  in_progress: 'researching',
  exhausted: 'nothing new',
};

function label(status: string): string {
  return STATUS_LABEL[status] ?? status.replace(/_/g, ' ');
}

function formatEta(ms: number | null): string {
  if (ms === null) return '—';
  const min = Math.round(ms / 60_000);
  if (min < 1) return '<1 min';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}

function Bar({ value, color, height = 6 }: { value: number; color: string; height?: number }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 4, height, overflow: 'hidden' }}>
      <motion.div
        initial={false}
        animate={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
        transition={{ duration: 0.4 }}
        style={{ background: color, height: '100%', borderRadius: 4 }}
      />
    </div>
  );
}

/** The territory grid: one cell per (industry x city), grouped by industry.
 *  This is the "what is it working through" view — a progress bar alone cannot
 *  show that Dallas is done but Houston has not been touched. */
function SegmentGrid({ segments }: { segments: CampaignSegment[] }) {
  const byIndustry = new Map<string, CampaignSegment[]>();
  for (const s of segments) {
    const list = byIndustry.get(s.industry) ?? [];
    list.push(s);
    byIndustry.set(s.industry, list);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {[...byIndustry.entries()].map(([industry, cells]) => (
        <div key={industry} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div
            style={{
              width: 110,
              flex: 'none',
              textAlign: 'right',
              fontSize: 10,
              color: 'var(--color-apex-muted)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {industry}
          </div>
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
            {cells.map((cell) => (
              <div
                key={cell.id}
                title={
                  `${cell.industry} · ${cell.city}\n${label(cell.status)}` +
                  `\n${cell.saved} saved / ${cell.found} found / ${cell.duplicates} already known` +
                  (cell.lastError ? `\n\nLast error: ${cell.lastError}` : '')
                }
                style={{
                  width: 26,
                  height: 15,
                  borderRadius: 2,
                  background: SEGMENT_COLOR[cell.status] ?? 'rgba(255,255,255,0.07)',
                  border: cell.status === 'pending' ? '1px solid rgba(255,255,255,0.10)' : '1px solid transparent',
                  cursor: 'help',
                }}
              />
            ))}
          </div>
        </div>
      ))}
      <div
        style={{
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
          marginTop: 4,
          paddingLeft: 118,
          fontSize: 10,
          color: 'var(--color-apex-muted)',
        }}
      >
        {(['done', 'in_progress', 'pending', 'exhausted', 'failed'] as const).map((k) => (
          <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: 2,
                background: SEGMENT_COLOR[k],
                border: k === 'pending' ? '1px solid rgba(255,255,255,0.10)' : '1px solid transparent',
              }}
            />
            {label(k)}
          </span>
        ))}
      </div>
    </div>
  );
}

function CampaignCard({ campaign }: { campaign: CampaignProgress }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  const { data: detail } = useQuery({
    queryKey: ['campaign', campaign.campaignId],
    queryFn: () => api.campaigns.get(campaign.campaignId),
    enabled: expanded,
    refetchInterval: expanded ? 5000 : false,
  });

  const control = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'cancel') => api.campaigns.control(campaign.campaignId, action),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['campaigns'] });
      qc.invalidateQueries({ queryKey: ['campaign', campaign.campaignId] });
    },
  });

  const color = STATUS_COLOR[campaign.displayStatus] ?? '#7d8a91';
  const isLive = campaign.status === 'running' || campaign.status === 'paused';
  const stalled = campaign.displayStatus === 'stalled';

  return (
    <motion.div
      className="glass-card"
      style={{ padding: 18, borderColor: `${color}40` }}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <button
          onClick={() => setExpanded(!expanded)}
          style={{ background: 'none', border: 'none', color: 'var(--color-apex-muted)', cursor: 'pointer', padding: 0, marginTop: 2 }}
          aria-label={expanded ? 'Collapse territory' : 'Expand territory'}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-apex-text)' }}>{campaign.name}</div>
          <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', marginTop: 2 }}>
            {campaign.segmentsDone} of {campaign.segmentsTotal} segments worked
            {campaign.yieldPerSegment !== null && ` · ${campaign.yieldPerSegment.toFixed(1)} leads/segment`}
            {campaign.duplicatesSkipped > 0 && ` · ${campaign.duplicatesSkipped} already on file`}
          </div>
        </div>
        <span
          style={{
            padding: '3px 9px',
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            background: `${color}1f`,
            color,
            border: `1px solid ${color}55`,
            whiteSpace: 'nowrap',
          }}
        >
          {label(campaign.displayStatus)}
        </span>
      </div>

      {stalled && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 10px',
            marginBottom: 12,
            background: 'rgba(196,92,102,0.10)',
            border: '1px solid rgba(196,92,102,0.30)',
            borderRadius: 6,
            fontSize: 11,
            color: '#c45c66',
          }}
        >
          <AlertTriangle size={13} />
          No progress in over 15 minutes — the runner may be wedged, or every LLM provider may be down.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
            <span style={{ color: 'var(--color-apex-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
              <Target size={12} /> Leads found
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-apex-text)', fontWeight: 600 }}>
              {campaign.leadsSaved} / {campaign.targetLeads}
            </span>
          </div>
          <Bar value={campaign.leadProgress} color={color} height={7} />
        </div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
            <span style={{ color: 'var(--color-apex-muted)' }}>Territory covered</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-apex-muted)' }}>
              {Math.round(campaign.coverage * 100)}%
              {campaign.segmentsFailed > 0 && ` · ${campaign.segmentsFailed} failed`}
              {isLive && ` · ETA ${formatEta(campaign.etaMs)}`}
            </span>
          </div>
          <Bar value={campaign.coverage} color="rgba(255,255,255,0.22)" />
        </div>
      </div>

      {detail?.campaign.result && (
        <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', lineHeight: 1.55, marginBottom: 12 }}>
          {detail.campaign.result}
        </div>
      )}

      {isLive && (
        <div style={{ display: 'flex', gap: 8 }}>
          {campaign.status === 'running' ? (
            <button
              className="btn-secondary"
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
              onClick={() => control.mutate('pause')}
              disabled={control.isPending}
            >
              <Pause size={13} /> Pause
            </button>
          ) : (
            <button
              className="btn-primary"
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
              onClick={() => control.mutate('resume')}
              disabled={control.isPending}
            >
              <Play size={13} /> Resume
            </button>
          )}
          <button
            className="btn-danger"
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
            onClick={() => control.mutate('cancel')}
            disabled={control.isPending}
          >
            <X size={13} /> Cancel
          </button>
        </div>
      )}

      {expanded && (
        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          {detail ? (
            <SegmentGrid segments={detail.segments} />
          ) : (
            <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>Loading territory…</div>
          )}
        </div>
      )}
    </motion.div>
  );
}

function NewCampaignForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [industries, setIndustries] = useState('');
  const [cities, setCities] = useState('');
  const [target, setTarget] = useState('100');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.campaigns.create({
        name: name.trim(),
        industries: industries.split(',').map((s) => s.trim()).filter(Boolean),
        cities: cities.split(',').map((s) => s.trim()).filter(Boolean),
        targetLeads: Number(target) || 100,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['campaigns'] });
      onDone();
    },
    // The server rejects an oversized territory or an empty ICP with a real
    // explanation — show it rather than a generic failure.
    onError: (err: Error) => setError(err.message),
  });

  const industryCount = industries.split(',').filter((s) => s.trim()).length;
  const cityCount = cities.split(',').filter((s) => s.trim()).length;
  const segments = industryCount * cityCount;
  const ready = name.trim().length >= 3 && segments > 0;

  return (
    <motion.div className="glass-card" style={{ padding: 18 }} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input className="apex-input" placeholder="Campaign name, e.g. Texas HVAC Q3" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className="apex-input"
          placeholder="Industries, comma separated — HVAC, Plumbing, Roofing"
          value={industries}
          onChange={(e) => setIndustries(e.target.value)}
        />
        <input
          className="apex-input"
          placeholder="Cities, comma separated — Dallas TX, Houston TX, Austin TX"
          value={cities}
          onChange={(e) => setCities(e.target.value)}
        />
        <input
          className="apex-input"
          type="number"
          placeholder="Target leads"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        {segments > 0 && (
          <div style={{ fontSize: 11, color: segments > 200 ? '#c45c66' : 'var(--color-apex-muted)' }}>
            {industryCount} industries × {cityCount} cities = {segments} territory segments
            {segments > 200 && ' — over the 200 ceiling, split this into several campaigns'}
          </div>
        )}
        {error && <div style={{ fontSize: 11, color: '#c45c66' }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-primary" onClick={() => { setError(null); create.mutate(); }} disabled={!ready || create.isPending}>
            {create.isPending ? 'Starting…' : 'Start campaign'}
          </button>
          <button className="btn-secondary" onClick={onDone}>Cancel</button>
        </div>
      </div>
    </motion.div>
  );
}

export function CampaignsPanel() {
  const [showForm, setShowForm] = useState(false);
  const { data: campaigns = [], refetch } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api.campaigns.list(),
    refetchInterval: 5000,
  });

  // Polling alone makes an hours-long hunt look static between refreshes.
  useApexEvent('campaign:progress', () => refetch());
  useApexEvent('campaign:segment', () => refetch());
  useApexEvent('campaign:completed', () => refetch());
  useApexEvent('campaign:started', () => refetch());

  const live = campaigns.filter((c) => c.status === 'running' || c.status === 'paused');
  const finished = campaigns.filter((c) => c.status !== 'running' && c.status !== 'paused');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, color: 'var(--color-apex-muted)' }}>
          {live.length} active · {finished.length} finished
        </div>
        {!showForm && (
          <button
            className="btn-primary"
            style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}
            onClick={() => setShowForm(true)}
          >
            <Plus size={14} /> New campaign
          </button>
        )}
      </div>

      <AnimatePresence>{showForm && <NewCampaignForm onDone={() => setShowForm(false)} />}</AnimatePresence>

      {campaigns.length === 0 && !showForm && (
        <div
          style={{
            textAlign: 'center',
            color: 'var(--color-apex-muted)',
            padding: '60px 20px',
            border: '1px dashed rgba(255,255,255,0.08)',
            borderRadius: 12,
          }}
        >
          <div style={{ fontSize: 32, marginBottom: 8 }}>🎯</div>
          <div style={{ fontSize: 14, fontWeight: 500 }}>No lead campaigns yet</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            Start one here, or ask Apex directly: &ldquo;find me 200 HVAC companies across Texas&rdquo;
          </div>
        </div>
      )}

      {live.map((c) => <CampaignCard key={c.campaignId} campaign={c} />)}
      {finished.length > 0 && live.length > 0 && (
        <div style={{ fontSize: 10, color: 'var(--color-apex-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 6 }}>
          Finished
        </div>
      )}
      {finished.map((c) => <CampaignCard key={c.campaignId} campaign={c} />)}
    </div>
  );
}
