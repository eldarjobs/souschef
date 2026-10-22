import type { CompactResult, TaskRecord } from '../types.js';

/** One line a model can act on without opening any logs. */
export function buildSummaryLine(r: Omit<CompactResult, 'summary'>): string {
  const t = r.tests;
  const counts =
    t.passed !== undefined || t.failed !== undefined ? `${t.passed ?? 0} passed, ${t.failed ?? 0} failed` : 'counts unavailable';
  switch (r.status) {
    case 'COMPLETED':
      return `${t.created ? `Created ${t.created} tests; ` : ''}tests passed (${counts}). ${
        r.apply.applied ? `Applied ${r.changedFiles.length} file(s) to the checkout.` : `Not applied: ${r.apply.reason ?? 'autoApply disabled'}.`
      }`;
    case 'NEEDS_REVIEW':
      if (r.security.outOfScopeChanges > 0) return `Agent changed ${r.security.outOfScopeChanges} file(s) outside the allowed test paths; nothing applied.`;
      if (r.agent.suspectedProductBug) return `Tests point to a bug in the production code (${counts}); nothing applied.`;
      if (r.apply.conflicts?.length) return `Tests passed but ${r.apply.conflicts.length} file(s) conflict with the current checkout; nothing applied.`;
      return `Needs review (${counts}); nothing applied.`;
    case 'FAILED':
      if (r.execution === 'FAILED') return 'Agent run failed before producing usable tests.';
      if (r.build === 'FAILED') return 'Build failed after the agent finished.';
      if (r.tests.failed || r.tests.exitCode) return `Tests still failing after ${r.agent.attempts} attempt(s) (${counts}).`;
      return 'Task failed.';
    case 'TIMED_OUT':
      return 'Task exceeded its time limit; nothing applied.';
    case 'CANCELLED':
      return 'Task cancelled; nothing applied.';
    default:
      return r.status;
  }
}

/** Compact status view shared by get_task_status and wait_for_task. */
export function statusView(task: TaskRecord) {
  return {
    taskId: task.id,
    status: task.status,
    phase: task.phase,
    progress: task.progress,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    ...(task.error ? { error: task.error } : {}),
    ...(task.result ? { summary: task.result.summary } : {})
  };
}
