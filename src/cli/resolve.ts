import type { GitHubPort, ResolutionAction, RunEvent, StorePort } from '../core/ports.js';
import { DomainError } from '../core/errors.js';

const actions: ResolutionAction[] = ['adopt', 'retry', 'accept-current', 'abort'];

function latestConflict(events: RunEvent[]): RunEvent | undefined {
  return [...events].reverse().find((event) => event.phase === 'op_conflict' && event.opId);
}

export interface ResolveCommandResult {
  runId: string;
  opId?: string;
  action: ResolutionAction;
  status: 'needs_review' | 'cancelled';
  resumeRequired: boolean;
}

export async function runResolve(options: {
  github: GitHubPort;
  store: StorePort;
  runId: string;
  action: string;
  listId?: string;
}): Promise<ResolveCommandResult> {
  const { github, store, runId, listId } = options;
  if (!actions.includes(options.action as ResolutionAction)) {
    throw new DomainError({ code: 'PLAN_INVALID', message: `Unsupported resolution action: ${options.action}` });
  }
  const action = options.action as ResolutionAction;
  const viewer = await github.getViewer();
  const lock = await store.acquireLock(viewer, `resolve_${runId}`);
  try {
    const review = await store.loadReview(viewer, runId);
    const result = await store.loadRunResult(viewer, runId);
    const events = await store.getRunEvents(viewer, runId);
    if (!review || !result || result.status !== 'needs_review') {
      throw new DomainError({ code: 'STATE_CONFLICT', message: `Run ${runId} is not awaiting manual resolution` });
    }
    const conflict = latestConflict(events);
    if (!conflict?.opId) {
      throw new DomainError({ code: 'STATE_CONFLICT', message: `Run ${runId} has no resolvable conflict event` });
    }
    if (
      events.some(
        (event) => event.phase === 'op_resolution' && event.details?.conflictEventId === conflict.eventId
      )
    ) {
      throw new DomainError({ code: 'STATE_CONFLICT', message: `Conflict ${conflict.eventId} has already been resolved; resume the run` });
    }
    const op = review.operations.find((candidate) => candidate.opId === conflict.opId);
    if (!op) {
      throw new DomainError({ code: 'STATE_CONFLICT', message: `Conflict references unknown operation ${conflict.opId}` });
    }

    if (action === 'abort') {
      await store.saveRunResult(viewer, runId, {
        ...result,
        status: 'cancelled',
        finishedAt: new Date().toISOString()
      });
      await store.appendRunEvent(viewer, runId, {
        eventId: `evt_${Date.now()}_cancelled`,
        timestamp: new Date().toISOString(),
        runId,
        phase: 'run_cancelled',
        details: { action: 'abort', conflictEventId: conflict.eventId, opId: op.opId }
      });
      return { runId, opId: op.opId, action, status: 'cancelled', resumeRequired: false };
    }

    if (action === 'adopt') {
      if (op.type !== 'CreateList' || !listId) {
        throw new DomainError({ code: 'PLAN_INVALID', message: 'adopt requires a CreateList conflict and --list-id' });
      }
      const params = op.params as { key: string; name: string; description?: string | null; isPrivate: boolean };
      const list = await github.getList(listId);
      if (
        !list ||
        list.name !== params.name ||
        (list.description ?? null) !== (params.description ?? null) ||
        list.isPrivate !== params.isPrivate
      ) {
        throw new DomainError({ code: 'STATE_CONFLICT', message: `List ${listId} does not exactly match the blocked CreateList` });
      }

      const inFlight = [...events]
        .reverse()
        .find((event) => event.opId === op.opId && event.phase === 'op_in_flight');
      const beforeListIds = Array.isArray(inFlight?.details?.beforeListIds) ? inFlight.details.beforeListIds : [];
      if (beforeListIds.includes(listId)) {
        throw new DomainError({ code: 'STATE_CONFLICT', message: `List ${listId} existed before this CreateList operation` });
      }
    } else if (action === 'accept-current' && op.type === 'CreateList') {
      throw new DomainError({ code: 'PLAN_INVALID', message: 'accept-current is not valid for CreateList; use adopt, retry, or abort' });
    }

    await store.appendRunEvent(viewer, runId, {
      eventId: `evt_${Date.now()}_${op.opId}_resolution`,
      timestamp: new Date().toISOString(),
      runId,
      opId: op.opId,
      phase: 'op_resolution',
      details: {
        action,
        conflictEventId: conflict.eventId,
        ...(action === 'adopt' ? { realListId: listId } : {})
      }
    });

    return { runId, opId: op.opId, action, status: 'needs_review', resumeRequired: true };
  } finally {
    await lock.release();
  }
}
