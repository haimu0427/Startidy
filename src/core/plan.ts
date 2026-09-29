import type { Plan } from '../generated/plan.js';
import type { Snapshot } from '../generated/snapshot.js';
import { DomainError } from './errors.js';
import { validatePlan } from './validation.js';

export function normalizeListName(name: string): string {
  return name.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

export function validatePlanSemantics(plan: Plan, snapshot: Snapshot): void {
  // 1. Schema validation
  validatePlan(plan);

  const snapshotRepoMap = new Map(snapshot.repositories.map((r) => [r.id, r]));
  const snapshotListMap = new Map(snapshot.lists.map((l) => [l.id, l]));

  // 2. Created keys uniqueness
  const createdKeys = new Set<string>();
  const existingListNames = new Map(snapshot.lists.map((list) => [normalizeListName(list.name), list]));
  const createdListNames = new Set<string>();
  for (const item of plan.lists.create) {
    if (createdKeys.has(item.key)) {
      throw new DomainError({
        code: 'PLAN_INVALID',
        message: `Duplicate create list key: ${item.key}`
      });
    }
    createdKeys.add(item.key);

    const normalizedName = normalizeListName(item.name);
    if (existingListNames.has(normalizedName)) {
      throw new DomainError({
        code: 'PLAN_INVALID',
        message: `New list name conflicts with an existing snapshot list: ${item.name}`
      });
    }
    if (createdListNames.has(normalizedName)) {
      throw new DomainError({
        code: 'PLAN_INVALID',
        message: `Duplicate new list name: ${item.name}`
      });
    }
    createdListNames.add(normalizedName);
  }

  // 3. Updated lists check
  const updatedListIds = new Set<string>();
  for (const item of plan.lists.update) {
    if (updatedListIds.has(item.listId)) {
      throw new DomainError({
        code: 'PLAN_INVALID',
        message: `Duplicate update for list: ${item.listId}`
      });
    }
    if (!snapshotListMap.has(item.listId)) {
      throw new DomainError({
        code: 'PLAN_INVALID',
        message: `Updated list does not exist in snapshot: ${item.listId}`
      });
    }
    updatedListIds.add(item.listId);
  }

  // 4. Deleted lists check
  const deletedListIds = new Set<string>();
  for (const item of plan.lists.delete) {
    if (deletedListIds.has(item.listId)) {
      throw new DomainError({
        code: 'PLAN_INVALID',
        message: `Duplicate delete for list: ${item.listId}`
      });
    }
    if (!snapshotListMap.has(item.listId)) {
      throw new DomainError({
        code: 'PLAN_INVALID',
        message: `Deleted list does not exist in snapshot: ${item.listId}`
      });
    }
    if (updatedListIds.has(item.listId)) {
      throw new DomainError({
        code: 'PLAN_INVALID',
        message: `List cannot be both updated and deleted: ${item.listId}`
      });
    }
    deletedListIds.add(item.listId);
  }

  // 5. Scope vs Decisions check
  const scopeRepoIdSet = new Set(plan.scope.repoIds);
  const decisionRepoIdSet = new Set<string>();

  for (const decision of plan.decisions) {
    const { repoId } = decision;

    if (!snapshotRepoMap.has(repoId)) {
      throw new DomainError({
        code: 'PLAN_INVALID',
        message: `Decision references repoId ${repoId} which does not exist in snapshot`
      });
    }

    if (!scopeRepoIdSet.has(repoId)) {
      throw new DomainError({
        code: 'SCOPE_MISMATCH',
        message: `Decision for repo ${repoId} is outside plan.scope.repoIds`
      });
    }

    if (decisionRepoIdSet.has(repoId)) {
      throw new DomainError({
        code: 'PLAN_INVALID',
        message: `Duplicate decision for repo ${repoId}`
      });
    }
    decisionRepoIdSet.add(repoId);

    // Outcome specific checks
    if (decision.outcome === 'assign') {
      const addedListIds = new Set<string>();
      const addedKeys = new Set<string>();

      for (const target of decision.addTo) {
        if ('listId' in target) {
          if (!snapshotListMap.has(target.listId)) {
            throw new DomainError({
              code: 'PLAN_INVALID',
              message: `addTo references non-existent list: ${target.listId}`
            });
          }
          if (deletedListIds.has(target.listId)) {
            throw new DomainError({
              code: 'PLAN_INVALID',
              message: `addTo references list marked for deletion: ${target.listId}`
            });
          }
          if (addedListIds.has(target.listId)) {
            throw new DomainError({
              code: 'PLAN_INVALID',
              message: `Duplicate listId in addTo: ${target.listId}`
            });
          }
          addedListIds.add(target.listId);
        } else if ('newListKey' in target) {
          if (!createdKeys.has(target.newListKey)) {
            throw new DomainError({
              code: 'PLAN_INVALID',
              message: `addTo references non-existent newListKey: ${target.newListKey}`
            });
          }
          if (addedKeys.has(target.newListKey)) {
            throw new DomainError({
              code: 'PLAN_INVALID',
              message: `Duplicate newListKey in addTo: ${target.newListKey}`
            });
          }
          addedKeys.add(target.newListKey);
        }
      }

      const removedListIds = new Set<string>();
      for (const target of decision.removeFrom) {
        if (!snapshotListMap.has(target.listId)) {
          throw new DomainError({
            code: 'PLAN_INVALID',
            message: `removeFrom references non-existent list: ${target.listId}`
          });
        }
        if (removedListIds.has(target.listId)) {
          throw new DomainError({
            code: 'PLAN_INVALID',
            message: `Duplicate listId in removeFrom: ${target.listId}`
          });
        }
        if (addedListIds.has(target.listId)) {
          throw new DomainError({
            code: 'PLAN_INVALID',
            message: `Cannot simultaneously add and remove repo ${repoId} from list ${target.listId}`
          });
        }
        removedListIds.add(target.listId);
      }
    }
  }

  // Ensure every repo in scope has a decision
  for (const repoId of plan.scope.repoIds) {
    if (!decisionRepoIdSet.has(repoId)) {
      throw new DomainError({
        code: 'SCOPE_MISMATCH',
        message: `Scope repo ${repoId} has no corresponding decision in plan.decisions`
      });
    }
  }
}
