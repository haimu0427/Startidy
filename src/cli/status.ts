import type { GitHubPort, ResolutionAction, StorePort, RunStatus } from '../core/ports.js';
import { DomainError } from '../core/errors.js';

export interface StatusCommandResult {
  runId: string;
  status: RunStatus;
  resumable: boolean;
  requiresReview: boolean;
  blockedOperation?: {
    opId: string;
    type: string;
  };
  availableActions?: ResolutionAction[];
  totalEvents: number;
  appliedOperations: string[];
  failedOperation?: {
    opId: string;
    error: string;
    code: string;
  };
  startedAt?: string;
  finishedAt?: string;
}

export async function runStatus(options: {
  github: GitHubPort;
  store: StorePort;
  runId: string;
}): Promise<StatusCommandResult> {
  const { github, store, runId } = options;

  const viewer = await github.getViewer();
  const result = await store.loadRunResult(viewer, runId);
  const events = await store.getRunEvents(viewer, runId);
  const review = await store.loadReview(viewer, runId);

  if (!result && events.length === 0) {
    throw new DomainError({
      code: 'STATE_CONFLICT',
      message: `No execution records found for runId: ${runId}`
    });
  }

  const status: RunStatus = result?.status ?? (
    events.some((event) => event.phase === 'run_cancelled')
      ? 'cancelled'
      : events.some((event) => event.phase === 'run_finish')
        ? 'completed'
        : 'partial'
  );
  const requiresReview = status === 'needs_review';
  const resumable = status === 'partial' || status === 'failed' || requiresReview;
  const conflict = requiresReview
    ? [...events].reverse().find((event) => event.phase === 'op_conflict' && event.opId)
    : undefined;
  const operation = conflict?.opId ? review?.operations.find((candidate) => candidate.opId === conflict.opId) : undefined;
  const availableActions: ResolutionAction[] | undefined = operation
    ? operation.type === 'CreateList'
      ? ['adopt', 'retry', 'abort']
      : ['retry', 'accept-current', 'abort']
    : undefined;

  return {
    runId,
    status,
    resumable,
    requiresReview,
    blockedOperation: operation ? { opId: operation.opId, type: operation.type } : undefined,
    availableActions,
    totalEvents: events.length,
    appliedOperations: result?.appliedOperations ?? [],
    failedOperation: result?.failedOperation,
    startedAt: result?.startedAt ?? events[0]?.timestamp,
    finishedAt: result?.finishedAt
  };
}
