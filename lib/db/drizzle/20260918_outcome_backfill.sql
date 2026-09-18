-- APEX Outcome Ledger historical backfill.
-- Idempotent: every insert uses the same keys as the live mirroring triggers.

INSERT INTO outcome_entities (id, organization_id, tenant_id, source_system, entity_type, external_id, name, attributes)
SELECT DISTINCT
  'apex-task-' || md5(o.task_id),
  'apex',
  COALESCE(g.project_id,'apex'),
  'apex',
  'Task',
  o.task_id,
  t.title,
  jsonb_build_object('role',o.role)
FROM task_outcomes o
JOIN tasks t ON t.id=o.task_id
LEFT JOIN goals g ON g.id=t.goal_id
ON CONFLICT (tenant_id,source_system,entity_type,external_id) DO NOTHING;

INSERT INTO outcome_events (
 id,idempotency_key,schema_version,organization_id,tenant_id,source_system,event_type,entity_id,entity_type,entity_external_id,
 trace_id,responsible_agent_id,responsible_workflow,human_intervention,measurement_class,payload,occurred_at
)
SELECT
 'apex-task-outcome-'||o.id::text,
 'apex-task-outcome-'||o.id::text,
 1,'apex',COALESCE(g.project_id,'apex'),'apex',
 CASE WHEN o.success THEN 'engineering.task.completed' ELSE 'engineering.task.failed' END,
 'apex-task-'||md5(o.task_id),'Task',o.task_id,o.task_id,o.agent_id,'agent-task-execution',
 o.required_approvals>0,'MEASURED',
 jsonb_build_object('durationMs',o.duration_ms,'role',o.role,'toolExecutions',o.tool_executions,'llmCalls',o.llm_calls,'iterations',o.iterations,'errorType',o.error_type),
 o.recorded_at
FROM task_outcomes o
JOIN tasks t ON t.id=o.task_id
LEFT JOIN goals g ON g.id=t.goal_id
ON CONFLICT (idempotency_key) DO NOTHING;

INSERT INTO outcomes (
 id,event_id,organization_id,tenant_id,source_system,outcome_type,metric_name,entity_id,trace_id,responsible_agent_id,responsible_workflow,
 baseline,target,measured_result,numeric_baseline,numeric_target,numeric_result,unit,measurement_class,confidence,human_intervention,
 quality_score,status,evidence,occurred_at
)
SELECT
 'outcome-apex-task-outcome-'||o.id::text,
 'apex-task-outcome-'||o.id::text,
 'apex',COALESCE(g.project_id,'apex'),'apex','task_execution','task_success',
 'apex-task-'||md5(o.task_id),o.task_id,o.agent_id,'agent-task-execution',
 '0'::jsonb,'1'::jsonb,to_jsonb(CASE WHEN o.success THEN 1 ELSE 0 END),
 0,1,CASE WHEN o.success THEN 1 ELSE 0 END,'boolean','MEASURED',1.0,
 o.required_approvals>0,o.quality_score,CASE WHEN o.success THEN 'succeeded' ELSE 'failed' END,
 jsonb_build_object('taskOutcomeId',o.id),o.recorded_at
FROM task_outcomes o
JOIN tasks t ON t.id=o.task_id
LEFT JOIN goals g ON g.id=t.goal_id
ON CONFLICT (event_id) DO NOTHING;

INSERT INTO outcome_entities (id,organization_id,tenant_id,source_system,entity_type,external_id,name,attributes)
SELECT
 'apex-lead-'||md5(r.id),
 'apex',
 COALESCE(lc.project_id,'buildmybot'),
 'apex','Lead',r.id,r.company_name,
 jsonb_build_object('website',r.website,'campaignId',r.campaign_id,'status',r.status,'contactResearchStatus',r.contact_research_status)
FROM researched_leads r
LEFT JOIN lead_campaigns lc ON lc.id=r.campaign_id
ON CONFLICT (tenant_id,source_system,entity_type,external_id) DO NOTHING;

INSERT INTO outcome_events (
 id,idempotency_key,schema_version,organization_id,tenant_id,source_system,event_type,entity_id,entity_type,entity_external_id,
 responsible_agent_id,responsible_workflow,human_intervention,measurement_class,payload,occurred_at
)
SELECT
 'apex-lead-sourced-'||r.id,
 'apex-lead-sourced-'||r.id,
 1,'apex',COALESCE(lc.project_id,'buildmybot'),'apex','lead.sourced',
 'apex-lead-'||md5(r.id),'Lead',r.id,r.researched_by_agent_id,'lead-research',false,'MEASURED',
 jsonb_build_object('campaignId',r.campaign_id,'status',r.status,'contactResearchStatus',r.contact_research_status),
 r.created_at
FROM researched_leads r
LEFT JOIN lead_campaigns lc ON lc.id=r.campaign_id
ON CONFLICT (idempotency_key) DO NOTHING;
