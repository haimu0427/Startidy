import type { RemoteRepoInfo, RemoteListInfo, AccountProfile, AccountLedger } from './ports.js';

export interface Candidate {
  repoId: string;
  reason: string;
  suggestedAction: 'assign' | 'keep' | 'defer' | 'ignore';
}

export function determineCandidates(options: {
  repositories: RemoteRepoInfo[];
  lists: RemoteListInfo[];
  profile?: AccountProfile | null;
  ledger?: AccountLedger | null;
  pendingRunRepoIds?: Set<string>;
}): Candidate[] {
  const { repositories, lists, profile, ledger, pendingRunRepoIds } = options;

  // Build a map of repoId -> listIds where this repo currently belongs
  const repoMemberships = new Map<string, string[]>();
  for (const list of lists) {
    for (const repoId of list.repositoryIds) {
      const existing = repoMemberships.get(repoId) ?? [];
      existing.push(list.id);
      repoMemberships.set(repoId, existing);
    }
  }

  const ignoredSet = new Set<string>(profile?.ignoredRepoIds ?? []);
  const candidates: Candidate[] = [];

  for (const repo of repositories) {
    // Only starred repositories are considered for new candidate actions
    if (!repo.isStarred) {
      continue;
    }

    // Explicitly ignored repos are excluded
    if (ignoredSet.has(repo.id)) {
      continue;
    }

    // Repos currently involved in an unresolved run cannot be treated as ordinary candidates
    if (pendingRunRepoIds && pendingRunRepoIds.has(repo.id)) {
      continue;
    }

    const currentListIds = (repoMemberships.get(repo.id) ?? []).slice().sort();
    const ledgerEntry = ledger?.entries[repo.id];

    if (!ledgerEntry) {
      // Unrecorded repository
      if (currentListIds.length > 0) {
        // Already in lists: recommend keep
        const listNames = currentListIds
          .map((id) => lists.find((l) => l.id === id)?.name ?? id)
          .join(', ');
        candidates.push({
          repoId: repo.id,
          suggestedAction: 'keep',
          reason: `已存在于 Lists 中 (${listNames})，保留现有分类`
        });
      } else {
        // Completely unclassified star
        candidates.push({
          repoId: repo.id,
          suggestedAction: 'assign',
          reason: '未分类的 Star 项目'
        });
      }
      continue;
    }

    // Has ledger entry
    if (ledgerEntry.lastOutcome === 'ignore') {
      continue;
    }

    if (ledgerEntry.lastOutcome === 'defer') {
      candidates.push({
        repoId: repo.id,
        suggestedAction: 'assign',
        reason: `上次推迟处理: ${ledgerEntry.reason || '待定'}`
      });
      continue;
    }

    if (ledgerEntry.lastOutcome === 'keep') {
      // Already decided to keep
      continue;
    }

    if (ledgerEntry.lastOutcome === 'assign') {
      const recordedListIds = (ledgerEntry.assignedListIds ?? []).slice().sort();
      const isIdentical =
        currentListIds.length === recordedListIds.length &&
        currentListIds.every((id, idx) => id === recordedListIds[idx]);

      if (isIdentical) {
        // Already processed and remote has not changed
        continue;
      }

      // Remote lists were manually modified or emptied by user outside Startidy.
      // Section 8.2: 尊重当前结果，标记外部变更，不自动补回。
      continue;
    }
  }

  // Sort candidates deterministically by repoId
  candidates.sort((a, b) => a.repoId.localeCompare(b.repoId));

  return candidates;
}
