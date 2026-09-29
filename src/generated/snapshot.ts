/* eslint-disable */
/**
 * This file was automatically generated from JSON Schema.
 * DO NOT MODIFY IT BY HAND. Instead, modify the source schema and re-run typegen.
 */

/**
 * Normalized observation snapshot of a user's GitHub Stars and Lists state.
 */
export interface Snapshot {
  schemaVersion: "1.0";
  snapshotId: string;
  capturedAt: string;
  account: {
    hostname: string;
    viewerId: string;
    login: string;
  };
  coverage: {
    starsComplete: boolean;
    listsComplete: boolean;
    membershipsComplete: boolean;
    error?: string | null;
  };
  repositories: {
    id: string;
    owner: string;
    name: string;
    description?: string | null;
    primaryLanguage?: string | null;
    isStarred: boolean;
  }[];
  lists: {
    id: string;
    name: string;
    description?: string | null;
    isPrivate: boolean;
    repositoryIds: string[];
    unsupportedItemCount?: number;
  }[];
  stateRevision: number;
  preferences?: {
    namingLanguage?: string;
    allowMultiCategory?: boolean;
    defaultListPrivacy?: "public" | "private";
    [k: string]: unknown;
  };
  ledgerSummary?: {
    totalTracked?: number;
    lastRunId?: string | null;
  };
  candidates: {
    repoId: string;
    reason: string;
    suggestedAction: "assign" | "keep" | "defer" | "ignore";
  }[];
  pendingRunId?: string | null;
}
