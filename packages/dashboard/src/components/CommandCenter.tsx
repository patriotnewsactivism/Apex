import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Crosshair,
  LockKeyhole,
  MessageSquare,
  PhoneCall,
  Play,
  ShieldCheck,
  Target,
  Users,
  Workflow,
} from 'lucide-react';
import type { Agent } from '../lib/api.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import './CommandCenter.css';

interface CommandCenterProps {
  agents: Agent[];
  onNavigate: (page: string) => void;
}

const workforceRoles = ['CEO', 'COO', 'SALES', 'RESEARCH'];

function statusFor(agent: Agent, statuses: Record<string, string>) {
  return statuses[agent.id] ?? agent.liveStatus ?? agent.status ?? 'idle';
}

function statusLabel(status: string) {
  if (status === 'thinking' || status === 'acting') return 'working';
  if (status === 'blocked' || status === 'error') return 'needs attention';
  if (status === 'done') return 'complete';
  return 'standing by';
}

export function CommandCenter({ agents, onNavigate }: CommandCenterProps) {
  const { connected, agentStatuses, lastEvent } = useWebSocket();
  const activeAgents = agents.filter((agent) => {
    const status = statusFor(agent, agentStatuses);
    return status === 'thinking' || status === 'acting';
  }).length;
  const attentionAgents = agents.filter((agent) => {
    const status = statusFor(agent, agentStatuses);
    return status === 'blocked' || status === 'error';
  }).length;
  const visibleWorkforce = workforceRoles
    .map((role) => agents.find((agent) => agent.role === role))
    .filter((agent): agent is Agent => Boolean(agent));

  return (
    <div className="command-center">
      <section className="command-hero-card">
        <div className="command-hero-copy">
          <div className="apex-eyebrow">APEX COMMAND CENTER</div>
          <h2>Give APEX an objective. Let the workforce go to work.</h2>
          <p>
            This is the starting point for operating APEX. Set the mission, review the boundaries, and let the
            workforce carry the work from research through revenue.
          </p>
          <div className="command-hero-actions">
            <button className="btn-primary command-action" onClick={() => onNavigate('chat')}>
              <MessageSquare size={16} /> Tell APEX what to do
              <ArrowRight size={15} />
            </button>
            <button className="btn-secondary command-action" onClick={() => onNavigate('sales-ops')}>
              <Play size={15} /> Open revenue operations
            </button>
          </div>
        </div>
        <div className="command-hero-loop" aria-label="APEX operating loop">
          <div className="command-loop-label">OPERATING LOOP</div>
          <div className="command-loop-line">
            <span>Research</span><i>→</i><span>Strategy</span><i>→</i><span>Outreach</span><i>→</i><span>Revenue</span>
          </div>
          <div className="command-loop-foot">
            <span><ShieldCheck size={14} /> Human approval gates</span>
            <span><Workflow size={14} /> One coordinated workforce</span>
          </div>
        </div>
      </section>

      <section className="command-metrics" aria-label="APEX operating status">
        <article className="command-metric-card">
          <div className="command-metric-icon"><Users size={17} /></div>
          <span className="command-metric-label">WORKFORCE</span>
          <strong>{agents.length || '—'}</strong>
          <small>{activeAgents ? `${activeAgents} working now` : 'Agents standing by'}</small>
        </article>
        <article className="command-metric-card">
          <div className="command-metric-icon"><Bot size={17} /></div>
          <span className="command-metric-label">LIVE LINK</span>
          <strong className={connected ? 'command-good' : 'command-warn'}>{connected ? 'LIVE' : 'RECONNECTING'}</strong>
          <small>Realtime workforce status</small>
        </article>
        <article className="command-metric-card">
          <div className="command-metric-icon"><LockKeyhole size={17} /></div>
          <span className="command-metric-label">GOVERNANCE</span>
          <strong className="command-good">GATED</strong>
          <small>High-impact actions require review</small>
        </article>
        <article className="command-metric-card">
          <div className="command-metric-icon"><Crosshair size={17} /></div>
          <span className="command-metric-label">ATTENTION</span>
          <strong className={attentionAgents ? 'command-warn' : 'command-good'}>{attentionAgents || 'CLEAR'}</strong>
          <small>{attentionAgents ? 'Agent states need review' : 'No agent errors reported'}</small>
        </article>
      </section>

      <section className="command-main-grid">
        <div className="command-panel command-workflow-panel">
          <div className="command-panel-heading">
            <div>
              <div className="apex-eyebrow">FROM OBJECTIVE TO OUTCOME</div>
              <h3>The work moves through one loop.</h3>
            </div>
            <span className="command-panel-tag">APEX METHOD</span>
          </div>
          <div className="command-workflow-list">
            {[
              ['01', 'Define the objective', 'Offer, ideal customer, market, economics and handoff rules.', 'chat', <Target size={17} />],
              ['02', 'Build and qualify the market', 'Find the right accounts, decision-makers and contact context.', 'leads', <Crosshair size={17} />],
              ['03', 'Execute approved outreach', 'Coordinate individualized email, SMS, voice and follow-up.', 'sales-ops', <PhoneCall size={17} />],
              ['04', 'Advance the opportunity', 'Route responses, schedule next steps and maintain pipeline state.', 'sales-ops', <ArrowRight size={17} />],
            ].map(([number, title, body, destination, icon]) => (
              <button className="command-workflow-row" key={String(number)} onClick={() => onNavigate(destination as string)}>
                <span className="command-workflow-number">{number}</span>
                <span className="command-workflow-icon">{icon}</span>
                <span className="command-workflow-copy"><strong>{title}</strong><small>{body}</small></span>
                <ArrowRight size={15} />
              </button>
            ))}
          </div>
        </div>

        <div className="command-panel command-next-panel">
          <div className="command-panel-heading">
            <div>
              <div className="apex-eyebrow">OPERATOR DECISION</div>
              <h3>What do you want to move?</h3>
            </div>
          </div>
          <div className="command-next-actions">
            <button onClick={() => onNavigate('chat')}><MessageSquare size={17} /><span><strong>Set a new objective</strong><small>Tell APEX what outcome matters.</small></span><ArrowRight size={14} /></button>
            <button onClick={() => onNavigate('approvals')}><ShieldCheck size={17} /><span><strong>Review approvals</strong><small>Decide what the workforce may execute.</small></span><ArrowRight size={14} /></button>
            <button onClick={() => onNavigate('leads')}><Users size={17} /><span><strong>Inspect the market</strong><small>Review prospects and decision-makers.</small></span><ArrowRight size={14} /></button>
          </div>
          <div className="command-operator-note">
            <CheckCircle2 size={16} /> APEX is designed to carry the operating loop while you retain control of the objective and boundaries.
          </div>
        </div>
      </section>

      <section className="command-bottom-grid">
        <div className="command-panel command-workforce-panel">
          <div className="command-panel-heading">
            <div>
              <div className="apex-eyebrow">LIVE WORKFORCE</div>
              <h3>Who is carrying the work</h3>
            </div>
            <button className="command-text-button" onClick={() => onNavigate('agents')}>Open network <ArrowRight size={14} /></button>
          </div>
          {visibleWorkforce.length > 0 ? (
            <div className="command-agent-list">
              {visibleWorkforce.map((agent) => {
                const status = statusFor(agent, agentStatuses);
                return (
                  <div className="command-agent-row" key={agent.id}>
                    <span className={`command-status-dot command-status-${status}`} />
                    <span className="command-agent-role">{agent.role}</span>
                    <strong>{agent.name}</strong>
                    <span className="command-agent-status">{statusLabel(status)}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="command-empty-state">The workforce roster is loading. Open Agent Network for the full hierarchy.</div>
          )}
        </div>
        <div className="command-panel command-event-panel">
          <div className="command-panel-heading">
            <div>
              <div className="apex-eyebrow">LATEST SIGNAL</div>
              <h3>What just happened</h3>
            </div>
          </div>
          {lastEvent ? (
            <div className="command-event-card">
              <span>{lastEvent.type.replace(/[:_]/g, ' ').toUpperCase()}</span>
              <strong>APEX has a new operating signal.</strong>
              <small>Open Activity Log for the full event stream.</small>
              <button className="command-text-button" onClick={() => onNavigate('logs')}>View activity <ArrowRight size={14} /></button>
            </div>
          ) : (
            <div className="command-empty-state">No new event has arrived since this session opened.</div>
          )}
        </div>
      </section>
    </div>
  );
}
