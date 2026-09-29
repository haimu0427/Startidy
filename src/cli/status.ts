import type { GitHubPort, StorePort, RunStatus } from '../core/ports.js';
import { DomainError } from '../core/errors.js';

export interface StatusCommandResult {
  runId: string;
  status: RunStatus;
  resumable: boolean;
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

  if (!result && events.length === 0) {
    throw new DomainError({
      code: 'STATE_CONFLICT',
      message: `No execution records found for runId: ${runId}`
    });
  }

  const status: RunStatus = result?.status ?? (events.some((e) => e.phase === 'run_finish') ? 'completed' : 'partial');
  const resumable = status === 'partial' || status === 'failed';

  return {
    runId,
    status,
    resumable,
    totalEvents: events.length,
    appliedOperations: result?.appliedOperations ?? [],
    failedOperation: result?.failedOperation,
    startedAt: result?.startedAt ?? events[0]?.timestamp,
    finishedAt: result?.finishedAt
  };
}
