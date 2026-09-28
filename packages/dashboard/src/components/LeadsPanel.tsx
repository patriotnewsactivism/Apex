import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { api, type ResearchedLead } from '../lib/api.js';
import { Download, RefreshCw, ChevronDown, ChevronRight, ExternalLink, Filter, Mail, Phone, Upload } from 'lucide-react';
import { useApexEvent } from '../hooks/useWebSocket.js';

const STATUS_COLORS: Record<string, string> = {
  new: '#5a9eae',
  contacted: '#c9a84a',
  qualified: '#6a9f78',
  rejected: '#c45c66',
};

const STATUS_BG: Record<string, string> = {
  new: 'rgba(90,158,174,0.1)',
  contacted: 'rgba(201,168,74,0.1)',
  qualified: 'rgba(106,159,120,0.1)',
  rejected: 'rgba(196,92,102,0.1)',
};

const PIPELINE_LABELS: Record<string, string> = {
  DISCOVERED: 'Discovered',
  BASIC_ENRICHMENT: 'Basic',
  CONTACT_FOUND: 'Contact',
  QUALIFIED: 'Qualified',
  DEEP_RESEARCH: 'Research',
  CAMPAIGN_READY: 'Campaign',
};

const PIPELINE_COLORS: Record<string, string> = {
  DISCOVERED: '#5a9eae',
  BASIC_ENRICHMENT: '#7b8ab8',
  CONTACT_FOUND: '#c9a84a',
  QUALIFIED: '#6a9f78',
  DEEP_RESEARCH: '#b77f5f',
  CAMPAIGN_READY: '#d7b66a',
};

export function LeadsPanel() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [pipelineFilter, setPipelineFilter] = useState<string>('');
  const [industryFilter, setIndustryFilter] = useState<string>('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [provider, setProvider] = useState('apollo');
  const [overwrite, setOverwrite] = useState(false);
  const importPreview = useMutation({
    mutationFn: () => api.leads.importPreview({ csv: importText, provider, overwrite }),
  });
  const importCommit = useMutation({
    mutationFn: () => api.leads.importCommit({ csv: importText, provider, overwrite }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['leadStats'] });
    },
  });

  const { data: leads = [], isLoading, refetch } = useQuery({
    queryKey: ['leads', statusFilter, pipelineFilter, industryFilter],
    queryFn: () => api.leads.list({
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(pipelineFilter ? { pipelineState: pipelineFilter } : {}),
      ...(industryFilter ? { industry: industryFilter } : {}),
      limit: 500,
    }),
    refetchInterval: 5000,
  });

  const { data: stats } = useQuery({
    queryKey: ['leadStats'],
    queryFn: () => api.leads.stats(),
    refetchInterval: 10000,
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.leads.updateStatus(id, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['leadStats'] });
    },
  });

  useApexEvent('lead:discovered', () => {
    queryClient.invalidateQueries({ queryKey: ['leads'] });
    queryClient.invalidateQueries({ queryKey: ['leadStats'] });
  });

  useApexEvent('lead:state', () => {
    queryClient.invalidateQueries({ queryKey: ['leads'] });
    queryClient.invalidateQueries({ queryKey: ['leadStats'] });
  });

  const handleExport = async () => {
    const blob = await api.leads.exportCsv();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `apex-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const industries = leads.length > 0
    ? [...new Set(leads.map((l) => l.industry || 'Unknown'))].sort()
    : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Stats bar */}
      <div
        className="glass-card"
        style={{
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
          padding: '12px 16px',
          alignItems: 'center',
        }}
      >
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-apex-text)' }}>
            {stats?.contactReady ?? stats?.total ?? leads.length} Contact-ready prospects
          </div>
          {stats && (
            <div style={{ marginTop: 3, fontSize: 10, color: 'var(--color-apex-muted)' }}>
              {stats.rawCandidates.toLocaleString()} raw candidates · {stats.pendingOrUnverified.toLocaleString()} pending verification/contact · {stats.rejected.toLocaleString()} rejected
            </div>
          )}
        </div>
        {stats && (
          <>
            {Object.entries(stats.byPipelineState ?? {}).map(([status, count]) => (
              <div
                key={status}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 10px',
                  borderRadius: 6,
                  background: `${PIPELINE_COLORS[status] ?? '#666'}18`,
                  border: `1px solid ${PIPELINE_COLORS[status] ?? '#666'}33`,
                }}
              >
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: PIPELINE_COLORS[status] ?? '#666' }} />
                <span style={{ fontSize: 11, color: PIPELINE_COLORS[status] ?? '#999', fontWeight: 600, textTransform: 'uppercase' }}>
                  {PIPELINE_LABELS[status] ?? status}: {count}
                </span>
              </div>
            ))}
          </>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={() => setImportOpen((open) => !open)}
            style={{
              background: 'transparent',
              border: '1px solid rgba(90,158,174,0.15)',
              borderRadius: 6,
              padding: '6px 12px',
              color: 'var(--color-apex-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
            }}
          >
            <Upload size={13} /> Import
          </button>
          <button
            onClick={() => setShowFilters(!showFilters)}
            style={{
              background: 'transparent',
              border: '1px solid rgba(90,158,174,0.15)',
              borderRadius: 6,
              padding: '6px 12px',
              color: 'var(--color-apex-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
            }}
          >
            <Filter size={14} /> Filters
          </button>
          <button
            onClick={() => refetch()}
            style={{
              background: 'transparent',
              border: '1px solid rgba(90,158,174,0.15)',
              borderRadius: 6,
              padding: '6px 10px',
              color: 'var(--color-apex-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
            }}
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={handleExport}
            style={{
              background: 'rgba(90,158,174,0.1)',
              border: '1px solid rgba(90,158,174,0.3)',
              borderRadius: 6,
              padding: '6px 12px',
              color: '#5a9eae',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      {importOpen && (
        <div className="glass-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13 }}>Import a CSV you already enriched. Extra columns are kept. Nothing is emailed or called.</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
              placeholder="Provider name, for example apollo"
              style={{ flex: '1 1 160px', minWidth: 0, padding: '8px 10px', borderRadius: 6, border: '1px solid var(--color-apex-line)', background: 'rgba(0,0,0,0.28)', color: 'var(--color-apex-text)' }}
            />
            <label style={{ fontSize: 12, color: 'var(--color-apex-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={overwrite} onChange={(event) => setOverwrite(event.target.checked)} />
              Overwrite existing angles
            </label>
          </div>
          <textarea
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            placeholder={'Company Name,Email,Phone,Decision Maker,Title\nNorthside Dental,ada@northside.example,+17135550100,Ada Lopez,Owner'}
            rows={6}
            style={{ width: '100%', boxSizing: 'border-box', padding: 10, borderRadius: 6, border: '1px solid var(--color-apex-line)', background: 'rgba(0,0,0,0.28)', color: 'var(--color-apex-text)', fontFamily: 'var(--font-mono)', fontSize: 12 }}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-secondary" onClick={() => importPreview.mutate()} disabled={!importText.trim() || importPreview.isPending}>Preview</button>
            <button className="btn-primary" onClick={() => importCommit.mutate()} disabled={!importPreview.data || importCommit.isPending}>Import</button>
          </div>
          {importPreview.data && (
            <div style={{ fontSize: 12, color: 'var(--color-apex-muted)' }}>
              {importPreview.data.counts.created} new · {importPreview.data.counts.updated} updates · {importPreview.data.counts.skipped} skipped
              {importCommit.data?.committed ? ` · wrote ${importCommit.data.written}` : ''}
            </div>
          )}
          {(importPreview.isError || importCommit.isError) && (
            <div style={{ fontSize: 12, color: 'var(--color-apex-red)' }}>
              {(importPreview.error ?? importCommit.error) instanceof Error
                ? ((importPreview.error ?? importCommit.error) as Error).message
                : 'Import failed'}
            </div>
          )}
        </div>
      )}

      {/* Filter bar */}
      {showFilters && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="glass-card"
          style={{ padding: '12px 16px', display: 'flex', gap: 12, flexWrap: 'wrap' }}
        >
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{
              background: 'rgba(13,17,23,0.8)',
              border: '1px solid rgba(90,158,174,0.15)',
              borderRadius: 6,
              padding: '6px 10px',
              color: 'var(--color-apex-text)',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            <option value="">All Statuses</option>
            <option value="new">New</option>
            <option value="contacted">Contacted</option>
            <option value="qualified">Qualified</option>
            <option value="rejected">Rejected</option>
          </select>
          <select
            value={pipelineFilter}
            onChange={(e) => setPipelineFilter(e.target.value)}
            style={{
              background: 'rgba(13,17,23,0.8)',
              border: '1px solid rgba(90,158,174,0.15)',
              borderRadius: 6,
              padding: '6px 10px',
              color: 'var(--color-apex-text)',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            <option value="">All Pipeline States</option>
            {Object.entries(PIPELINE_LABELS).map(([state, label]) => (
              <option key={state} value={state}>{label}</option>
            ))}
          </select>
          <select
            value={industryFilter}
            onChange={(e) => setIndustryFilter(e.target.value)}
            style={{
              background: 'rgba(13,17,23,0.8)',
              border: '1px solid rgba(90,158,174,0.15)',
              borderRadius: 6,
              padding: '6px 10px',
              color: 'var(--color-apex-text)',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            <option value="">All Industries</option>
            {industries.map((ind) => (
              <option key={ind} value={ind}>{ind}</option>
            ))}
          </select>
          {(statusFilter || pipelineFilter || industryFilter) && (
            <button
              onClick={() => { setStatusFilter(''); setPipelineFilter(''); setIndustryFilter(''); }}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#c45c66',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              Clear filters
            </button>
          )}
        </motion.div>
      )}

      {/* Leads table */}
      <div className="glass-card" style={{ overflow: 'hidden' }}>
        {isLoading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#5a9eae', fontSize: 13 }}>
            Loading leads...
          </div>
        ) : leads.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-apex-muted)', fontSize: 13 }}>
            No leads found. Submit a goal to the CEO to start research.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(90,158,174,0.1)' }}>
                  <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--color-apex-muted)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase' }}></th>
                  <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--color-apex-muted)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase' }}>Company</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--color-apex-muted)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase' }}>Industry</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--color-apex-muted)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase' }}>City</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--color-apex-muted)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase' }}>Contact</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--color-apex-muted)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase' }}>Pipeline</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--color-apex-muted)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase' }}>Status</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--color-apex-muted)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase' }}>Outreach Angle</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => {
                  const isExpanded = expandedId === lead.id;
                  return (
                    <>
                      <motion.tr
                        key={lead.id}
                        layout
                        onClick={() => setExpandedId(isExpanded ? null : lead.id)}
                        style={{
                          cursor: 'pointer',
                          borderBottom: '1px solid rgba(255,255,255,0.03)',
                          background: isExpanded ? 'rgba(90,158,174,0.03)' : 'transparent',
                        }}
                        whileHover={{ background: 'rgba(90,158,174,0.03)' }}
                      >
                        <td style={{ padding: '8px 12px', color: 'var(--color-apex-muted)' }}>
                          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </td>
                        <td style={{ padding: '8px 12px' }}>
                          <div style={{ fontWeight: 600, color: 'var(--color-apex-text)' }}>{lead.companyName}</div>
                          {lead.website && (
                            <a
                              href={lead.website}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              style={{
                                fontSize: 10,
                                color: '#5a9eae',
                                textDecoration: 'none',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 3,
                                marginTop: 2,
                              }}
                            >
                              <ExternalLink size={10} /> {lead.website.replace(/^https?:\/\//, '').slice(0, 35)}
                            </a>
                          )}
                        </td>
                        <td style={{ padding: '8px 12px', color: 'var(--color-apex-muted)' }}>{lead.industry || '—'}</td>
                        <td style={{ padding: '8px 12px', color: 'var(--color-apex-muted)' }}>{lead.city || '—'}</td>
                        <td style={{ padding: '8px 12px', color: 'var(--color-apex-muted)' }}>
                          <div style={{ fontWeight: 600, color: 'var(--color-apex-text)' }}>{lead.decisionMakerName || 'Decision maker pending'}</div>
                          {lead.contactEmail && <a href={`mailto:${lead.contactEmail}`} onClick={(e) => e.stopPropagation()} style={{ color: '#5a9eae', display: 'flex', gap: 4, alignItems: 'center' }}><Mail size={10} />{lead.contactEmail}</a>}
                          {lead.contactPhone && <a href={`tel:${lead.contactPhone}`} onClick={(e) => e.stopPropagation()} style={{ color: '#5a9eae', display: 'flex', gap: 4, alignItems: 'center' }}><Phone size={10} />{lead.contactPhone}</a>}
                          {!lead.contactEmail && !lead.contactPhone && <span style={{ fontSize: 10, textTransform: 'uppercase' }}>{lead.contactResearchStatus}</span>}
                        </td>
                        <td style={{ padding: '8px 12px' }}>
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '3px 7px',
                              borderRadius: 4,
                              background: `${PIPELINE_COLORS[lead.pipelineState] ?? '#666'}18`,
                              border: `1px solid ${PIPELINE_COLORS[lead.pipelineState] ?? '#666'}44`,
                              color: PIPELINE_COLORS[lead.pipelineState] ?? '#999',
                              fontSize: 10,
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: PIPELINE_COLORS[lead.pipelineState] ?? '#666' }} />
                            {PIPELINE_LABELS[lead.pipelineState] ?? lead.pipelineState}
                          </span>
                        </td>
                        <td style={{ padding: '8px 12px' }}>
                          <select
                            value={lead.status}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              e.stopPropagation();
                              updateStatus.mutate({ id: lead.id, status: e.target.value });
                            }}
                            style={{
                              background: STATUS_BG[lead.status] ?? 'rgba(255,255,255,0.05)',
                              border: `1px solid ${STATUS_COLORS[lead.status] ?? '#666'}44`,
                              borderRadius: 4,
                              padding: '2px 6px',
                              color: STATUS_COLORS[lead.status] ?? '#999',
                              fontSize: 10,
                              fontWeight: 600,
                              cursor: 'pointer',
                              textTransform: 'uppercase',
                            }}
                          >
                            <option value="new">New</option>
                            <option value="contacted">Contacted</option>
                            <option value="qualified">Qualified</option>
                            <option value="rejected">Rejected</option>
                          </select>
                        </td>
                        <td style={{ padding: '8px 12px', color: 'var(--color-apex-muted)', maxWidth: 300 }}>
                          <div style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            fontSize: 11,
                          }}>
                            {lead.outreachAngle || '—'}
                          </div>
                        </td>
                      </motion.tr>
                      {isExpanded && (
                        <tr key={`${lead.id}-detail`}>
                          <td colSpan={8} style={{ padding: '12px 24px', background: 'rgba(0,0,0,0.2)' }}>
                            <div className="apex-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                              <div>
                                <div style={{ fontSize: 10, color: 'var(--color-apex-muted)', textTransform: 'uppercase', fontWeight: 600, marginBottom: 4 }}>
                                  Fit Reason
                                </div>
                                <div style={{ fontSize: 12, color: 'var(--color-apex-text)', lineHeight: 1.5 }}>
                                  {lead.fitReason}
                                </div>
                              </div>
                              <div>
                                <div style={{ fontSize: 10, color: 'var(--color-apex-muted)', textTransform: 'uppercase', fontWeight: 600, marginBottom: 4 }}>
                                  Outreach Angle
                                </div>
                                <div style={{ fontSize: 12, color: 'var(--color-apex-text)', lineHeight: 1.5 }}>
                                  {lead.outreachAngle || '—'}
                                </div>
                              </div>
                            </div>
                            <div style={{ marginTop: 8, fontSize: 10, color: 'var(--color-apex-muted)' }}>
                              Pipeline: {PIPELINE_LABELS[lead.pipelineState] ?? lead.pipelineState}
                              {lead.qualificationScore != null ? ` · Score: ${lead.qualificationScore}` : ''}
                              {' · '}
                              Researched: {new Date(lead.createdAt).toLocaleString()} · ID: {lead.id.slice(0, 8)}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
