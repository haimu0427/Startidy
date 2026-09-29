import type { Snapshot } from '../generated/snapshot.js';
import type { Review } from '../generated/review.js';

export interface ViewerInfo {
  hostname: string;
  viewerId: string;
  login: string;
}

export interface ReadmeDetails {
  content: string;
  sha: string;
  truncated: boolean;
  byteLength: number;
  source: string;
}

export interface RemoteListInfo {
  id: string;
  name: string;
  description?: string | null;
  isPrivate: boolean;
  repositoryIds: string[];
  unsupportedItemCount?: number;
}

export interface RemoteRepoInfo {
  id: string;
  owner: string;
  name: string;
  description?: string | null;
  primaryLanguage?: string | null;
  isStarred: boolean;
}

export interface RemoteSnapshotData {
  account: ViewerInfo;
  coverage: {
    starsComplete: boolean;
    listsComplete: boolean;
    membershipsComplete: boolean;
    error?: string | null;
  };
  repositories: RemoteRepoInfo[];
  lists: RemoteListInfo[];
}

export interface GitHubPort {
  getViewer(): Promise<ViewerInfo>;
  readSnapshot(): Promise<RemoteSnapshotData>;
  readReadme(owner: string, repo: string, options?: { refresh?: boolean }): Promise<ReadmeDetails>;
  createList(input: { name: string; description?: string | null; isPrivate: boolean }): Promise<{ id: string; name: string; isPrivate: boolean }>;
  updateList(input: { listId: string; changes: { name?: string; description?: string | null; isPrivate?: boolean } }): Promise<{ id: string }>;
  deleteList(input: { listId: string }): Promise<void>;
  setMemberships(input: { repositoryId: string; listIds: string[] }): Promise<{ repositoryId: string; listIds: string[] }>;
  getList(listId: string): Promise<RemoteListInfo | null>;
}

export interface LockHandle {
  runId: string;
  release(): Promise<void>;
}

export interface AccountProfile {
  schemaVersion: string;
  account: {
    hostname: string;
    viewerId: string;
    login: string;
  };
  stateRevision: number;
  initialized: boolean;
  preferences: {
    namingLanguage?: string;
    allowMultiCategory?: boolean;
    defaultListPrivacy?: 'public' | 'private';
    [key: string]: unknown;
  };
  ignoredRepoIds: string[];
}

export interface LedgerEntry {
  repoId: string;
  lastOutcome: 'assign' | 'keep' | 'defer' | 'ignore';
  lastRunId: string;
  lastVerifiedAt: string;
  assignedListIds: string[];
  reason?: string;
}

export interface AccountLedger {
  schemaVersion: string;
  account: {
    hostname: string;
    viewerId: string;
  };
  entries: Record<string, LedgerEntry>;
}

export type RunStatus = 'pending' | 'applying' | 'completed' | 'partial' | 'needs_review' | 'failed';

export interface RunEvent {
  eventId: string;
  timestamp: string;
  runId: string;
  opId?: string;
  phase: 'run_start' | 'op_pre_flight' | 'op_in_flight' | 'op_verified' | 'op_failed' | 'op_uncertain' | 'run_finish';
  details?: Record<string, unknown>;
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  appliedOperations: string[];
  failedOperation?: {
    opId: string;
    error: string;
    code: string;
  };
  createdListKeyMap: Record<string, string>;
}

export interface StorePort {
  getAccountKey(account: { hostname: string; viewerId: string }): string;
  acquireLock(account: { hostname: string; viewerId: string }, runId: string): Promise<LockHandle>;
  loadProfile(account: { hostname: string; viewerId: string }): Promise<AccountProfile | null>;
  saveProfile(account: { hostname: string; viewerId: string }, profile: AccountProfile): Promise<void>;
  loadLedger(account: { hostname: string; viewerId: string }): Promise<AccountLedger>;
  saveLedger(account: { hostname: string; viewerId: string }, ledger: AccountLedger): Promise<void>;
  saveSnapshot(account: { hostname: string; viewerId: string }, snapshot: Snapshot): Promise<string>;
  loadSnapshot(account: { hostname: string; viewerId: string }, snapshotId: string): Promise<Snapshot | null>;
  createRun(account: { hostname: string; viewerId: string }, runId: string, review: Review): Promise<void>;
  appendRunEvent(account: { hostname: string; viewerId: string }, runId: string, event: RunEvent): Promise<void>;
  getRunEvents(account: { hostname: string; viewerId: string }, runId: string): Promise<RunEvent[]>;
  saveRunResult(account: { hostname: string; viewerId: string }, runId: string, result: RunResult): Promise<void>;
  loadRunResult(account: { hostname: string; viewerId: string }, runId: string): Promise<RunResult | null>;
  loadReview(account: { hostname: string; viewerId: string }, runId: string): Promise<Review | null>;
  getCachedReadme(accountKey: string, repoId: string, sha?: string): Promise<string | null>;
  saveCachedReadme(accountKey: string, repoId: string, sha: string, content: string): Promise<void>;
}
