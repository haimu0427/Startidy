import crypto from 'node:crypto';
import type { Plan } from '../generated/plan.js';
import type { Snapshot } from '../generated/snapshot.js';
import type { Review } from '../generated/review.js';

export interface PlannedOperation {
  opId: string;
  type: 'CreateList' | 'UpdateList' | 'SetMemberships' | 'DeleteList';
  params: Record<string, unknown>;
  dependencies: string[];
  sourceDecisionRepoId?: string | null;
}

export interface DiffResult {
  operations: PlannedOperation[];
  summary: {
    totalCandidates: number;
    creates: number;
    updates: number;
    deletes: number;
    membershipChanges: number;
    deferred: number;
    ignored: number;
  };
}

export function computeDiff(plan: Plan, snapshot: Snapshot): DiffResult {
  const operations: PlannedOperation[] = [];
  const createOpIdByKey = new Map<string, string>();

  // 1. CreateList operations
  for (const createItem of plan.lists.create) {
    const opId = `op_create_${createItem.key}`;
    createOpIdByKey.set(createItem.key, opId);
    operations.push({
      opId,
      type: 'CreateList',
      params: {
        key: createItem.key,
        name: createItem.name,
        description: createItem.description ?? null,
        isPrivate: createItem.isPrivate
      },
      dependencies: [],
      sourceDecisionRepoId: null
    });
  }

  // 2. UpdateList operations
  for (const updateItem of plan.lists.update) {
    const opId = `op_update_${updateItem.listId}`;
    operations.push({
      opId,
      type: 'UpdateList',
      params: {
        listId: updateItem.listId,
        changes: updateItem.changes,
        reason: updateItem.reason
      },
      dependencies: [],
      sourceDecisionRepoId: null
    });
  }

  // 3. SetMemberships operations
  // Map repoId -> current listIds from snapshot
  const repoCurrentLists = new Map<string, Set<string>>();
  for (const list of snapshot.lists) {
    for (const repoId of list.repositoryIds) {
      let set = repoCurrentLists.get(repoId);
      if (!set) {
        set = new Set<string>();
        repoCurrentLists.set(repoId, set);
      }
      set.add(list.id);
    }
  }

  let deferredCount = 0;
  let ignoredCount = 0;
  const membershipRemovalOpsByListId = new Map<string, string[]>();

  for (const decision of plan.decisions) {
    if (decision.outcome === 'defer') {
      deferredCount++;
      continue;
    }
    if (decision.outcome === 'ignore') {
      ignoredCount++;
      continue;
    }
    if (decision.outcome === 'keep') {
      continue;
    }

    if (decision.outcome === 'assign') {
      const currentSet = repoCurrentLists.get(decision.repoId) ?? new Set<string>();

      const existingListIdsToAdd: string[] = [];
      const listKeysToAdd: string[] = [];
      const dependencies: string[] = [];

      for (const target of decision.addTo) {
        if ('listId' in target) {
          if (!currentSet.has(target.listId)) {
            existingListIdsToAdd.push(target.listId);
          }
        } else if ('newListKey' in target) {
          listKeysToAdd.push(target.newListKey);
          const dep = createOpIdByKey.get(target.newListKey);
          if (dep) {
            dependencies.push(dep);
          }
        }
      }

      const listIdsToRemove: string[] = [];
      for (const target of decision.removeFrom) {
        if (currentSet.has(target.listId)) {
          listIdsToRemove.push(target.listId);
        }
      }

      // If nothing is actually being added or removed, no operation is needed
      if (existingListIdsToAdd.length === 0 && listKeysToAdd.length === 0 && listIdsToRemove.length === 0) {
        continue;
      }

      const opId = `op_memberships_${decision.repoId}`;
      operations.push({
        opId,
        type: 'SetMemberships',
        params: {
          repositoryId: decision.repoId,
          existingListIdsToAdd: existingListIdsToAdd.sort(),
          listKeysToAdd: listKeysToAdd.sort(),
          listIdsToRemove: listIdsToRemove.sort(),
          expectedCurrentListIds: Array.from(currentSet).sort()
        },
        dependencies: dependencies.sort(),
        sourceDecisionRepoId: decision.repoId
      });

      for (const remId of listIdsToRemove) {
        const listOps = membershipRemovalOpsByListId.get(remId) ?? [];
        listOps.push(opId);
        membershipRemovalOpsByListId.set(remId, listOps);
      }
    }
  }

  // 4. DeleteList operations
  for (const deleteItem of plan.lists.delete) {
    const opId = `op_delete_${deleteItem.listId}`;
    // Depends on all membership operations that removed members from this list
    const deps = (membershipRemovalOpsByListId.get(deleteItem.listId) ?? []).slice().sort();

    operations.push({
      opId,
      type: 'DeleteList',
      params: {
        listId: deleteItem.listId,
        reason: deleteItem.reason
      },
      dependencies: deps,
      sourceDecisionRepoId: null
    });
  }

  const membershipChanges = operations.filter((op) => op.type === 'SetMemberships').length;

  return {
    operations,
    summary: {
      totalCandidates: plan.decisions.length,
      creates: plan.lists.create.length,
      updates: plan.lists.update.length,
      deletes: plan.lists.delete.length,
      membershipChanges,
      deferred: deferredCount,
      ignored: ignoredCount
    }
  };
}

export function computeReviewDigest(plan: Plan, baseSnapshotId: string, stateRevision: number, operations: PlannedOperation[]): string {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(plan));
  hash.update(baseSnapshotId);
  hash.update(String(stateRevision));
  hash.update(JSON.stringify(operations));
  return hash.digest('hex');
}

export function createReview(options: {
  plan: Plan;
  snapshot: Snapshot;
  now?: Date;
}): Review {
  const { plan, snapshot, now = new Date() } = options;
  const { operations, summary } = computeDiff(plan, snapshot);
  const stateRevision = snapshot.stateRevision;
  const digest = computeReviewDigest(plan, snapshot.snapshotId, stateRevision, operations);
  const reviewId = `rev_${now.getTime()}_${crypto.randomBytes(4).toString('hex')}`;

  return {
    schemaVersion: '1.0',
    reviewId,
    createdAt: now.toISOString(),
    account: {
      hostname: plan.account.hostname,
      viewerId: plan.account.viewerId
    },
    baseSnapshotId: snapshot.snapshotId,
    stateRevision,
    plan,
    digest,
    operations,
    summary
  };
}
