/* eslint-disable */
/**
 * This file was automatically generated from JSON Schema.
 * DO NOT MODIFY IT BY HAND. Instead, modify the source schema and re-run typegen.
 */

/**
 * Portable preview and execution contract binding plan, baseline, operations, and digest.
 */
export interface Review {
  schemaVersion: "1.0";
  reviewId: string;
  createdAt: string;
  account: {
    hostname: string;
    viewerId: string;
  };
  baseSnapshotId: string;
  stateRevision: number;
  plan: Plan;
  digest: string;
  operations: {
    opId: string;
    type: "CreateList" | "UpdateList" | "SetMemberships" | "DeleteList";
    params: {
      [k: string]: unknown;
    };
    dependencies: string[];
    sourceDecisionRepoId?: string | null;
  }[];
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
/**
 * Explicit user and agent classification and change plan.
 */
export interface Plan {
  schemaVersion: "1.0";
  account: {
    hostname: string;
    viewerId: string;
  };
  baseSnapshotId: string;
  mode: "bootstrap" | "incremental" | "targeted" | "full";
  scope: {
    repoIds: string[];
    listIds: string[];
  };
  lists: {
    create: {
      key: string;
      name: string;
      description?: string | null;
      isPrivate: boolean;
    }[];
    update: {
      listId: string;
      changes: {
        name?: string;
        description?: string | null;
        isPrivate?: boolean;
      };
      reason: string;
    }[];
    delete: {
      listId: string;
      reason: string;
    }[];
  };
  decisions: (AssignDecision | KeepDecision | DeferDecision | IgnoreDecision)[];
  preferencesUpdate?: {
    [k: string]: unknown;
  };
  metadata?: {
    [k: string]: unknown;
  };
}
export interface AssignDecision {
  repoId: string;
  outcome: "assign";
  addTo: (
    | {
        listId: string;
      }
    | {
        newListKey: string;
      }
  )[];
  removeFrom: {
    listId: string;
  }[];
  reason: string;
}
export interface KeepDecision {
  repoId: string;
  outcome: "keep";
  reason?: string;
}
export interface DeferDecision {
  repoId: string;
  outcome: "defer";
  reason: string;
}
export interface IgnoreDecision {
  repoId: string;
  outcome: "ignore";
  reason: string;
}
