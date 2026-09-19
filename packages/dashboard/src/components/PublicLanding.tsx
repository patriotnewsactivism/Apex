import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  BarChart3,
  Bot,
  Check,
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
            <span className="public-brand-emblem" aria-hidden="true">ΛΛ</span>
            <span>
              <strong>APEX</strong>
              <small>Intelligence that executes.</small>
            </span>
          </button>

          <div className="public-nav-links">
            <button onClick={scrollToDemo}>How it works</button>
            <button onClick={scrollToPilot}>Pricing</button>
            <button className="public-nav-pilot" onClick={scrollToPilot}>Start pilot</button>
            <button className="public-login-link" onClick={onOperatorLogin}>
              <LockKeyhole size={14} />
              Operator login
            </button>
          </div>
        </nav>
      </header>

      <main>
        <section className="public-hero-cinematic">
          <div className="public-hero-backdrop" aria-hidden="true">
            <img src="/apex-branding.jpg" alt="" />
            <div className="public-hero-backdrop-shade" />
          </div>
          <div className="public-hero public-container">
          <div className="public-hero-copy">
            <div className="public-eyebrow">MANAGED PIPELINE · AUTONOMOUS AI WORKFORCE</div>
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
              <button className="btn-primary public-cta" onClick={scrollToPilot}>
                Start the 30-Day Pilot
                <ArrowRight size={16} />
              </button>
              <button className="btn-secondary public-cta" onClick={scrollToDemo}>
                See how it works
              </button>
            </div>

            <div className="public-hero-note">
              <strong>$1,750 one-time</strong>
              <span>30 days · real market · no annual contract</span>
            </div>

            <div className="public-trust-row">
              <span><ShieldCheck size={15} /> Human approval gates</span>
              <span><Network size={15} /> Coordinated agent workforce</span>
              <span><Gauge size={15} /> Outcome measurement</span>
            </div>
          </div>

          <div className="public-hero-brand-lockup" aria-label="APEX — Intelligence that executes">
            <img src="/apex-branding.jpg" alt="APEX — Intelligence that executes." />
          </div>
          </div>
        </section>

        <section className="public-proof-strip">
          <div className="public-container public-proof-grid">
            <div>
              <strong>Define</strong>
              <span>Your offer, market, economics and handoff rules</span>
            </div>
            <div>
              <strong>Deploy</strong>
              <span>Research, individualized strategy and controlled outreach</span>
            </div>
            <div>
              <strong>Advance</strong>
              <span>Responses, meetings, opportunities, revenue and cost</span>
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
          <div className="public-section-heading">
            <div className="public-eyebrow">YOUR ROLE IS SIMPLE</div>
            <h2>You set the objective. APEX carries the workload.</h2>
            <p>
              APEX is built to remove the disconnected handoffs between research, sales activity and pipeline
              management. You stay in control of the objective and approvals; the workforce handles the operating loop.
            </p>
          </div>

          <div className="public-role-grid">
            {[
              ['01', 'Define the objective', 'Tell APEX what you sell, who you want, where to look, what matters and how a qualified opportunity should be handed off.'],
              ['02', 'Approve the boundaries', 'Review the market, messaging, channels, volume and governance rules before execution begins.'],
              ['03', 'Work the opportunities', 'APEX keeps the pipeline moving while you or your team handle the conversations that deserve a human.'],
            ].map(([number, title, body]) => (
              <article className="public-role-card glass-card" key={number}>
                <span>{number}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="public-section public-container" id="pilot">
          <div className="public-section-heading public-pricing-heading">
            <div className="public-eyebrow">APEX PRICING</div>
            <h2>Start with a real 30-day deployment. Scale when APEX proves the economics.</h2>
            <p>
              The pilot is intentionally priced far below a standard APEX deployment so you can put the workforce to
              work against your actual market before making a larger commitment.
            </p>
          </div>

          <div className="public-pricing-anchor">
            <div>
              <span>STANDARD DEPLOYMENT</span>
              <strong>From $4,500/month</strong>
            </div>
            <div className="public-pricing-anchor-arrow">→</div>
            <div className="public-pricing-anchor-pilot">
              <span>30-DAY PILOT</span>
              <strong>$1,750 one-time</strong>
              <small>Pilot payment credited toward your first full month when you continue.</small>
            </div>
          </div>

          <div className="public-pricing-grid">
            <article className="public-price-card public-price-card-featured">
              <div className="public-price-badge">BEST WAY TO START</div>
              <div className="public-price-kicker">30-DAY APEX PILOT</div>
              <h3>Put APEX to work before you commit.</h3>
              <div className="public-price">
                <strong>$1,750</strong>
                <span>one-time · 30 days</span>
              </div>
              <p>
                A managed deployment against a real market, with real prospect research, individualized strategy and
                controlled multichannel execution.
              </p>
              <a
                className="btn-primary public-cta public-price-cta"
                href="mailto:don@donmatthews.live?subject=Start%20an%20APEX%2030-Day%20Pilot"
              >
                Start a 30-Day Pilot
                <ArrowRight size={16} />
              </a>
              <div className="public-price-credit">
                Continue after the pilot and the full <strong>$1,750</strong> is credited toward your first month.
              </div>
              <div className="public-price-list">
                {[
                  'Up to 2,500 researched and qualified prospects',
                  'ICP, market targeting and campaign strategy',
                  'Decision-maker and contact research',
                  'Individualized strategy for each prospect',
                  'Automated email outreach and controlled follow-up',
                  'AI-powered outbound calling and inbound call handling',
                  'SMS follow-up where appropriate',
                  'CRM, pipeline tracking and appointment scheduling',
                  'Campaign performance reporting',
                  'Human approval controls and pilot review',
                  'No annual contract required for the pilot',
                ].map((item) => (
                  <div key={item}><Check size={15} /> <span>{item}</span></div>
                ))}
              </div>
            </article>

            <article className="public-price-card">
              <div className="public-price-kicker">APEX GROWTH</div>
              <h3>Your ongoing autonomous sales operation.</h3>
              <div className="public-price">
                <strong>$4,500</strong>
                <span>per month</span>
              </div>
              <p>For businesses ready to make APEX part of their daily revenue operation.</p>
              <a
                className="btn-secondary public-cta public-price-cta"
                href="mailto:don@donmatthews.live?subject=APEX%20Growth%20Deployment"
              >
                Deploy APEX Growth
              </a>
              <div className="public-price-list">
                {[
                  'Up to 5,000 new researched prospects/month',
                  'Continuous research and enrichment',
                  'Multiple active outreach campaigns',
                  'Personalized email, SMS, voice and follow-up',
                  'Inbound and outbound AI sales agents',
                  'CRM and pipeline management',
                  'Appointment scheduling and lead nurturing',
                  'Performance and revenue reporting',
                  'Managed onboarding and support',
                ].map((item) => (
                  <div key={item}><Check size={15} /> <span>{item}</span></div>
                ))}
              </div>
            </article>

            <article className="public-price-card">
              <div className="public-price-kicker">APEX SCALE</div>
              <h3>Run larger territories and more campaigns.</h3>
              <div className="public-price">
                <strong>$7,500</strong>
                <span>per month</span>
              </div>
              <p>For higher-volume sales operations, multiple markets or simultaneous campaign strategies.</p>
              <a
                className="btn-secondary public-cta public-price-cta"
                href="mailto:don@donmatthews.live?subject=APEX%20Scale%20Deployment"
              >
                Talk About Scaling
              </a>
              <div className="public-price-list">
                {[
                  'Up to 15,000 new researched prospects/month',
                  'Multiple simultaneous markets or campaigns',
                  'Expanded outbound calling capacity',
                  'Advanced segmentation and sales personas',
                  'Higher-volume email and SMS orchestration',
                  'Multi-agent sales workflows',
                  'Advanced CRM automation and attribution',
                  'Priority optimization and support',
                ].map((item) => (
                  <div key={item}><Check size={15} /> <span>{item}</span></div>
                ))}
              </div>
            </article>

            <article className="public-price-card">
              <div className="public-price-kicker">APEX ENTERPRISE</div>
              <h3>Autonomous revenue infrastructure at scale.</h3>
              <div className="public-price">
                <strong>$12,500+</strong>
                <span>per month</span>
              </div>
              <p>For organizations that need custom volume, integrations, governance and dedicated deployment design.</p>
              <a
                className="btn-secondary public-cta public-price-cta"
                href="mailto:don@donmatthews.live?subject=APEX%20Enterprise%20Deployment"
              >
                Build an Enterprise Deployment
              </a>
              <div className="public-price-list">
                {[
                  'High-volume prospect research',
                  'Custom account and prospect limits',
                  'Multiple business units, territories or brands',
                  'Custom AI workforce configuration',
                  'Dedicated voice and sales agents',
                  'Custom workflow, API and CRM integrations',
                  'Advanced governance and approval controls',
                  'Custom reporting and priority support',
                ].map((item) => (
                  <div key={item}><Check size={15} /> <span>{item}</span></div>
                ))}
              </div>
            </article>
          </div>

          <div className="public-pricing-close">
            <div>
              <div className="public-eyebrow">WHY THE PILOT</div>
              <h3>You are not buying a demo. You are putting APEX to work.</h3>
            </div>
            <p>
              A standard APEX deployment begins at $4,500/month. The 30-day pilot lets you test the same operating
              model against your own market for $1,750, with no annual commitment—and that investment rolls into your
              first full month if you continue.
            </p>
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
                Start with the 30-Day Pilot
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
          <span className="public-brand-mark" aria-hidden="true">A</span>
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
