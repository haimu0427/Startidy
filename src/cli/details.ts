import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GitHubPort, StorePort, ReadmeDetails } from '../core/ports.js';
import type { Snapshot } from '../generated/snapshot.js';
import { validateSnapshot } from '../core/validation.js';
import { DomainError } from '../core/errors.js';

export interface RepoDetailItem {
  repoId: string;
  owner: string;
  name: string;
  description: string | null;
  primaryLanguage: string | null;
  readme: {
    content: string;
    sha: string;
    truncated: boolean;
    byteLength: number;
    source: string;
  };
}

export interface DetailsCommandResult {
  totalRequested: number;
  count: number;
  offset: number;
  hasMore: boolean;
  outPath?: string;
  details?: RepoDetailItem[];
}

export async function runDetails(options: {
  github: GitHubPort;
  store: StorePort;
  snapshotPath: string;
  candidates?: boolean;
  repoIds?: string[];
  offset?: number;
  limit?: number;
  refresh?: boolean;
  outPath?: string;
}): Promise<DetailsCommandResult> {
  const {
    github,
    store,
    snapshotPath,
    candidates = false,
    repoIds = [],
    offset = 0,
    limit = 20,
    refresh = false,
    outPath
  } = options;

  let rawContent: string;
  try {
    rawContent = await fsp.readFile(path.resolve(snapshotPath), 'utf8');
  } catch (err) {
    throw new DomainError({
      code: 'PLAN_INVALID',
      message: `Failed to read snapshot file at ${snapshotPath}: ${err instanceof Error ? err.message : String(err)}`
    });
  }

  const snapshot = validateSnapshot(JSON.parse(rawContent));
  const accountKey = store.getAccountKey(snapshot.account);
  const repoMap = new Map(snapshot.repositories.map((r) => [r.id, r]));

  let targetRepoIds: string[] = [];

  if (candidates) {
    targetRepoIds = snapshot.candidates.map((c) => c.repoId);
  } else if (repoIds.length > 0) {
    targetRepoIds = repoIds;
  } else {
    throw new DomainError({
      code: 'PLAN_INVALID',
      message: 'Must specify either --candidates or at least one --repo-id'
    });
  }

  const totalRequested = targetRepoIds.length;
  const slicedIds = targetRepoIds.slice(offset, offset + limit);
  const hasMore = offset + limit < totalRequested;

  const results: RepoDetailItem[] = [];

  for (const id of slicedIds) {
    const repo = repoMap.get(id);
    if (!repo) {
      continue;
    }

    let readme: ReadmeDetails;
    const cachedContent = !refresh ? await store.getCachedReadme(accountKey, repo.id) : null;

    if (cachedContent !== null) {
      readme = {
        content: cachedContent,
        sha: 'cached',
        truncated: false,
        byteLength: Buffer.byteLength(cachedContent, 'utf8'),
        source: 'cache'
      };
    } else {
      readme = await github.readReadme(repo.owner, repo.name, { refresh });
      await store.saveCachedReadme(accountKey, repo.id, readme.sha || 'none', readme.content);
    }

    results.push({
      repoId: repo.id,
      owner: repo.owner,
      name: repo.name,
      description: repo.description ?? null,
      primaryLanguage: repo.primaryLanguage ?? null,
      readme
    });
  }

  let writtenPath: string | undefined;
  if (outPath) {
    writtenPath = path.resolve(outPath);
    await fsp.mkdir(path.dirname(writtenPath), { recursive: true });
    await fsp.writeFile(writtenPath, JSON.stringify(results, null, 2), 'utf8');
  }

  return {
    totalRequested,
    count: results.length,
    offset,
    hasMore,
    outPath: writtenPath,
    details: outPath ? undefined : results
  };
}
