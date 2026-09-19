import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  BarChart3,
  Bot,
  Check,
  ChevronRight,
  CircleDollarSign,
  Crosshair,
  Database,
  Gauge,
  LockKeyhole,
  MessageSquareText,
  Network,
  PhoneCall,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  Users,
} from 'lucide-react';
import './PublicLanding.css';

type DemoVertical = 'home-services' | 'professional-services' | 'b2b';

interface PublicLandingProps {
  onOperatorLogin: () => void;
}

const demoSteps = [
  {
    icon: <Target size={18} />,
    label: 'Define the objective',
    detail: 'Capture the offer, ideal customer, geography, exclusions, deal value and handoff rules.',
  },
  {
    icon: <Search size={18} />,
    label: 'Build the market',
    detail: 'Generate a focused target-account universe instead of importing a generic purchased list.',
  },
  {
    icon: <Database size={18} />,
    label: 'Research the buyer',
    detail: 'Identify decision-makers, enrich contact data, score fit and preserve account context.',
  },
  {
    icon: <Sparkles size={18} />,
    label: 'Create the strategy',
    detail: 'Build prospect-specific positioning, channel sequencing and objection context.',
  },
  {
    icon: <MessageSquareText size={18} />,
    label: 'Execute approved outreach',
    detail: 'Coordinate email, SMS, voice and follow-up only through configured, approved workflows.',
  },
  {
    icon: <PhoneCall size={18} />,
    label: 'Handle the response',
    detail: 'Route positive signals to the right callback, scheduling, handoff or next-step path.',
  },
  {
    icon: <BarChart3 size={18} />,
    label: 'Measure the economics',
    detail: 'Tie pipeline activity to qualified conversations, held meetings, opportunities, revenue and delivery cost.',
  },
];

const verticalContent: Record<DemoVertical, { name: string; target: string; sample: string[] }> = {
  'home-services': {
    name: 'Home Services',
    target: 'Owner-led HVAC companies within a defined service area',
    sample: ['NorthStar Mechanical', 'Metro Comfort', 'Summit Air & Heat'],
  },
  'professional-services': {
    name: 'Professional Services',
    target: 'Decision-maker-accessible firms with meaningful customer value',
    sample: ['Harbor Advisory', 'Crestline Legal', 'Westgate Commercial'],
  },
  b2b: {
    name: 'B2B Growth',
    target: 'Growth-oriented companies with a definable account universe',
    sample: ['SignalWorks', 'Ironwood Systems', 'Atlas Operations'],
  },
};

export function PublicLanding({ onOperatorLogin }: PublicLandingProps) {
  const [vertical, setVertical] = useState<DemoVertical>('home-services');
  const [objective, setObjective] = useState('Create qualified sales conversations in a focused local market');
  const [running, setRunning] = useState(false);
  const [activeStep, setActiveStep] = useState(-1);
  const [complete, setComplete] = useState(false);

  const verticalInfo = useMemo(() => verticalContent[vertical], [vertical]);

  useEffect(() => {
    if (!running) return;

    setComplete(false);
    setActiveStep(0);

    let step = 0;
    const timer = window.setInterval(() => {
      step += 1;
      if (step >= demoSteps.length) {
        window.clearInterval(timer);
        setRunning(false);
        setComplete(true);
        setActiveStep(demoSteps.length - 1);
        return;
      }
      setActiveStep(step);
    }, 760);

    return () => window.clearInterval(timer);
  }, [running]);

  const startDemo = () => {
    setComplete(false);
    setRunning(true);
  };

  const scrollToDemo = () => {
    document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const scrollToPilot = () => {
    document.getElementById('pilot')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="public-shell">
      <header className="public-nav-wrap">
        <nav className="public-nav public-container" aria-label="APEX public navigation">
          <button className="public-brand" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
            <span className="public-brand-mark">Ax</span>
            <span>
              <strong>APEX</strong>
              <small>Autonomous AI Workforce</small>
            </span>
          </button>

          <div className="public-nav-links">
            <button onClick={scrollToDemo}>How it works</button>
            <button onClick={scrollToPilot}>Founder Pilot</button>
            <button className="public-login-link" onClick={onOperatorLogin}>
              <LockKeyhole size={14} />
              Operator login
            </button>
          </div>
        </nav>
      </header>

      <main>
        <section className="public-hero public-container">
          <div className="public-hero-copy">
            <div className="public-eyebrow">AUTONOMOUS REVENUE WORKFORCE</div>
            <h1>
              Give APEX an objective.
              <span> Let the workforce go to work.</span>
            </h1>
            <p className="public-hero-lede">
              APEX researches the market, finds and qualifies the right prospects, creates individualized strategies,
              coordinates approved outreach, handles responses, maintains pipeline state and measures the path from
              opportunity to revenue.
            </p>

            <div className="public-hero-actions">
              <button className="btn-primary public-cta" onClick={scrollToDemo}>
                Run the interactive demo
                <ArrowRight size={16} />
              </button>
              <button className="btn-secondary public-cta" onClick={scrollToPilot}>
                See the $1,500 Founder Pilot
              </button>
            </div>

            <div className="public-trust-row">
              <span><ShieldCheck size={15} /> Human approval gates</span>
              <span><Network size={15} /> Coordinated agent workforce</span>
              <span><Gauge size={15} /> Outcome measurement</span>
            </div>
          </div>

          <div className="public-command-card" aria-label="APEX operating model">
            <div className="public-command-top">
              <span>OBJECTIVE</span>
              <span className="public-live-dot">LIVE WORKFLOW</span>
            </div>
            <div className="public-command-objective">
              Build a qualified market, personalize the approach, execute approved outreach and advance positive
              responses.
            </div>

            <div className="public-command-flow">
              {['Research', 'Qualify', 'Personalize', 'Execute', 'Respond', 'Measure'].map((item, index) => (
                <div className="public-flow-row" key={item}>
                  <span className="public-flow-index">{String(index + 1).padStart(2, '0')}</span>
                  <span>{item}</span>
                  <ChevronRight size={14} />
                </div>
              ))}
            </div>

            <div className="public-command-footer">
              <div>
                <strong>13-agent</strong>
                <span>hierarchical workforce</span>
              </div>
              <div>
                <strong>1 system</strong>
                <span>research → outreach → pipeline</span>
              </div>
            </div>
          </div>
        </section>

        <section className="public-proof-strip">
          <div className="public-container public-proof-grid">
            <div>
              <strong>Research</strong>
              <span>ICP, target accounts, decision-makers and account context</span>
            </div>
            <div>
              <strong>Execute</strong>
              <span>Prospect-specific strategy, approved channels and response handling</span>
            </div>
            <div>
              <strong>Measure</strong>
              <span>Qualified conversations, meetings, opportunities, revenue and cost</span>
            </div>
          </div>
        </section>

        <section className="public-section public-container" id="demo">
          <div className="public-section-heading">
            <div className="public-eyebrow">INTERACTIVE PRODUCT WALKTHROUGH</div>
            <h2>See the operating loop, not another dashboard screenshot.</h2>
            <p>
              This walkthrough uses fictional companies and simulated activity. Nothing is sent, called or changed
              outside your browser.
            </p>
          </div>

          <div className="public-demo-grid">
            <div className="public-demo-controls glass-card">
              <div className="public-demo-label">1. Choose a market</div>
              <div className="public-segmented" role="group" aria-label="Demo market">
                {([
                  ['home-services', 'Home services'],
                  ['professional-services', 'Professional'],
                  ['b2b', 'B2B growth'],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    className={vertical === id ? 'active' : ''}
                    onClick={() => setVertical(id)}
                    disabled={running}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="public-demo-label">2. Give APEX the objective</div>
              <textarea
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                disabled={running}
                aria-label="Demo objective"
              />

              <div className="public-demo-market">
                <span>Target profile</span>
                <strong>{verticalInfo.target}</strong>
              </div>

              <button className="btn-primary public-run-demo" onClick={startDemo} disabled={running || !objective.trim()}>
                {running ? 'APEX is working…' : complete ? 'Run it again' : 'Run APEX demo'}
                {!running && <ArrowRight size={16} />}
              </button>
            </div>

            <div className="public-demo-terminal">
              <div className="public-terminal-header">
                <div>
                  <span className="public-terminal-dot" />
                  <span className="public-terminal-dot" />
                  <span className="public-terminal-dot" />
                </div>
                <span>APEX · DEMO WORKSPACE</span>
                <span>SIMULATION</span>
              </div>

              <div className="public-terminal-objective">
                <span>OBJECTIVE</span>
                <p>{objective}</p>
              </div>

              <div className="public-terminal-accounts">
                {verticalInfo.sample.map((name) => (
                  <span key={name}>{name}</span>
                ))}
              </div>

              <div className="public-step-list">
                {demoSteps.map((step, index) => {
                  const isDone = complete || activeStep > index;
                  const isActive = running && activeStep === index;
                  return (
                    <div
                      className={'public-step ' + (isDone ? 'done ' : '') + (isActive ? 'active' : '')}
                      key={step.label}
                    >
                      <div className="public-step-icon">
                        {isDone ? <Check size={17} /> : step.icon}
                      </div>
                      <div>
                        <strong>{step.label}</strong>
                        <span>{step.detail}</span>
                      </div>
                      <div className="public-step-state">
                        {isDone ? 'done' : isActive ? 'working' : 'queued'}
                      </div>
                    </div>
                  );
                })}
              </div>

              {complete && (
                <div className="public-demo-result">
                  <Check size={18} />
                  <div>
                    <strong>Workflow complete.</strong>
                    <span>
                      In production, the next action would depend on your approvals, channel permissions and live
                      prospect responses.
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="public-section public-container">
          <div className="public-section-heading">
            <div className="public-eyebrow">WHAT APEX IS</div>
            <h2>AI that coordinates the work itself.</h2>
            <p>
              Most business software gives your team another interface to operate. APEX is designed to coordinate
              persistent work toward a defined objective, with human control where it matters.
            </p>
          </div>

          <div className="public-capability-grid">
            {[
              {
                icon: <Crosshair size={20} />,
                title: 'Market intelligence',
                body: 'Define the ICP, discover target accounts, identify decision-makers, enrich records and preserve account context.',
              },
              {
                icon: <Sparkles size={20} />,
                title: 'Individualized strategy',
                body: 'Create account-specific positioning and outreach angles instead of pushing one generic campaign to everyone.',
              },
              {
                icon: <MessageSquareText size={20} />,
                title: 'Multichannel execution',
                body: 'Coordinate approved email, SMS, voice, callbacks and follow-up as parts of one operating flow.',
              },
              {
                icon: <Bot size={20} />,
                title: 'Agent workforce',
                body: 'A hierarchical AI workforce delegates work across specialized executive, engineering and business roles.',
              },
              {
                icon: <ShieldCheck size={20} />,
                title: 'Human governance',
                body: 'High-impact actions remain gated by approvals, channel policy and configured operating boundaries.',
              },
              {
                icon: <BarChart3 size={20} />,
                title: 'Closed-loop measurement',
                body: 'Track outcomes from targeting through conversation, appointment, opportunity, customer and attributed revenue.',
              },
            ].map((item) => (
              <article className="public-capability-card glass-card" key={item.title}>
                <div className="public-capability-icon">{item.icon}</div>
                <h3>{item.title}</h3>
                <p>{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="public-section public-container">
          <div className="public-not-grid">
            <div>
              <div className="public-eyebrow">WHAT APEX IS NOT</div>
              <h2>Not a chatbot with a prettier prompt box.</h2>
            </div>
            <div className="public-not-list">
              {[
                ['A chatbot', 'Coordinate persistent work toward an objective.'],
                ['A lead database', 'Research, qualify, personalize and advance prospects.'],
                ['A CRM', 'Act on pipeline state instead of merely storing it.'],
                ['A dialer', 'Use voice as one execution channel inside a larger strategy.'],
                ['An email sequencer', 'Coordinate multiple channels and response handling.'],
                ['A generic automation tool', 'Reason about the objective, execute approved actions and measure the outcome.'],
              ].map(([not, does]) => (
                <div className="public-not-row" key={not}>
                  <span>{not}</span>
                  <strong>{does}</strong>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="public-section public-container" id="pilot">
          <div className="public-pilot">
            <div className="public-pilot-copy">
              <div className="public-eyebrow">30-DAY FOUNDER PILOT</div>
              <h2>Prove it against your own market.</h2>
              <p>
                A focused proof engagement designed to answer one question: can APEX create qualified pipeline for
                your business?
              </p>

              <div className="public-pilot-price">
                <strong>$1,500</strong>
                <span>30 days · limited founder cohort</span>
              </div>

              <a
                className="btn-primary public-cta public-pilot-button"
                href="mailto:don@donmatthews.live?subject=APEX%2030-Day%20Founder%20Pilot"
              >
                Request a 15-minute Pipeline Audit
                <ArrowRight size={16} />
              </a>
            </div>

            <div className="public-pilot-details">
              <div className="public-pilot-stat-grid">
                <div><span>1</span><strong>Defined ICP</strong><small>One focused market first</small></div>
                <div><span>Weekly</span><strong>Pipeline reporting</strong><small>Outcomes, not vanity metrics</small></div>
                <div><span>Day 30</span><strong>Business review</strong><small>Results + next-month plan</small></div>
              </div>

              <div className="public-pilot-includes">
                {[
                  'ICP and campaign strategy',
                  'Qualified prospect research and enrichment',
                  'Prospect-specific personalization',
                  'Approved campaign execution and controlled follow-up',
                  'Positive-response routing and scheduling/handoff logic',
                  'Weekly pipeline summary and day-30 review',
                ].map((item) => (
                  <div key={item}><Check size={16} /> {item}</div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="public-section public-container">
          <div className="public-fit-card glass-card">
            <div>
              <div className="public-eyebrow">BEST FIT</div>
              <h2>Where one qualified conversation has meaningful value.</h2>
            </div>
            <div className="public-fit-grid">
              <span><Users size={17} /> Owner-led and decision-maker-accessible businesses</span>
              <span><CircleDollarSign size={17} /> High-value services where one new customer matters</span>
              <span><Target size={17} /> Clear industry, geography or account universe</span>
              <span><Gauge size={17} /> Teams ready to handle additional opportunities now</span>
            </div>
          </div>
        </section>

        <section className="public-final-cta">
          <div className="public-container">
            <div className="public-eyebrow">TURN STRATEGY INTO EXECUTION</div>
            <h2>Intelligence that doesn’t just advise. It executes.</h2>
            <p>Start with a focused market, controlled execution and measurable pipeline outcomes.</p>
            <div className="public-final-actions">
              <a
                className="btn-primary public-cta"
                href="mailto:don@donmatthews.live?subject=APEX%20Pipeline%20Audit"
              >
                Talk about the Founder Pilot
                <ArrowRight size={16} />
              </a>
              <button className="btn-secondary public-cta" onClick={onOperatorLogin}>
                <LockKeyhole size={15} />
                Existing operator login
              </button>
            </div>
          </div>
        </section>
      </main>

      <footer className="public-footer public-container">
        <div className="public-brand">
          <span className="public-brand-mark">Ax</span>
          <span><strong>APEX</strong><small>Autonomous AI Workforce</small></span>
        </div>
        <div>
          <span>apex.donmatthews.live</span>
          <span>don@donmatthews.live</span>
        </div>
      </footer>
    </div>
  );
}
