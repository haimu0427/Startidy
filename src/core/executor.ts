import type {
  AccountLedger,
  AccountProfile,
  GitHubPort,
  RemoteListInfo,
  RunEvent,
  RunResult,
  StorePort
} from './ports.js';
import type { Review } from '../generated/review.js';
import { DomainError } from './errors.js';
import { normalizeListName } from './plan.js';

export interface ExecuteOptions {
  github: GitHubPort;
  store: StorePort;
  review: Review;
  runId?: string;
  isResume?: boolean;
}

type Operation = Review['operations'][number];
type Details = Record<string, unknown>;
type Reconciliation =
  | { kind: 'verified'; details: Details }
  | { kind: 'retry' }
  | { kind: 'needs_review'; message: string; details?: Details };

const now = (): string => new Date().toISOString();

function sameIds(left: string[], right: string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameList(left: RemoteListInfo, right: RemoteListInfo): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    (left.description ?? null) === (right.description ?? null) &&
    left.isPrivate === right.isPrivate &&
    (left.unsupportedItemCount ?? 0) === (right.unsupportedItemCount ?? 0) &&
    sameIds(left.repositoryIds, right.repositoryIds)
  );
}

function sameListMetadata(left: RemoteListInfo, right: RemoteListInfo): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    (left.description ?? null) === (right.description ?? null) &&
    left.isPrivate === right.isPrivate
  );
}

function membershipsFor(lists: RemoteListInfo[], repositoryId: string): string[] {
  return lists.filter((list) => list.repositoryIds.includes(repositoryId)).map((list) => list.id).sort();
}

function matchesChanges(
  list: RemoteListInfo,
  changes: { name?: string; description?: string | null; isPrivate?: boolean }
): boolean {
  return (
    (changes.name === undefined || list.name === changes.name) &&
    (!('description' in changes) || (list.description ?? null) === changes.description) &&
    (changes.isPrivate === undefined || list.isPrivate === changes.isPrivate)
  );
}

function matchesCreate(
  list: RemoteListInfo,
  params: { name: string; description?: string | null; isPrivate: boolean }
): boolean {
  return (
    list.name === params.name &&
    (list.description ?? null) === (params.description ?? null) &&
    list.isPrivate === params.isPrivate
  );
}

function asList(value: unknown): RemoteListInfo | null {
  if (!value || typeof value !== 'object') return null;
  const list = value as Partial<RemoteListInfo>;
  if (
    typeof list.id !== 'string' ||
    typeof list.name !== 'string' ||
    typeof list.isPrivate !== 'boolean' ||
    !Array.isArray(list.repositoryIds)
  ) {
    return null;
  }
  return {
    id: list.id,
    name: list.name,
    description: list.description ?? null,
    isPrivate: list.isPrivate,
    repositoryIds: list.repositoryIds.map(String),
    unsupportedItemCount: typeof list.unsupportedItemCount === 'number' ? list.unsupportedItemCount : 0
  };
}

function asStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  return error instanceof DomainError ? error.code : 'OPERATION_FAILED';
}

function lastEvent(events: RunEvent[], opId: string): RunEvent | undefined {
  return [...events].reverse().find((event) => event.opId === opId);
}

function inFlightEvent(events: RunEvent[], opId: string): RunEvent | undefined {
  return [...events].reverse().find((event) => event.opId === opId && event.phase === 'op_in_flight');
}

async function reconcileInFlight(github: GitHubPort, op: Operation, event: RunEvent): Promise<Reconciliation> {
  const evidence = event.details ?? {};
  try {
    if (op.type === 'CreateList') {
      const params = op.params as {
        key: string;
        name: string;
        description?: string | null;
        isPrivate: boolean;
      };
      const beforeListIds = asStringArray(evidence.beforeListIds);
      if (!beforeListIds) {
        return { kind: 'needs_review', message: 'CreateList recovery evidence is missing the pre-flight list IDs' };
      }
      const before = new Set(beforeListIds);
      const matches = (await github.readLists()).filter((list) => !before.has(list.id) && matchesCreate(list, params));
      if (matches.length === 1) {
        return { kind: 'verified', details: { key: params.key, realListId: matches[0].id, reconciled: true } };
      }
      return {
        kind: 'needs_review',
        message:
          matches.length === 0
            ? 'CreateList result cannot be proven after an interrupted request; refusing to create a possible duplicate'
            : 'CreateList recovery found multiple matching newly created lists; manual resolution is required',
        details: { candidateListIds: matches.map((list) => list.id) }
      };
    }

    if (op.type === 'UpdateList') {
      const params = op.params as {
        listId: string;
        changes: { name?: string; description?: string | null; isPrivate?: boolean };
      };
      const before = asList(evidence.before);
      const list = await github.getList(params.listId);
      if (list && matchesChanges(list, params.changes)) return { kind: 'verified', details: { reconciled: true } };
      if (list && before && sameList(list, before)) return { kind: 'retry' };
      return { kind: 'needs_review', message: 'UpdateList remote state differs from both the recorded before-state and requested target' };
    }

    if (op.type === 'SetMemberships') {
      const params = op.params as { repositoryId: string };
      const before = asStringArray(evidence.beforeListIds);
      const target = asStringArray(evidence.targetListIds);
      if (!before || !target) return { kind: 'needs_review', message: 'SetMemberships recovery evidence is incomplete' };
      const current = membershipsFor(await github.readLists(), params.repositoryId);
      if (sameIds(current, target)) return { kind: 'verified', details: { finalListIds: target, reconciled: true } };
      if (sameIds(current, before)) return { kind: 'retry' };
      return {
        kind: 'needs_review',
        message: 'SetMemberships remote state differs from both the recorded before-state and target',
        details: { observedListIds: current, targetListIds: target }
      };
    }

    const params = op.params as { listId: string };
    const before = asList(evidence.before);
    const list = await github.getList(params.listId);
    if (!list) return { kind: 'verified', details: { reconciled: true } };
    if (before && sameList(list, before)) return { kind: 'retry' };
    return { kind: 'needs_review', message: 'DeleteList remote state differs from both the recorded before-state and target' };
  } catch (error) {
    return { kind: 'needs_review', message: `Unable to read remote state while reconciling ${op.opId}: ${errorMessage(error)}` };
  }
}

export async function executeReview(options: ExecuteOptions): Promise<RunResult> {
  const { github, store, review } = options;
  let runId = options.runId;
  let isResume = options.isResume ?? false;

  if (!runId && !isResume) {
    const existing = await store.findRunByReviewDigest(review.account, review.digest);
    if (existing) {
      if (existing.result?.status === 'completed') return existing.result;
      runId = existing.runId;
      isResume = true;
    }
  }
  if (!runId) runId = `run_${Date.now()}_${review.digest.slice(0, 12)}`;

  const lock = await store.acquireLock(review.account, runId);
  try {
    const viewer = await github.getViewer();
    if (viewer.viewerId !== review.account.viewerId || viewer.hostname !== review.account.hostname) {
      throw new DomainError({
        code: 'AUTH_FAILED',
        message: `Current GitHub identity (${viewer.hostname}/${viewer.viewerId}) does not match review account (${review.account.hostname}/${review.account.viewerId})`
      });
    }

    const existingResult = await store.loadRunResult(review.account, runId);
    if (existingResult?.status === 'completed') return existingResult;
    if (existingResult?.status === 'cancelled') {
      throw new DomainError({
        code: 'STATE_CONFLICT',
        message: `Run ${runId} was cancelled and cannot be resumed`
      });
    }
    const terminalEvents = await store.getRunEvents(review.account, runId);
    if (terminalEvents.some((event) => event.phase === 'run_cancelled')) {
      throw new DomainError({
        code: 'STATE_CONFLICT',
        message: `Run ${runId} was cancelled and cannot be resumed`
      });
    }

    const pending = await store.listPendingRuns(review.account);
    const conflictingPendingRuns = pending.filter((run) => run.runId !== runId);
    if ((!isResume && pending.length > 0) || conflictingPendingRuns.length > 0) {
      throw new DomainError({
        code: 'RESTORE_REQUIRED',
        message: 'An unfinished run must be resumed or resolved before this review can execute',
        details: { runIds: pending.map((run) => run.runId) }
      });
    }

    const baseSnapshot = await store.loadSnapshot(review.account, review.baseSnapshotId);
    if (!baseSnapshot) {
      throw new DomainError({ code: 'PLAN_STALE', message: `Base snapshot is unavailable for review ${review.reviewId}` });
    }

    const profile: AccountProfile = (await store.loadProfile(review.account)) ?? {
      schemaVersion: '1.0',
      account: { ...review.account, login: viewer.login },
      stateRevision: 0,
      initialized: false,
      preferences: {},
      ignoredRepoIds: []
    };
    const targetRevision = review.stateRevision + 1;
    if (!isResume && profile.stateRevision !== review.stateRevision) {
      throw new DomainError({
        code: 'PLAN_STALE',
        message: `Review expects state revision ${review.stateRevision}, but current state revision is ${profile.stateRevision}`
      });
    }
    if (isResume && profile.stateRevision !== review.stateRevision && profile.stateRevision !== targetRevision) {
      throw new DomainError({ code: 'STATE_CONFLICT', message: `Cannot resume run ${runId} from state revision ${profile.stateRevision}` });
    }

    if (!isResume) {
      await store.createRun(review.account, runId, review);
      await store.appendRunEvent(review.account, runId, {
        eventId: `evt_${Date.now()}_start`,
        timestamp: now(),
        runId,
        phase: 'run_start'
      });
    }

    const events = await store.getRunEvents(review.account, runId);
    const ledger: AccountLedger = await store.loadLedger(review.account);
    const verifiedOpIds = new Set<string>();
    const createdListKeyMap: Record<string, string> = {};

    const applyVerifiedEffect = (op: Operation, event: RunEvent): void => {
      if (op.type === 'CreateList' && event.details?.key && event.details?.realListId) {
        createdListKeyMap[String(event.details.key)] = String(event.details.realListId);
      }
      if (op.type === 'SetMemberships') {
        const finalListIds = asStringArray(event.details?.finalListIds);
        if (finalListIds) {
          const params = op.params as { repositoryId: string };
          ledger.entries[params.repositoryId] = {
            repoId: params.repositoryId,
            lastOutcome: 'assign',
            lastRunId: runId,
            lastVerifiedAt: event.timestamp,
            assignedListIds: [...finalListIds].sort()
          };
        }
      }
    };

    for (const event of events) {
      if (event.phase !== 'op_verified' || !event.opId) continue;
      const op = review.operations.find((candidate) => candidate.opId === event.opId);
      if (!op) continue;
      verifiedOpIds.add(op.opId);
      applyVerifiedEffect(op, event);
    }

    const startedAt = existingResult?.startedAt ?? events.find((event) => event.phase === 'run_start')?.timestamp ?? now();
    const appliedOperations = (): string[] => review.operations.filter((op) => verifiedOpIds.has(op.opId)).map((op) => op.opId);
    const appendEvent = async (event: RunEvent): Promise<void> => {
      await store.appendRunEvent(review.account, runId, event);
      events.push(event);
    };
    const markVerified = async (op: Operation, details: Details): Promise<void> => {
      const event: RunEvent = {
        eventId: `evt_${Date.now()}_${op.opId}_verified`,
        timestamp: now(),
        runId,
        opId: op.opId,
        phase: 'op_verified',
        details
      };
      await appendEvent(event);
      verifiedOpIds.add(op.opId);
      applyVerifiedEffect(op, event);
    };
    const stopPartial = async (op: Operation, message: string, code: string): Promise<never> => {
      await appendEvent({
        eventId: `evt_${Date.now()}_${op.opId}_failed`, timestamp: now(), runId, opId: op.opId,
        phase: 'op_failed', details: { error: message, code }
      });
      await store.saveLedger(review.account, ledger);
      await store.saveRunResult(review.account, runId, {
        runId, status: 'partial', startedAt, appliedOperations: appliedOperations(),
        failedOperation: { opId: op.opId, error: message, code }, createdListKeyMap
      });
      throw new DomainError({
        code: 'OPERATION_FAILED',
        message: `Execution halted at operation ${op.opId}: ${message}. Use apply --resume ${runId} to resume.`,
        details: { runId, failedOpId: op.opId }
      });
    };
    const stopNeedsReview = async (op: Operation, message: string, details?: Details): Promise<never> => {
      await appendEvent({
        eventId: `evt_${Date.now()}_${op.opId}_conflict`, timestamp: now(), runId, opId: op.opId,
        phase: 'op_conflict', details: { error: message, ...(details ?? {}) }
      });
      await store.saveLedger(review.account, ledger);
      await store.saveRunResult(review.account, runId, {
        runId, status: 'needs_review', startedAt, appliedOperations: appliedOperations(),
        failedOperation: { opId: op.opId, error: message, code: 'OPERATION_UNCERTAIN' }, createdListKeyMap
      });
      throw new DomainError({
        code: 'OPERATION_UNCERTAIN', message: `Execution requires manual review at operation ${op.opId}: ${message}`,
        details: { runId, failedOpId: op.opId, ...(details ?? {}) }
      });
    };
    const resolveCreatedIds = (keys: string[]): string[] => keys.map((key) => {
      const id = createdListKeyMap[key];
      if (!id) throw new DomainError({ code: 'OPERATION_FAILED', message: `Cannot resolve newly created list ID for key: ${key}` });
      return id;
    });
    const verifyInFlight = async (op: Operation, inFlight: RunEvent, error?: unknown): Promise<'verified' | 'retry'> => {
      if (error) {
        await appendEvent({
          eventId: `evt_${Date.now()}_${op.opId}_uncertain`, timestamp: now(), runId, opId: op.opId,
          phase: 'op_uncertain', details: { error: errorMessage(error), code: errorCode(error) }
        });
      }
      const outcome = await reconcileInFlight(github, op, inFlight);
      if (outcome.kind === 'verified') {
        await markVerified(op, outcome.details);
        return 'verified';
      }
      if (outcome.kind === 'retry') return 'retry';
      return await stopNeedsReview(op, outcome.message, outcome.details);
    };
    const executeMutation = async (op: Operation, details: Details, mutate: () => Promise<void>): Promise<void> => {
      const inFlight: RunEvent = {
        eventId: `evt_${Date.now()}_${op.opId}_in_flight`, timestamp: now(), runId, opId: op.opId,
        phase: 'op_in_flight', details
      };
      await appendEvent(inFlight);
      let mutationError: unknown;
      try {
        await mutate();
      } catch (error) {
        mutationError = error;
      }
      const outcome = await verifyInFlight(op, inFlight, mutationError);
      if (outcome === 'retry') {
        await stopPartial(
          op,
          mutationError ? errorMessage(mutationError) : 'Remote mutation did not reach its target and can be retried',
          mutationError ? errorCode(mutationError) : 'OPERATION_FAILED'
        );
      }
    };

    const applyResolution = async (op: Operation, event: RunEvent): Promise<'verified' | 'retry'> => {
      const action = event.details?.action;
      if (action === 'retry') return 'retry';

      if (action === 'adopt' && op.type === 'CreateList') {
        const params = op.params as { key: string; name: string; description?: string | null; isPrivate: boolean };
        const realListId = event.details?.realListId;
        if (typeof realListId !== 'string') {
          throw new DomainError({ code: 'STATE_CONFLICT', message: `CreateList resolution for ${op.opId} is missing realListId` });
        }
        const list = await github.getList(realListId);
        if (!list || !matchesCreate(list, params)) {
          throw new DomainError({ code: 'STATE_CONFLICT', message: `Adopted list ${realListId} no longer matches the reviewed CreateList` });
        }
        await markVerified(op, { key: params.key, realListId, resolution: 'adopt' });
        return 'verified';
      }

      if (action === 'accept-current' && op.type !== 'CreateList') {
        if (op.type === 'SetMemberships') {
          const repositoryId = (op.params as { repositoryId: string }).repositoryId;
          await markVerified(op, {
            finalListIds: membershipsFor(await github.readLists(), repositoryId),
            resolution: 'accept-current'
          });
        } else {
          await markVerified(op, { resolution: 'accept-current' });
        }
        return 'verified';
      }

      throw new DomainError({ code: 'STATE_CONFLICT', message: `Resolution action is invalid for operation ${op.opId}` });
    };

    const baseLists = new Map(baseSnapshot.lists.map((list) => [list.id, list]));
    for (const op of review.operations) {
      if (verifiedOpIds.has(op.opId)) continue;
      const previous = lastEvent(events, op.opId);
      if (previous?.phase === 'op_resolution') {
        const resolved = await applyResolution(op, previous);
        if (resolved === 'verified') continue;
      } else if (previous?.phase === 'op_conflict') {
        throw new DomainError({
          code: 'OPERATION_UNCERTAIN',
          message: `Operation ${op.opId} requires an explicit resolution before it can resume`,
          details: { runId, failedOpId: op.opId, ...(previous.details ?? {}) }
        });
      } else if (previous?.phase === 'op_in_flight' || previous?.phase === 'op_uncertain') {
        const inFlight = inFlightEvent(events, op.opId);
        if (!inFlight) await stopNeedsReview(op, 'Operation is marked uncertain without durable in-flight evidence');
        const outcome = await verifyInFlight(op, inFlight!);
        if (outcome === 'verified') continue;
      }

      await appendEvent({
        eventId: `evt_${Date.now()}_${op.opId}_pre_flight`, timestamp: now(), runId, opId: op.opId,
        phase: 'op_pre_flight', details: { type: op.type }
      });

      if (op.type === 'CreateList') {
        const params = op.params as { key: string; name: string; description?: string | null; isPrivate: boolean };
        const before = await github.readLists();
        const sameNameLists = before.filter((list) => normalizeListName(list.name) === normalizeListName(params.name));
        if (sameNameLists.length > 0) {
          await stopNeedsReview(op, 'A same-name List appeared after preview; refusing to create a duplicate', {
            reason: 'create_name_collision',
            candidateLists: sameNameLists.map((list) => ({
              id: list.id,
              name: list.name,
              description: list.description ?? null,
              isPrivate: list.isPrivate
            }))
          });
        }
        await executeMutation(op, {
          beforeListIds: before.map((list) => list.id),
          expected: { key: params.key, name: params.name, description: params.description ?? null, isPrivate: params.isPrivate }
        }, async () => {
          const created = await github.createList({ name: params.name, description: params.description ?? null, isPrivate: params.isPrivate });
          const list = await github.getList(created.id);
          if (!list || !matchesCreate(list, params)) {
            throw new DomainError({ code: 'OPERATION_UNCERTAIN', message: `CreateList ${params.key} could not be verified after the mutation` });
          }
        });
        continue;
      }

      if (op.type === 'UpdateList') {
        const params = op.params as { listId: string; changes: { name?: string; description?: string | null; isPrivate?: boolean } };
        const baseline = baseLists.get(params.listId);
        const current = await github.getList(params.listId);
        if (!baseline || !current) await stopNeedsReview(op, 'UpdateList target is missing from the reviewed baseline or current remote state');
        const reviewedList = baseline!;
        const currentList = current!;
        if (matchesChanges(currentList, params.changes)) {
          await markVerified(op, { reconciled: true, noWrite: true });
          continue;
        }
        const changedFields = Object.keys(params.changes).filter((field) => {
          if (field === 'description') return (currentList.description ?? null) !== (reviewedList.description ?? null);
          return currentList[field as 'name' | 'isPrivate'] !== reviewedList[field as 'name' | 'isPrivate'];
        });
        if (changedFields.length > 0) await stopNeedsReview(op, 'UpdateList fields changed remotely after preview', { changedFields });
        await executeMutation(op, { before: currentList, target: params.changes }, async () => {
          await github.updateList({ listId: params.listId, changes: params.changes });
        });
        continue;
      }

      if (op.type === 'SetMemberships') {
        const params = op.params as {
          repositoryId: string; existingListIdsToAdd: string[]; listKeysToAdd: string[]; listIdsToRemove: string[];
        };
        const lists = await github.readLists();
        const visibleListIds = new Set(lists.map((list) => list.id));
        const newListIds = resolveCreatedIds(params.listKeysToAdd);
        for (const id of [...params.existingListIdsToAdd, ...newListIds]) {
          if (!visibleListIds.has(id)) await stopNeedsReview(op, `Membership target list ${id} no longer exists remotely`);
        }
        const beforeListIds = membershipsFor(lists, params.repositoryId);
        const target = new Set(beforeListIds);
        for (const id of params.existingListIdsToAdd) target.add(id);
        for (const id of newListIds) target.add(id);
        for (const id of params.listIdsToRemove) target.delete(id);
        const targetListIds = [...target].sort();
        if (sameIds(beforeListIds, targetListIds)) {
          await markVerified(op, { finalListIds: targetListIds, reconciled: true, noWrite: true });
          continue;
        }
        await executeMutation(op, { beforeListIds, targetListIds }, async () => {
          await github.setMemberships({ repositoryId: params.repositoryId, listIds: targetListIds });
        });
        continue;
      }

      const params = op.params as { listId: string };
      const baseline = baseLists.get(params.listId);
      const current = await github.getList(params.listId);
      if (!current) {
        await markVerified(op, { reconciled: true, noWrite: true });
        continue;
      }
      if (!baseline || !sameListMetadata(current, baseline)) {
        await stopNeedsReview(op, 'DeleteList target changed after preview or no longer matches the reviewed baseline');
      }
      if (current.repositoryIds.length > 0 || (current.unsupportedItemCount ?? 0) > 0) {
        await stopNeedsReview(op, 'DeleteList target is no longer empty and cannot be deleted safely', {
          repositoryIds: current.repositoryIds, unsupportedItemCount: current.unsupportedItemCount ?? 0
        });
      }
      await executeMutation(op, { before: current }, async () => {
        await github.deleteList({ listId: params.listId });
      });
    }

    const snapshotMemberships = new Map<string, string[]>();
    for (const list of baseSnapshot.lists) {
      for (const repositoryId of list.repositoryIds) {
        const ids = snapshotMemberships.get(repositoryId) ?? [];
        ids.push(list.id);
        snapshotMemberships.set(repositoryId, ids);
      }
    }
    for (const decision of review.plan.decisions) {
      if (decision.outcome === 'keep') {
        const assignedListIds = snapshotMemberships.get(decision.repoId) ?? ledger.entries[decision.repoId]?.assignedListIds ?? [];
        ledger.entries[decision.repoId] = {
          repoId: decision.repoId, lastOutcome: 'keep', lastRunId: runId, lastVerifiedAt: now(),
          assignedListIds: [...assignedListIds].sort(), reason: decision.reason
        };
      } else if (decision.outcome === 'defer' || decision.outcome === 'ignore') {
        ledger.entries[decision.repoId] = {
          repoId: decision.repoId, lastOutcome: decision.outcome, lastRunId: runId, lastVerifiedAt: now(),
          assignedListIds: [], reason: decision.reason
        };
        if (decision.outcome === 'ignore' && !profile.ignoredRepoIds.includes(decision.repoId)) profile.ignoredRepoIds.push(decision.repoId);
      }
    }

    profile.stateRevision = targetRevision;
    profile.initialized = true;
    if (review.plan.preferencesUpdate) profile.preferences = { ...profile.preferences, ...review.plan.preferencesUpdate };
    await store.saveLedger(review.account, ledger);
    await store.saveProfile(review.account, profile);

    const completed: RunResult = {
      runId, status: 'completed', startedAt, finishedAt: now(), appliedOperations: appliedOperations(), createdListKeyMap
    };
    await store.saveRunResult(review.account, runId, completed);
    await appendEvent({ eventId: `evt_${Date.now()}_finish`, timestamp: now(), runId, phase: 'run_finish' });
    return completed;
  } finally {
    await lock.release();
  }
}
