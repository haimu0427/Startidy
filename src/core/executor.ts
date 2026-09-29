import type { GitHubPort, StorePort, LockHandle, AccountProfile, AccountLedger, RunResult } from './ports.js';
import type { Review } from '../generated/review.js';
import { DomainError } from './errors.js';

export interface ExecuteOptions {
  github: GitHubPort;
  store: StorePort;
  review: Review;
  runId?: string;
  isResume?: boolean;
}

export async function executeReview(options: ExecuteOptions): Promise<RunResult> {
  const { github, store, review, isResume = false } = options;
  const runId = options.runId ?? (isResume ? review.reviewId : `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

  // 1. Acquire account lock
  let lock: LockHandle;
  try {
    lock = await store.acquireLock(review.account, runId);
  } catch (err) {
    throw err;
  }

  try {
    // 2. Verify identity
    const viewer = await github.getViewer();
    if (viewer.viewerId !== review.account.viewerId || viewer.hostname !== review.account.hostname) {
      throw new DomainError({
        code: 'AUTH_FAILED',
        message: `Current GitHub identity (${viewer.hostname}/${viewer.viewerId}) does not match review account (${review.account.hostname}/${review.account.viewerId})`
      });
    }

    // 3. Setup run tracking
    if (!isResume) {
      await store.createRun(review.account, runId, review);
      await store.appendRunEvent(review.account, runId, {
        eventId: `evt_${Date.now()}_start`,
        timestamp: new Date().toISOString(),
        runId,
        phase: 'run_start'
      });
    }

    // 4. Load past events to skip already verified operations
    const pastEvents = await store.getRunEvents(review.account, runId);
    const verifiedOpIds = new Set<string>();
    const createdKeyMap: Record<string, string> = {};

    for (const evt of pastEvents) {
      if (evt.phase === 'op_verified' && evt.opId) {
        verifiedOpIds.add(evt.opId);
        if (evt.details?.key && evt.details?.realListId) {
          createdKeyMap[String(evt.details.key)] = String(evt.details.realListId);
        }
      }
    }

    const appliedOperations: string[] = Array.from(verifiedOpIds);

    // 5. Load or initialize Profile and Ledger
    const profile: AccountProfile = (await store.loadProfile(review.account)) ?? {
      schemaVersion: '1.0',
      account: { ...review.account, login: viewer.login },
      stateRevision: 0,
      initialized: false,
      preferences: {},
      ignoredRepoIds: []
    };

    const ledger: AccountLedger = await store.loadLedger(review.account);
    const baseSnapshot = await store.loadSnapshot(review.account, review.baseSnapshotId);
    const snapshotRepoMemberships = new Map<string, string[]>();
    if (baseSnapshot) {
      for (const list of baseSnapshot.lists) {
        for (const repoId of list.repositoryIds) {
          const existing = snapshotRepoMemberships.get(repoId) ?? [];
          existing.push(list.id);
          snapshotRepoMemberships.set(repoId, existing);
        }
      }
    }

    // 6. Execute operations in review order
    for (const op of review.operations) {
      if (verifiedOpIds.has(op.opId)) {
        continue;
      }

      await store.appendRunEvent(review.account, runId, {
        eventId: `evt_${Date.now()}_${op.opId}_pre`,
        timestamp: new Date().toISOString(),
        runId,
        opId: op.opId,
        phase: 'op_pre_flight',
        details: { type: op.type }
      });

      try {
        if (op.type === 'CreateList') {
          const params = op.params as {
            key: string;
            name: string;
            description?: string | null;
            isPrivate: boolean;
          };

          const created = await github.createList({
            name: params.name,
            description: params.description ?? null,
            isPrivate: params.isPrivate
          });

          createdKeyMap[params.key] = created.id;

          await store.appendRunEvent(review.account, runId, {
            eventId: `evt_${Date.now()}_${op.opId}_done`,
            timestamp: new Date().toISOString(),
            runId,
            opId: op.opId,
            phase: 'op_verified',
            details: { key: params.key, realListId: created.id }
          });
          appliedOperations.push(op.opId);
        } else if (op.type === 'UpdateList') {
          const params = op.params as {
            listId: string;
            changes: { name?: string; description?: string | null; isPrivate?: boolean };
          };

          await github.updateList({
            listId: params.listId,
            changes: params.changes
          });

          await store.appendRunEvent(review.account, runId, {
            eventId: `evt_${Date.now()}_${op.opId}_done`,
            timestamp: new Date().toISOString(),
            runId,
            opId: op.opId,
            phase: 'op_verified'
          });
          appliedOperations.push(op.opId);
        } else if (op.type === 'SetMemberships') {
          const params = op.params as {
            repositoryId: string;
            existingListIdsToAdd: string[];
            listKeysToAdd: string[];
            listIdsToRemove: string[];
            expectedCurrentListIds: string[];
          };

          const resolvedNewListIds: string[] = [];
          for (const key of params.listKeysToAdd) {
            const realId = createdKeyMap[key];
            if (!realId) {
              throw new DomainError({
                code: 'OPERATION_FAILED',
                message: `Cannot resolve newly created list ID for key: ${key}`
              });
            }
            resolvedNewListIds.push(realId);
          }

          // Formula: (expectedCurrent ∪ existingAdds ∪ resolvedNewAdds) \ removes
          const targetListIds = new Set<string>(params.expectedCurrentListIds);
          for (const id of params.existingListIdsToAdd) targetListIds.add(id);
          for (const id of resolvedNewListIds) targetListIds.add(id);
          for (const id of params.listIdsToRemove) targetListIds.delete(id);

          const finalArray = Array.from(targetListIds);

          await github.setMemberships({
            repositoryId: params.repositoryId,
            listIds: finalArray
          });

          // Update ledger entry
          ledger.entries[params.repositoryId] = {
            repoId: params.repositoryId,
            lastOutcome: 'assign',
            lastRunId: runId,
            lastVerifiedAt: new Date().toISOString(),
            assignedListIds: finalArray
          };

          await store.appendRunEvent(review.account, runId, {
            eventId: `evt_${Date.now()}_${op.opId}_done`,
            timestamp: new Date().toISOString(),
            runId,
            opId: op.opId,
            phase: 'op_verified'
          });
          appliedOperations.push(op.opId);
        } else if (op.type === 'DeleteList') {
          const params = op.params as { listId: string; reason: string };

          await github.deleteList({ listId: params.listId });

          await store.appendRunEvent(review.account, runId, {
            eventId: `evt_${Date.now()}_${op.opId}_done`,
            timestamp: new Date().toISOString(),
            runId,
            opId: op.opId,
            phase: 'op_verified'
          });
          appliedOperations.push(op.opId);
        }
      } catch (opErr: unknown) {
        const errMsg = opErr instanceof Error ? opErr.message : String(opErr);
        const errCode = opErr instanceof DomainError ? opErr.code : 'OPERATION_FAILED';

        await store.appendRunEvent(review.account, runId, {
          eventId: `evt_${Date.now()}_${op.opId}_fail`,
          timestamp: new Date().toISOString(),
          runId,
          opId: op.opId,
          phase: 'op_failed',
          details: { error: errMsg, code: errCode }
        });

        // Save ledger so far
        await store.saveLedger(review.account, ledger);

        const partialResult: RunResult = {
          runId,
          status: 'partial',
          startedAt: new Date().toISOString(),
          appliedOperations,
          failedOperation: {
            opId: op.opId,
            error: errMsg,
            code: errCode
          },
          createdListKeyMap: createdKeyMap
        };

        await store.saveRunResult(review.account, runId, partialResult);

        throw new DomainError({
          code: 'OPERATION_FAILED',
          message: `Execution halted at operation ${op.opId}: ${errMsg}. Use apply --resume ${runId} to resume.`,
          details: { runId, appliedCount: appliedOperations.length, failedOpId: op.opId },
          cause: opErr
        });
      }
    }

    // 7. Update ledger for keep/defer/ignore decisions
    for (const decision of review.plan.decisions) {
      if (decision.outcome === 'keep') {
        const existingListIds =
          snapshotRepoMemberships.get(decision.repoId) ??
          ledger.entries[decision.repoId]?.assignedListIds ??
          [];
        ledger.entries[decision.repoId] = {
          repoId: decision.repoId,
          lastOutcome: 'keep',
          lastRunId: runId,
          lastVerifiedAt: new Date().toISOString(),
          assignedListIds: existingListIds.slice().sort(),
          reason: decision.reason
        };
      } else if (decision.outcome === 'defer') {
        ledger.entries[decision.repoId] = {
          repoId: decision.repoId,
          lastOutcome: 'defer',
          lastRunId: runId,
          lastVerifiedAt: new Date().toISOString(),
          assignedListIds: [],
          reason: decision.reason
        };
      } else if (decision.outcome === 'ignore') {
        ledger.entries[decision.repoId] = {
          repoId: decision.repoId,
          lastOutcome: 'ignore',
          lastRunId: runId,
          lastVerifiedAt: new Date().toISOString(),
          assignedListIds: [],
          reason: decision.reason
        };
        if (!profile.ignoredRepoIds.includes(decision.repoId)) {
          profile.ignoredRepoIds.push(decision.repoId);
        }
      }
    }

    // 8. Commit profile and ledger
    profile.stateRevision += 1;
    profile.initialized = true;
    if (review.plan.preferencesUpdate) {
      profile.preferences = {
        ...profile.preferences,
        ...review.plan.preferencesUpdate
      };
    }

    await store.saveLedger(review.account, ledger);
    await store.saveProfile(review.account, profile);

    const completedResult: RunResult = {
      runId,
      status: 'completed',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      appliedOperations,
      createdListKeyMap: createdKeyMap
    };

    await store.saveRunResult(review.account, runId, completedResult);

    await store.appendRunEvent(review.account, runId, {
      eventId: `evt_${Date.now()}_finish`,
      timestamp: new Date().toISOString(),
      runId,
      phase: 'run_finish'
    });

    return completedResult;
  } finally {
    await lock.release();
  }
}
