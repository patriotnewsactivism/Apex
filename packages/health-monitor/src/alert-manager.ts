// ─── AlertManager ──────────────────────────────────────────────────────────────
//
// Phase 1 observability: evaluates alert rules against HealthReport data and
// maintains an in-memory active-alert list. Alert rules match the thresholds
// specced in ROADMAP.md: error_rate > 5%, task_backlog > 50, approval_backlog > 10,
// any component status === 'critical'.
//
// Alerts are persisted to the health_metrics table (via the caller's polling
// loop) and surfaced via the /api/health/alerts route + WebSocket events.
// This class deliberately has no DB dependency itself — it's a pure evaluator.

import type { HealthReport, ComponentCheckResult } from './index.js';

export type AlertSeverity = 'warning' | 'critical';

export interface Alert {
  id: string;
  rule: string;
  severity: AlertSeverity;
  message: string;
  component: string;
  firedAt: string;       // ISO timestamp
  acknowledgedAt?: string;
}

export interface AlertRule {
  name: string;
  evaluate: (report: HealthReport) => Alert | null;
}

let alertIdCounter = 0;
function nextAlertId(): string {
  return `alert-${Date.now()}-${++alertIdCounter}`;
}

// ─── Default Alert Rules (per ROADMAP.md thresholds) ──────────────────────────

const defaultRules: AlertRule[] = [
  // Any component reporting 'critical' fires immediately
  {
    name: 'component_critical',
    evaluate(report) {
      for (const [component, check] of Object.entries(report.checks)) {
        if (check.status === 'critical') {
          return {
            id: nextAlertId(),
            rule: 'component_critical',
            severity: 'critical',
            message: `Component '${component}' is critical: ${check.detail}`,
            component,
            firedAt: new Date().toISOString(),
          };
        }
      }
      return null;
    },
  },
  // Task backlog > 50
  {
    name: 'task_backlog_high',
    evaluate(report) {
      const backlog = report.checks.taskBacklog;
      if (!backlog) return null;
      // Parse the count from the detail string (format: "N pending/in_progress tasks")
      const match = backlog.detail.match(/^(\d+)/);
      const count = match ? parseInt(match[1], 10) : 0;
      if (count > 50) {
        return {
          id: nextAlertId(),
          rule: 'task_backlog_high',
          severity: 'warning',
          message: `Task backlog is ${count} (threshold: 50)`,
          component: 'taskBacklog',
          firedAt: new Date().toISOString(),
        };
      }
      return null;
    },
  },
  // Approval backlog > 10 (requires injected data — checked if available in report metadata)
  {
    name: 'approval_backlog_high',
    evaluate(report) {
      // The approval backlog count can be injected as a custom check by the caller.
      // If present, it will be in report.checks.approvalBacklog.
      const approvalCheck = report.checks.approvalBacklog as ComponentCheckResult | undefined;
      if (!approvalCheck) return null;
      const match = approvalCheck.detail.match(/^(\d+)/);
      const count = match ? parseInt(match[1], 10) : 0;
      if (count > 10) {
        return {
          id: nextAlertId(),
          rule: 'approval_backlog_high',
          severity: 'warning',
          message: `Approval backlog is ${count} (threshold: 10)`,
          component: 'approvalBacklog',
          firedAt: new Date().toISOString(),
        };
      }
      return null;
    },
  },
  // Overall system degraded for multiple checks
  {
    name: 'system_degraded',
    evaluate(report) {
      const degradedCount = Object.values(report.checks).filter(
        (c) => c.status === 'degraded',
      ).length;
      if (degradedCount >= 3) {
        return {
          id: nextAlertId(),
          rule: 'system_degraded',
          severity: 'warning',
          message: `${degradedCount} components are degraded`,
          component: 'system',
          firedAt: new Date().toISOString(),
        };
      }
      return null;
    },
  },
];

// ─── AlertManager ──────────────────────────────────────────────────────────────

export class AlertManager {
  private activeAlerts = new Map<string, Alert>();
  private rules: AlertRule[];
  // Track which rules have already fired (by rule name) to avoid spamming
  // the same alert every 60s. Cleared when the rule's condition clears.
  private firedRules = new Set<string>();

  constructor(rules?: AlertRule[]) {
    this.rules = rules ?? defaultRules;
  }

  /** Evaluate all rules against a health report. Returns newly fired alerts. */
  evaluate(report: HealthReport): Alert[] {
    const newAlerts: Alert[] = [];
    const currentlyFiring = new Set<string>();

    for (const rule of this.rules) {
      const alert = rule.evaluate(report);
      if (alert) {
        currentlyFiring.add(rule.name);
        // Only fire if this rule wasn't already active (dedup)
        if (!this.firedRules.has(rule.name)) {
          this.activeAlerts.set(alert.id, alert);
          this.firedRules.add(rule.name);
          newAlerts.push(alert);
        }
      }
    }

    // Clear rules that are no longer firing
    for (const ruleName of this.firedRules) {
      if (!currentlyFiring.has(ruleName)) {
        this.firedRules.delete(ruleName);
        // Remove active alerts for this rule (auto-resolve)
        for (const [id, alert] of this.activeAlerts) {
          if (alert.rule === ruleName && !alert.acknowledgedAt) {
            this.activeAlerts.delete(id);
          }
        }
      }
    }

    return newAlerts;
  }

  /** Get all active (unacknowledged + still-firing) alerts. */
  getActiveAlerts(): Alert[] {
    return Array.from(this.activeAlerts.values());
  }

  /** Acknowledge an alert by ID. */
  acknowledge(alertId: string): boolean {
    const alert = this.activeAlerts.get(alertId);
    if (!alert) return false;
    alert.acknowledgedAt = new Date().toISOString();
    return true;
  }

  /** Get alert count by severity. */
  getSummary(): { total: number; critical: number; warning: number; acknowledged: number } {
    let critical = 0;
    let warning = 0;
    let acknowledged = 0;
    for (const alert of this.activeAlerts.values()) {
      if (alert.acknowledgedAt) acknowledged++;
      else if (alert.severity === 'critical') critical++;
      else warning++;
    }
    return { total: this.activeAlerts.size, critical, warning, acknowledged };
  }

  /** Clear all alerts (for testing/reset). */
  clear(): void {
    this.activeAlerts.clear();
    this.firedRules.clear();
  }
}
