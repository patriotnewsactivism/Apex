import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { api, type ArtifactRow } from '../lib/api.js';
import { FileText, Download, ExternalLink, Search, Package } from 'lucide-react';

const KIND_COLORS: Record<string, string> = {
  document: 'var(--color-apex-green)',
  build: 'var(--color-apex-brass)',
  code: 'var(--color-apex-purple)',
  workspace: 'var(--color-apex-signal)',
  deployment: 'var(--color-apex-orange)',
  other: 'var(--color-apex-muted)',
};

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ArtifactsPanel() {
  const [kindFilter, setKindFilter] = useState('');
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['artifacts', kindFilter],
    queryFn: () => api.artifacts.list(kindFilter ? { kind: kindFilter } : undefined),
    refetchInterval: 15_000,
  });

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1200 }}>
      <div className="apex-toolbar" style={{ marginBottom: 18 }}>
        <div>
          <div className="apex-display" style={{ fontSize: 18, color: 'var(--color-apex-text)' }}>
            Durable artifact store
          </div>
          <div className="apex-eyebrow" style={{ marginTop: 4 }}>
            GCS bucket objects · result links on tasks
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            style={{
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid var(--color-apex-line)',
              color: 'var(--color-apex-text)',
              borderRadius: 5,
              padding: '7px 10px',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
            }}
            aria-label="Filter by kind"
          >
            <option value="">All kinds</option>
            {['document', 'build', 'code', 'workspace', 'deployment', 'other'].map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="glass-card" style={{ overflow: 'hidden' }}>
        {isLoading ? (
          <div className="apex-eyebrow" style={{ padding: 24 }}>Loading artifacts…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--color-apex-muted)' }}>
            <Package size={28} style={{ margin: '0 auto 10px', opacity: 0.5 }} />
            <div className="apex-eyebrow">No artifacts yet — agents publish via store_artifact</div>
          </div>
        ) : (
          <div style={{ maxHeight: 'calc(100vh - 260px)', overflowY: 'auto' }}>
            {rows.map((row: ArtifactRow, i: number) => (
              <motion.div
                key={row.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.02 }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 16px',
                  borderBottom: '1px solid var(--color-apex-line)',
                  background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                }}
              >
                <span
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 5,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(255,255,255,0.05)',
                    color: KIND_COLORS[row.kind] ?? 'var(--color-apex-muted)',
                    flexShrink: 0,
                  }}
                >
                  <FileText size={14} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      color: 'var(--color-apex-text)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {row.objectName}
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 3, fontSize: 10, color: 'var(--color-apex-muted)', fontFamily: 'var(--font-mono)' }}>
                    <span>{sizeLabel(row.sizeBytes)}</span>
                    {row.kind && <span style={{ color: KIND_COLORS[row.kind] }}>{row.kind}</span>}
                    {row.taskId && <span>task {row.taskId.slice(0, 8)}</span>}
                    {row.projectId && <span>{row.projectId}</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  {row.publicUrl && (
                    <a
                      href={row.publicUrl}
                      target="_blank"
                      rel="noreferrer"
                      title="Public link"
                      style={{ color: 'var(--color-apex-brass)', display: 'flex', alignItems: 'center' }}
                    >
                      <ExternalLink size={14} />
                    </a>
                  )}
                  <a
                    href={api.artifacts.downloadUrl(row.id)}
                    title="Download"
                    style={{ color: 'var(--color-apex-text)', display: 'flex', alignItems: 'center' }}
                  >
                    <Download size={14} />
                  </a>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      <div className="apex-eyebrow" style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Search size={11} />
        {rows.length} artifact{rows.length === 1 ? '' : 's'} in this view · durable across container recycle
      </div>
    </div>
  );
}