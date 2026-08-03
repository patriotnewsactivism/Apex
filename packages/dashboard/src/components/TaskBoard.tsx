import { useState } from 'react';
import { motion } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { useApexEvent } from '../hooks/useWebSocket.js';
import type { Task } from '../lib/api.js';

const STATUS_COLUMNS = [
  { key: 'pending', label: 'Pending', color: '#64748b' },
  { key: 'in_progress', label: 'In Progress', color: '#5a9eae' },
  { key: 'awaiting_approval', label: 'Needs Approval', color: '#c9a84a' },
  { key: 'blocked', label: 'Blocked', color: '#c4894a' },
  { key: 'done', label: 'Done', color: '#6a9f78' },
  { key: 'failed', label: 'Failed', color: '#c45c66' },
];

function TaskCard({ task }: { task: Task }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <motion.div
      className="glass-card"
      style={{ padding: '12px 14px', cursor: 'pointer' }}
      onClick={() => setExpanded((p) => !p)}
      layout
      whileHover={{ scale: 1.01 }}
      transition={{ duration: 0.2 }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--color-apex-text)' }}>
        {task.title}
      </div>
      {task.assignedAgentId && (
        <div
          style={{
            fontSize: 10,
            color: '#5a9eae',
            fontFamily: 'var(--font-mono)',
            opacity: 0.7,
            marginBottom: 6,
          }}
        >
          → {task.assignedAgentId.replace('apex-', '').replace('-001', '')}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: 9,
            padding: '2px 6px',
            borderRadius: 4,
            background: 'rgba(90,158,174,0.1)',
            color: '#5a9eae',
            fontFamily: 'var(--font-mono)',
          }}
        >
          P{task.priority}
        </span>
        <span
          style={{
            fontSize: 9,
            padding: '2px 6px',
            borderRadius: 4,
            background: 'rgba(255,255,255,0.05)',
            color: 'var(--color-apex-muted)',
          }}
        >
          {new Date(task.createdAt).toLocaleDateString('en-US', { timeZone: 'America/Chicago' })}
        </span>
      </div>
      {expanded && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.06)' }}
        >
          <div style={{ fontSize: 11, color: 'var(--color-apex-muted)', lineHeight: 1.6 }}>
            {task.description.slice(0, 300)}
            {task.description.length > 300 && '...'}
          </div>
          {task.result && (
            <div
              style={{
                marginTop: 8,
                fontSize: 11,
                color: '#6a9f78',
                fontFamily: 'var(--font-mono)',
                background: 'rgba(106,159,120,0.05)',
                padding: '8px 10px',
                borderRadius: 6,
                borderLeft: '2px solid #6a9f78',
              }}
            >
              {task.result.slice(0, 200)}
            </div>
          )}
          {task.errorMessage && (
            <div
              style={{
                marginTop: 8,
                fontSize: 11,
                color: '#c45c66',
                fontFamily: 'var(--font-mono)',
                background: 'rgba(196,92,102,0.05)',
                padding: '8px 10px',
                borderRadius: 6,
                borderLeft: '2px solid #c45c66',
              }}
            >
              {task.errorMessage}
            </div>
          )}
        </motion.div>
      )}
    </motion.div>
  );
}

export function TaskBoard() {
  const qc = useQueryClient();
  const { data: tasks = [], refetch } = useQuery({
    queryKey: ['tasks'],
    queryFn: () => api.tasks.list(),
    refetchInterval: 10000,
  });

  // Refresh on task events
  useApexEvent('task:created', () => refetch());
  useApexEvent('task:updated', () => refetch());

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 16,
        height: '100%',
        overflowX: 'auto',
      }}
    >
      {STATUS_COLUMNS.map((col) => {
        const colTasks = tasks.filter((t) => t.status === col.key);
        return (
          <div key={col.key} style={{ minWidth: 200 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 10,
                padding: '6px 10px',
                borderRadius: 8,
                background: 'rgba(255,255,255,0.03)',
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: col.color,
                  boxShadow: `0 0 8px ${col.color}`,
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 12, fontWeight: 600, color: col.color }}>{col.label}</span>
              <span
                style={{
                  marginLeft: 'auto',
                  fontSize: 11,
                  color: 'var(--color-apex-muted)',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {colTasks.length}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {colTasks.map((t) => (
                <TaskCard key={t.id} task={t} />
              ))}
              {colTasks.length === 0 && (
                <div
                  style={{
                    textAlign: 'center',
                    color: 'var(--color-apex-muted)',
                    fontSize: 11,
                    padding: '20px 0',
                    borderRadius: 8,
                    border: '1px dashed rgba(255,255,255,0.06)',
                  }}
                >
                  Empty
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
