import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GitHubPort, StorePort } from '../core/ports.js';
import type { Snapshot } from '../generated/snapshot.js';
import { buildSnapshot, assertSnapshotComplete } from '../core/snapshot.js';
import { DomainError } from '../core/errors.js';

export interface SnapshotCommandResult {
  snapshotId: string;
  capturedAt: string;
  account: {
    hostname: string;
    viewerId: string;
    login: string;
  };
  totalStars: number;
  totalLists: number;
  candidatesCount: number;
  outPath?: string;
  snapshot?: Snapshot;
}

export async function runSnapshot(options: {
  github: GitHubPort;
  store: StorePort;
  outPath?: string;
}): Promise<SnapshotCommandResult> {
  const { github, store, outPath } = options;

  const remote = await github.readSnapshot();
  const profile = await store.loadProfile(remote.account);
  const ledger = await store.loadLedger(remote.account);

  const pendingRuns = await store.listPendingRuns(remote.account);
  let pendingRunId: string | undefined;
  let pendingRunRepoIds: Set<string> | undefined;

  if (pendingRuns.length > 1) {
    throw new DomainError({
      code: 'RESTORE_REQUIRED',
      message: 'Multiple unfinished runs require resolution before a new snapshot can be planned',
      details: { runIds: pendingRuns.map((run) => run.runId) }
    });
  }

  const pendingRun = pendingRuns[0];
  if (pendingRun) {
    pendingRunId = pendingRun.runId;
    pendingRunRepoIds = new Set<string>(pendingRun.review.plan.scope.repoIds);
    for (const d of pendingRun.review.plan.decisions) {
      pendingRunRepoIds.add(d.repoId);
    }
  }

  const snapshot = buildSnapshot({
    remote,
    profile,
    ledger,
    pendingRunId,
    pendingRunRepoIds
  });

  assertSnapshotComplete(snapshot);

  await store.saveSnapshot(snapshot.account, snapshot);

  let writtenPath: string | undefined;
  if (outPath) {
    writtenPath = path.resolve(outPath);
    await fsp.mkdir(path.dirname(writtenPath), { recursive: true });
    await fsp.writeFile(writtenPath, JSON.stringify(snapshot, null, 2), 'utf8');
  }

  return {
    snapshotId: snapshot.snapshotId,
    capturedAt: snapshot.capturedAt,
    account: snapshot.account,
    totalStars: snapshot.repositories.filter((r) => r.isStarred).length,
    totalLists: snapshot.lists.length,
    candidatesCount: snapshot.candidates.length,
    outPath: writtenPath,
    snapshot: outPath ? undefined : snapshot
  };
}
