import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GitHubPort, StorePort } from '../core/ports.js';
import type { Snapshot } from '../generated/snapshot.js';
import { buildSnapshot, assertSnapshotComplete } from '../core/snapshot.js';

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

  const snapshot = buildSnapshot({
    remote,
    profile,
    ledger
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
