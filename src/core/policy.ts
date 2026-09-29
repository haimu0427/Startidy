import type { Plan } from '../generated/plan.js';
import type { Snapshot } from '../generated/snapshot.js';
import type { AccountProfile } from './ports.js';
import { DomainError } from './errors.js';

export function validatePlanPolicy(options: {
  plan: Plan;
  snapshot: Snapshot;
  profile?: AccountProfile | null;
}): void {
  const { plan, snapshot, profile } = options;

  // 1. Account matching
  if (
    plan.account.hostname !== snapshot.account.hostname ||
    plan.account.viewerId !== snapshot.account.viewerId
  ) {
    throw new DomainError({
      code: 'AUTH_FAILED',
      message: `Plan account (${plan.account.hostname}/${plan.account.viewerId}) does not match snapshot account (${snapshot.account.hostname}/${snapshot.account.viewerId})`
    });
  }

  // 2. Base snapshot matching
  if (plan.baseSnapshotId !== snapshot.snapshotId) {
    throw new DomainError({
      code: 'PLAN_STALE',
      message: `Plan baseSnapshotId (${plan.baseSnapshotId}) does not match current snapshotId (${snapshot.snapshotId})`
    });
  }

  // 3. Mode restrictions
  const candidateRepoIdSet = new Set(snapshot.candidates.map((c) => c.repoId));
  const snapshotListMap = new Map(snapshot.lists.map((l) => [l.id, l]));

  if (plan.mode === 'incremental') {
    // In incremental mode:
    // a) No updates to existing lists
    if (plan.lists.update.length > 0) {
      throw new DomainError({
        code: 'POLICY_VIOLATION',
        message: 'Incremental mode prohibits updating existing list metadata'
      });
    }

    // b) No deleting existing lists
    if (plan.lists.delete.length > 0) {
      throw new DomainError({
        code: 'POLICY_VIOLATION',
        message: 'Incremental mode prohibits deleting lists'
      });
    }

    // c) For all decisions: cannot remove from existing lists, and must only target candidates
    for (const decision of plan.decisions) {
      if (!candidateRepoIdSet.has(decision.repoId)) {
        throw new DomainError({
          code: 'POLICY_VIOLATION',
          message: `Incremental mode only allows decisions on snapshot candidates; ${decision.repoId} is not a candidate`
        });
      }

      if (decision.outcome === 'assign' && decision.removeFrom.length > 0) {
        throw new DomainError({
          code: 'POLICY_VIOLATION',
          message: `Incremental mode prohibits removing memberships (found removeFrom for repo ${decision.repoId})`
        });
      }
    }
  } else if (plan.mode === 'targeted') {
    // In targeted mode, list updates and deletions must be strictly within scope.listIds
    const scopeListIdSet = new Set(plan.scope.listIds);
    for (const u of plan.lists.update) {
      if (!scopeListIdSet.has(u.listId)) {
        throw new DomainError({
          code: 'POLICY_VIOLATION',
          message: `Targeted mode: List update for ${u.listId} is outside scope.listIds`
        });
      }
    }
    for (const d of plan.lists.delete) {
      if (!scopeListIdSet.has(d.listId)) {
        throw new DomainError({
          code: 'POLICY_VIOLATION',
          message: `Targeted mode: List deletion for ${d.listId} is outside scope.listIds`
        });
      }
    }
  }

  // 4. List deletion safety: cannot delete lists with members unless every member's removal is explicitly planned
  for (const del of plan.lists.delete) {
    const list = snapshotListMap.get(del.listId);
    if (!list) {
      throw new DomainError({
        code: 'PLAN_INVALID',
        message: `List to delete ${del.listId} does not exist in snapshot`
      });
    }

    if ((list.unsupportedItemCount ?? 0) > 0) {
      throw new DomainError({
        code: 'POLICY_VIOLATION',
        message: `List ${del.listId} contains unsupported item types and cannot be deleted safely`
      });
    }

    if (list.repositoryIds.length > 0) {
      // Find all decisions that remove members from this list
      const removedMembers = new Set<string>();
      for (const d of plan.decisions) {
        if (d.outcome === 'assign') {
          for (const rem of d.removeFrom) {
            if (rem.listId === del.listId) {
              removedMembers.add(d.repoId);
            }
          }
        }
      }

      for (const repoId of list.repositoryIds) {
        if (!removedMembers.has(repoId)) {
          throw new DomainError({
            code: 'POLICY_VIOLATION',
            message: `Deleting list ${del.listId} (${list.name}) requires explicitly removing all its members; member ${repoId} is missing an explicit removal decision`
          });
        }
      }
    }
  }
}
