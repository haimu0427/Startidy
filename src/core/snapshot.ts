import crypto from 'node:crypto';
import type { Snapshot } from '../generated/snapshot.js';
import type { RemoteSnapshotData, AccountProfile, AccountLedger } from './ports.js';
import { DomainError } from './errors.js';
import { determineCandidates } from './candidates.js';
import { validateSnapshot } from './validation.js';

export function assertSnapshotComplete(snapshot: Snapshot): void {
  const { coverage } = snapshot;
  if (!coverage.starsComplete || !coverage.listsComplete || !coverage.membershipsComplete || coverage.error) {
    throw new DomainError({
      code: 'STATE_CONFLICT',
      message: `Snapshot is incomplete or corrupted: starsComplete=${coverage.starsComplete}, listsComplete=${coverage.listsComplete}, membershipsComplete=${coverage.membershipsComplete}, error=${coverage.error ?? 'none'}`,
      details: { coverage }
    });
  }
}

export function buildSnapshot(options: {
  remote: RemoteSnapshotData;
  profile?: AccountProfile | null;
  ledger?: AccountLedger | null;
  pendingRunId?: string | null;
  pendingRunRepoIds?: Set<string>;
  now?: Date;
}): Snapshot {
  const { remote, profile, ledger, pendingRunId, pendingRunRepoIds, now = new Date() } = options;

  const snapshotId = `snap_${now.getTime()}_${crypto.randomBytes(4).toString('hex')}`;

  // Deterministically sort repos by id
  const sortedRepos = [...remote.repositories].sort((a, b) => a.id.localeCompare(b.id));

  // Deterministically sort lists and their repositoryIds
  const sortedLists = [...remote.lists]
    .map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description ?? null,
      isPrivate: l.isPrivate,
      repositoryIds: [...l.repositoryIds].sort(),
      unsupportedItemCount: l.unsupportedItemCount ?? 0
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const candidates = determineCandidates({
    repositories: sortedRepos,
    lists: sortedLists,
    profile,
    ledger,
    pendingRunRepoIds
  });

  const stateRevision = profile?.stateRevision ?? 0;

  const rawSnapshot: Snapshot = {
    schemaVersion: '1.0',
    snapshotId,
    capturedAt: now.toISOString(),
    account: {
      hostname: remote.account.hostname,
      viewerId: remote.account.viewerId,
      login: remote.account.login
    },
    coverage: {
      starsComplete: remote.coverage.starsComplete,
      listsComplete: remote.coverage.listsComplete,
      membershipsComplete: remote.coverage.membershipsComplete,
      error: remote.coverage.error ?? null
    },
    repositories: sortedRepos.map((r) => ({
      id: r.id,
      owner: r.owner,
      name: r.name,
      description: r.description ?? null,
      primaryLanguage: r.primaryLanguage ?? null,
      isStarred: r.isStarred
    })),
    lists: sortedLists,
    stateRevision,
    preferences: profile?.preferences,
    ledgerSummary: ledger
      ? {
          totalTracked: Object.keys(ledger.entries).length,
          lastRunId: pendingRunId ?? null
        }
      : undefined,
    candidates,
    pendingRunId: pendingRunId ?? null
  };

  return validateSnapshot(rawSnapshot);
}
