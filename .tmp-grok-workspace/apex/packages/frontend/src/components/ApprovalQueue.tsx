/**
 * Human-in-the-Loop Approval Queue
 * Shows pending approvals from Apex agents and allows approve/reject.
 */

import { useState, useEffect } from 'react';

interface Approval {
  id: string;
  agentId: string;
  taskTitle: string;
  taskDetail: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  reviewerNote?: string;
}

const API_URL = import.meta.env.VITE_APEX_API_URL || 'http://localhost:3001';

export function ApprovalQueue() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const fetchApprovals = async () => {
    try {
      const res = await fetch(`${API_URL}/api/approvals?status=pending`);
      const data = await res.json();
      setApprovals(data.approvals || []);
    } catch (err) {
      console.error('Failed to fetch approvals:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchApprovals();
    // Poll every 5 seconds for new approvals
    const interval = setInterval(fetchApprovals, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleApprove = async (id: string) => {
    await fetch(`${API_URL}/api/approvals/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: notes[id] || '' }),
    });
    setApprovals(prev => prev.filter(a => a.id !== id));
  };

  const handleReject = async (id: string) => {
    await fetch(`${API_URL}/api/approvals/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: notes[id] || '' }),
    });
    setApprovals(prev => prev.filter(a => a.id !== id));
  };

  if (loading) return <div className="p-4 text-gray-500">Loading approvals...</div>;

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-4">
      <h2 className="text-xl font-bold text-gray-900">Approval Queue</h2>
      {approvals.length === 0 ? (
        <p className="text-gray-500 text-sm">No pending approvals. Agents are working autonomously.</p>
      ) : (
        approvals.map((approval) => (
          <div key={approval.id} className="border border-gray-200 rounded-lg p-4 bg-white">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-indigo-600">{approval.agentId}</span>
              <span className="text-xs text-gray-400">{new Date(approval.createdAt).toLocaleString()}</span>
            </div>
            <h3 className="font-semibold text-gray-900 mb-1">{approval.taskTitle}</h3>
            <p className="text-sm text-gray-600 mb-3">{approval.taskDetail}</p>
            <textarea
              placeholder="Add a note (optional)..."
              value={notes[approval.id] || ''}
              onChange={(e) => setNotes(prev => ({ ...prev, [approval.id]: e.target.value }))}
              className="w-full text-sm border border-gray-200 rounded p-2 mb-3 resize-none"
              rows={2}
            />
            <div className="flex gap-2">
              <button
                onClick={() => handleApprove(approval.id)}
                className="px-4 py-1.5 bg-green-600 text-white rounded text-sm font-medium hover:bg-green-700"
              >
                Approve
              </button>
              <button
                onClick={() => handleReject(approval.id)}
                className="px-4 py-1.5 bg-red-600 text-white rounded text-sm font-medium hover:bg-red-700"
              >
                Reject
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

export default ApprovalQueue;
