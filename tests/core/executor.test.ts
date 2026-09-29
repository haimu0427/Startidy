import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { executeReview } from '../../src/core/executor.js';
import { runResolve } from '../../src/cli/resolve.js';
import { FileStoreAdapter } from '../../src/adapters/file-store.js';
import { DomainError } from '../../src/core/errors.js';
import type { GitHubPort, ViewerInfo, RemoteSnapshotData, ReadmeDetails, RemoteListInfo } from '../../src/core/ports.js';
import type { Review } from '../../src/generated/review.js';

describe('Phase 4: Executor & Recovery Verification', () => {
  const dummyViewer: ViewerInfo = {
    hostname: 'github.com',
    viewerId: 'U_exec_test',
    login: 'exectest'
  };

  class MockGitHub implements GitHubPort {
    createdLists: Array<{ id: string; name: string; isPrivate: boolean }> = [];
    membershipCalls: Array<{ repositoryId: string; listIds: string[] }> = [];
    shouldFailOnRepo: string | null = null;
    remoteMemberships: Map<string, string[]> = new Map();
    lists: RemoteListInfo[] = [];

    async getViewer(): Promise<ViewerInfo> {
      return dummyViewer;
    }
    async readSnapshot(): Promise<RemoteSnapshotData> {
      return {
        account: dummyViewer,
        coverage: { starsComplete: true, listsComplete: true, membershipsComplete: true, error: null },
        repositories: [],
        lists: await this.readLists()
      };
    }
    async readReadme(): Promise<ReadmeDetails> {
      return { content: '', sha: '', truncated: false, byteLength: 0, source: 'none' };
    }
    async createList(input: { name: string; description?: string | null; isPrivate: boolean }): Promise<{ id: string; name: string; isPrivate: boolean }> {
      const id = `L_real_${this.createdLists.length + 1}`;
      const item = { id, name: input.name, isPrivate: input.isPrivate };
      this.createdLists.push(item);
      this.lists.push({ id, name: input.name, description: input.description ?? null, isPrivate: input.isPrivate, repositoryIds: [] });
      return item;
    }
    async updateList(input: { listId: string; changes: { name?: string; description?: string | null; isPrivate?: boolean } }): Promise<{ id: string }> {
      const list = this.lists.find((item) => item.id === input.listId);
      if (list) Object.assign(list, input.changes);
      return { id: input.listId };
    }
    async deleteList(input: { listId: string }): Promise<void> {
      this.lists = this.lists.filter((list) => list.id !== input.listId);
    }
    async setMemberships(input: { repositoryId: string; listIds: string[] }): Promise<{ repositoryId: string; listIds: string[] }> {
      if (this.shouldFailOnRepo === input.repositoryId) {
        throw new DomainError({ code: 'NETWORK_ERROR', message: 'Simulated API network error' });
      }
      this.membershipCalls.push(input);
      this.remoteMemberships.set(input.repositoryId, input.listIds);
      for (const listId of input.listIds) {
        if (!this.lists.some((list) => list.id === listId)) {
          this.lists.push({ id: listId, name: listId, description: null, isPrivate: false, repositoryIds: [] });
        }
      }
      return input;
    }
    async getList(listId: string): Promise<RemoteListInfo | null> {
      const list = (await this.readLists()).find((item) => item.id === listId);
      return list ?? null;
    }
    async readLists(): Promise<RemoteListInfo[]> {
      const copies = this.lists.map((list) => ({ ...list, repositoryIds: [...list.repositoryIds] }));
      const byId = new Map(copies.map((list) => [list.id, list]));
      for (const [repoId, listIds] of this.remoteMemberships) {
        for (const listId of listIds) {
          let list = byId.get(listId);
          if (!list) {
            list = { id: listId, name: listId, description: null, isPrivate: false, repositoryIds: [] };
            byId.set(listId, list);
            copies.push(list);
          }
          if (!list.repositoryIds.includes(repoId)) list.repositoryIds.push(repoId);
        }
      }
      return copies;
    }
  }

  const sampleReview: Review = {
    schemaVersion: '1.0',
    reviewId: 'rev_test_1',
    createdAt: new Date().toISOString(),
    account: { hostname: 'github.com', viewerId: 'U_exec_test' },
    baseSnapshotId: 'snap_base',
    stateRevision: 0,
    digest: 'a'.repeat(64),
    plan: {
      schemaVersion: '1.0',
      account: { hostname: 'github.com', viewerId: 'U_exec_test' },
      baseSnapshotId: 'snap_base',
      mode: 'incremental',
      scope: { repoIds: ['R_1', 'R_2'], listIds: [] },
      lists: {
        create: [{ key: 'new-key', name: 'New List', isPrivate: true }],
        update: [],
        delete: []
      },
      decisions: [
        {
          repoId: 'R_1',
          outcome: 'assign',
          addTo: [{ newListKey: 'new-key' }],
          removeFrom: [],
          reason: 'Categorize R_1'
        },
        {
          repoId: 'R_2',
          outcome: 'assign',
          addTo: [{ newListKey: 'new-key' }],
          removeFrom: [],
          reason: 'Categorize R_2'
        }
      ]
    },
    operations: [
      {
        opId: 'op_create_new-key',
        type: 'CreateList',
        params: { key: 'new-key', name: 'New List', isPrivate: true },
        dependencies: []
      },
      {
        opId: 'op_memberships_R_1',
        type: 'SetMemberships',
        params: {
          repositoryId: 'R_1',
          existingListIdsToAdd: [],
          listKeysToAdd: ['new-key'],
          listIdsToRemove: [],
          expectedCurrentListIds: []
        },
        dependencies: ['op_create_new-key'],
        sourceDecisionRepoId: 'R_1'
      },
      {
        opId: 'op_memberships_R_2',
        type: 'SetMemberships',
        params: {
          repositoryId: 'R_2',
          existingListIdsToAdd: [],
          listKeysToAdd: ['new-key'],
          listIdsToRemove: [],
          expectedCurrentListIds: []
        },
        dependencies: ['op_create_new-key'],
        sourceDecisionRepoId: 'R_2'
      }
    ],
    summary: {
      totalCandidates: 2,
      creates: 1,
      updates: 0,
      deletes: 0,
      membershipChanges: 2,
      deferred: 0,
      ignored: 0
    }
  };

  async function saveBaseSnapshot(store: FileStoreAdapter, snapshotId = 'snap_base'): Promise<void> {
    await store.saveSnapshot(sampleReview.account, {
      schemaVersion: '1.0',
      snapshotId,
      capturedAt: new Date().toISOString(),
      account: { ...dummyViewer },
      coverage: { starsComplete: true, listsComplete: true, membershipsComplete: true, error: null },
      repositories: [
        { id: 'R_1', owner: 'owner', name: 'repo-1', description: null, primaryLanguage: null, isStarred: true },
        { id: 'R_2', owner: 'owner', name: 'repo-2', description: null, primaryLanguage: null, isStarred: true }
      ],
      lists: [],
      stateRevision: 0,
      candidates: []
    });
  }

  it('executes a review successfully and persists result and ledger', async () => {
    const tempDir = path.join(os.tmpdir(), `startidy-exec-${Date.now()}`);
    const store = new FileStoreAdapter({ stateDir: tempDir });
    const github = new MockGitHub();
    await saveBaseSnapshot(store);

    const result = await executeReview({
      github,
      store,
      review: sampleReview
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.appliedOperations.length, 3);
    assert.equal(github.createdLists.length, 1);
    assert.equal(github.membershipCalls.length, 2);

    // Verify ledger
    const ledger = await store.loadLedger(sampleReview.account);
    assert.ok(ledger.entries['R_1']);
    assert.equal(ledger.entries['R_1'].lastOutcome, 'assign');
    assert.deepEqual(ledger.entries['R_1'].assignedListIds, ['L_real_1']);

    // Verify profile revision incremented
    const profile = await store.loadProfile(sampleReview.account);
    assert.ok(profile);
    assert.equal(profile.stateRevision, 1);
    assert.equal(profile.initialized, true);
  });

  it('halts on partial failure and resumes without repeating completed operations', async () => {
    const tempDir = path.join(os.tmpdir(), `startidy-exec-resume-${Date.now()}`);
    const store = new FileStoreAdapter({ stateDir: tempDir });
    const github = new MockGitHub();
    await saveBaseSnapshot(store);

    // Cause failure on R_2
    github.shouldFailOnRepo = 'R_2';

    await assert.rejects(
      async () =>
        executeReview({
          github,
          store,
          review: sampleReview,
          runId: 'run_resume_test'
        }),
      (err: unknown) => {
        assert.ok(err instanceof DomainError);
        assert.match(err.message, /Execution halted at operation op_memberships_R_2/);
        return true;
      }
    );

    // Verify state after failure
    const partialResult = await store.loadRunResult(sampleReview.account, 'run_resume_test');
    assert.ok(partialResult);
    assert.equal(partialResult.status, 'partial');
    assert.deepEqual(partialResult.appliedOperations, ['op_create_new-key', 'op_memberships_R_1']);

    // Now fix failure and resume
    github.shouldFailOnRepo = null;

    const resumedResult = await executeReview({
      github,
      store,
      review: sampleReview,
      runId: 'run_resume_test',
      isResume: true
    });

    assert.equal(resumedResult.status, 'completed');
    // op_create_new-key should NOT be called again (still only 1 list created)
    assert.equal(github.createdLists.length, 1);
    // Total membership calls should be 2 (R_1 from first run, R_2 from resumed run)
    assert.equal(github.membershipCalls.length, 2);
    assert.equal(resumedResult.appliedOperations.length, 3);
  });

  it('preserves assignedListIds on keep decisions from base snapshot', async () => {
    const tempDir = path.join(os.tmpdir(), `startidy-exec-keep-${Date.now()}`);
    const store = new FileStoreAdapter({ stateDir: tempDir });
    const github = new MockGitHub();
    await saveBaseSnapshot(store);

    // 1. Save base snapshot with an existing list and repo membership
    await store.saveSnapshot(sampleReview.account, {
      schemaVersion: '1.0',
      snapshotId: 'snap_keep_test',
      capturedAt: new Date().toISOString(),
      account: { hostname: 'github.com', viewerId: 'U_exec_test', login: 'exectest' },
      coverage: { starsComplete: true, listsComplete: true, membershipsComplete: true, error: null },
      repositories: [
        { id: 'R_keep', owner: 'owner', name: 'repo-keep', description: null, primaryLanguage: null, isStarred: true }
      ],
      lists: [
        { id: 'L_keep_1', name: 'PreExisting', isPrivate: false, repositoryIds: ['R_keep'], unsupportedItemCount: 0 }
      ],
      stateRevision: 0,
      candidates: []
    });

    const keepReview: Review = {
      schemaVersion: '1.0',
      reviewId: 'rev_keep_1',
      createdAt: new Date().toISOString(),
      account: { hostname: 'github.com', viewerId: 'U_exec_test' },
      baseSnapshotId: 'snap_keep_test',
      stateRevision: 0,
      digest: 'b'.repeat(64),
      plan: {
        schemaVersion: '1.0',
        account: { hostname: 'github.com', viewerId: 'U_exec_test' },
        baseSnapshotId: 'snap_keep_test',
        mode: 'incremental',
        scope: { repoIds: ['R_keep'], listIds: [] },
        lists: { create: [], update: [], delete: [] },
        decisions: [
          {
            repoId: 'R_keep',
            outcome: 'keep',
            reason: 'Preserve existing categorization'
          }
        ]
      },
      operations: [],
      summary: {
        totalCandidates: 1,
        creates: 0,
        updates: 0,
        deletes: 0,
        membershipChanges: 0,
        deferred: 0,
        ignored: 0
      }
    };

    const result = await executeReview({
      github,
      store,
      review: keepReview
    });

    assert.equal(result.status, 'completed');
    const ledger = await store.loadLedger(sampleReview.account);
    assert.ok(ledger.entries['R_keep']);
    assert.equal(ledger.entries['R_keep'].lastOutcome, 'keep');
    assert.deepEqual(ledger.entries['R_keep'].assignedListIds, ['L_keep_1']);
  });

  it('preserves concurrent remote list memberships during SetMemberships (remote drift)', async () => {
    const tempDir = path.join(os.tmpdir(), `startidy-exec-drift-${Date.now()}`);
    const store = new FileStoreAdapter({ stateDir: tempDir });
    const github = new MockGitHub();
    await saveBaseSnapshot(store);

    // Repo R_drift was in list L_orig at snapshot time, but user manually added L_remote_C
    github.remoteMemberships.set('R_drift', ['L_orig', 'L_remote_C']);
    github.lists.push({ id: 'L_plan_B', name: 'Planned B', description: null, isPrivate: false, repositoryIds: [] });

    const driftReview: Review = {
      ...sampleReview,
      reviewId: 'rev_drift_test',
      digest: 'c'.repeat(64),
      operations: [
        {
          opId: 'op_memberships_drift',
          type: 'SetMemberships',
          params: {
            repositoryId: 'R_drift',
            existingListIdsToAdd: ['L_plan_B'],
            listKeysToAdd: [],
            listIdsToRemove: [],
            expectedCurrentListIds: ['L_orig']
          },
          dependencies: []
        }
      ]
    };

    const result = await executeReview({
      github,
      store,
      review: driftReview
    });

    assert.equal(result.status, 'completed');
    assert.equal(github.membershipCalls.length, 1);
    const updatedIds = github.membershipCalls[0].listIds;
    // Must contain both L_remote_C and L_plan_B and L_orig
    assert.ok(updatedIds.includes('L_remote_C'), 'Remote manual addition L_remote_C must be preserved');
    assert.ok(updatedIds.includes('L_plan_B'), 'Planned addition L_plan_B must be added');
    assert.ok(updatedIds.includes('L_orig'), 'Original list L_orig must be retained');
  });

  it('repeated apply with same review is idempotent and avoids redundant operations', async () => {
    const tempDir = path.join(os.tmpdir(), `startidy-exec-idempotent-${Date.now()}`);
    const store = new FileStoreAdapter({ stateDir: tempDir });
    const github = new MockGitHub();
    await saveBaseSnapshot(store);

    const reviewToRepeat: Review = {
      ...sampleReview,
      reviewId: 'rev_repeat_test',
      digest: 'd'.repeat(64),
      operations: [
        {
          opId: 'op_create_rep',
          type: 'CreateList',
          params: { key: 'k_rep', name: 'Repeat List', isPrivate: false },
          dependencies: []
        }
      ]
    };

    // First execution
    const res1 = await executeReview({ github, store, review: reviewToRepeat });
    assert.equal(res1.status, 'completed');
    assert.equal(github.createdLists.length, 1);

    // Second execution with identical review
    const res2 = await executeReview({ github, store, review: reviewToRepeat });
    assert.equal(res2.status, 'completed');
    assert.equal(res2.runId, res1.runId);
    // No second list created!
    assert.equal(github.createdLists.length, 1);

    const resumed = await executeReview({ github, store, review: reviewToRepeat, runId: res1.runId, isResume: true });
    assert.equal(resumed.runId, res1.runId);
    const profile = await store.loadProfile(sampleReview.account);
    assert.equal(profile?.stateRevision, 1);
  });

  it('blocks a same-name List that appears after preview without creating a duplicate', async () => {
    const tempDir = path.join(os.tmpdir(), `startidy-exec-same-name-${Date.now()}`);
    const store = new FileStoreAdapter({ stateDir: tempDir });
    const github = new MockGitHub();
    await saveBaseSnapshot(store);
    github.lists.push({ id: 'L_existing', name: 'Same Name', description: null, isPrivate: false, repositoryIds: [] });
    const review: Review = {
      ...sampleReview,
      reviewId: 'rev_same_name',
      digest: 'f'.repeat(64),
      operations: [{ opId: 'op_create_same', type: 'CreateList', params: { key: 'same', name: 'Same Name', isPrivate: false }, dependencies: [] }]
    };

    await assert.rejects(
      () => executeReview({ github, store, review }),
      (error: unknown) => error instanceof DomainError && error.code === 'OPERATION_UNCERTAIN'
    );
    assert.equal(github.createdLists.length, 0);
    assert.equal((await store.listPendingRuns(dummyViewer))[0]?.result?.status, 'needs_review');
  });

  it('adopts an explicitly selected same-name List and resumes the run', async () => {
    const tempDir = path.join(os.tmpdir(), `startidy-exec-adopt-${Date.now()}`);
    const store = new FileStoreAdapter({ stateDir: tempDir });
    const github = new MockGitHub();
    await saveBaseSnapshot(store);
    github.lists.push({ id: 'L_existing', name: 'Same Name', description: null, isPrivate: false, repositoryIds: [] });
    const review: Review = {
      ...sampleReview,
      reviewId: 'rev_adopt',
      digest: '7'.repeat(64),
      operations: [{ opId: 'op_create_adopt', type: 'CreateList', params: { key: 'same', name: 'Same Name', isPrivate: false }, dependencies: [] }]
    };

    await assert.rejects(() => executeReview({ github, store, review }), DomainError);
    const runId = (await store.listPendingRuns(dummyViewer))[0]!.runId;
    const resolution = await runResolve({ github, store, runId, action: 'adopt', listId: 'L_existing' });
    assert.equal(resolution.resumeRequired, true);

    const completed = await executeReview({ github, store, review, runId, isResume: true });
    assert.equal(completed.createdListKeyMap.same, 'L_existing');
    assert.equal(github.createdLists.length, 0);
  });

  it('cancels a needs_review run without leaving it pending', async () => {
    const tempDir = path.join(os.tmpdir(), `startidy-exec-abort-${Date.now()}`);
    const store = new FileStoreAdapter({ stateDir: tempDir });
    const github = new MockGitHub();
    await saveBaseSnapshot(store);
    github.lists.push({ id: 'L_existing', name: 'Same Name', description: null, isPrivate: false, repositoryIds: [] });
    const review: Review = {
      ...sampleReview,
      reviewId: 'rev_abort',
      digest: '6'.repeat(64),
      operations: [{ opId: 'op_create_abort', type: 'CreateList', params: { key: 'same', name: 'Same Name', isPrivate: false }, dependencies: [] }]
    };

    await assert.rejects(() => executeReview({ github, store, review }), DomainError);
    const runId = (await store.listPendingRuns(dummyViewer))[0]!.runId;
    const resolution = await runResolve({ github, store, runId, action: 'abort' });
    assert.equal(resolution.status, 'cancelled');
    assert.equal((await store.listPendingRuns(dummyViewer)).length, 0);
    await assert.rejects(
      () => executeReview({ github, store, review, runId, isResume: true }),
      (error: unknown) => error instanceof DomainError && error.code === 'STATE_CONFLICT'
    );
  });

  it('accepts current memberships through resolution and records the remote ledger state', async () => {
    const tempDir = path.join(os.tmpdir(), `startidy-exec-accept-current-${Date.now()}`);
    const store = new FileStoreAdapter({ stateDir: tempDir });
    const github = new MockGitHub();
    await saveBaseSnapshot(store);
    github.lists.push({ id: 'L_current', name: 'Current', description: null, isPrivate: false, repositoryIds: ['R_1'] });
    const review: Review = {
      ...sampleReview,
      reviewId: 'rev_accept_current',
      digest: '5'.repeat(64),
      operations: [{
        opId: 'op_membership_accept',
        type: 'SetMemberships',
        params: { repositoryId: 'R_1', existingListIdsToAdd: [], listKeysToAdd: [], listIdsToRemove: [], expectedCurrentListIds: [] },
        dependencies: []
      }]
    };
    const runId = 'run_accept_current';
    await store.createRun(dummyViewer, runId, review);
    await store.appendRunEvent(dummyViewer, runId, { eventId: 'start', timestamp: new Date().toISOString(), runId, phase: 'run_start' });
    await store.appendRunEvent(dummyViewer, runId, {
      eventId: 'conflict', timestamp: new Date().toISOString(), runId, opId: 'op_membership_accept', phase: 'op_conflict',
      details: { error: 'remote changed' }
    });
    await store.saveRunResult(dummyViewer, runId, {
      runId, status: 'needs_review', startedAt: new Date().toISOString(), appliedOperations: [],
      failedOperation: { opId: 'op_membership_accept', error: 'remote changed', code: 'OPERATION_UNCERTAIN' },
      createdListKeyMap: {}
    });

    await runResolve({ github, store, runId, action: 'accept-current' });
    await executeReview({ github, store, review, runId, isResume: true });
    const ledger = await store.loadLedger(dummyViewer);
    assert.deepEqual(ledger.entries.R_1?.assignedListIds, ['L_current']);
  });

  it('marks an unprovable interrupted CreateList as needs_review without retrying it', async () => {
    const tempDir = path.join(os.tmpdir(), `startidy-exec-uncertain-create-${Date.now()}`);
    const store = new FileStoreAdapter({ stateDir: tempDir });
    const github = new MockGitHub();
    await saveBaseSnapshot(store);
    const runId = 'run_uncertain_create';
    const review: Review = {
      ...sampleReview,
      reviewId: 'rev_uncertain_create',
      digest: '9'.repeat(64),
      operations: [{ opId: 'op_create_uncertain', type: 'CreateList', params: { key: 'uncertain', name: 'Uncertain', isPrivate: false }, dependencies: [] }]
    };
    await store.createRun(dummyViewer, runId, review);
    await store.appendRunEvent(dummyViewer, runId, { eventId: 'start', timestamp: new Date().toISOString(), runId, phase: 'run_start' });
    await store.appendRunEvent(dummyViewer, runId, {
      eventId: 'in_flight', timestamp: new Date().toISOString(), runId, opId: 'op_create_uncertain', phase: 'op_in_flight',
      details: { beforeListIds: [] }
    });

    await assert.rejects(
      () => executeReview({ github, store, review, runId, isResume: true }),
      (error: unknown) => error instanceof DomainError && error.code === 'OPERATION_UNCERTAIN'
    );
    assert.equal(github.createdLists.length, 0);
    assert.equal((await store.loadRunResult(dummyViewer, runId))?.status, 'needs_review');
  });

  it('crash recovery reconciles created list without creating duplicates', async () => {
    const tempDir = path.join(os.tmpdir(), `startidy-exec-recon-${Date.now()}`);
    const store = new FileStoreAdapter({ stateDir: tempDir });
    const github = new MockGitHub();

    await saveBaseSnapshot(store);

    const reconReview: Review = {
      ...sampleReview,
      reviewId: 'rev_recon_test',
      digest: 'e'.repeat(64),
      operations: [
        {
          opId: 'op_create_recon',
          type: 'CreateList',
          params: { key: 'k_recon', name: 'Reconciled List', isPrivate: false },
          dependencies: []
        }
      ]
    };

    const runId = 'run_recon_test';
    await store.createRun(dummyViewer, runId, reconReview);
    await store.appendRunEvent(dummyViewer, runId, {
      eventId: 'evt_recon_start',
      timestamp: new Date().toISOString(),
      runId,
      phase: 'run_start'
    });
    await store.appendRunEvent(dummyViewer, runId, {
      eventId: 'evt_recon_in_flight',
      timestamp: new Date().toISOString(),
      runId,
      opId: 'op_create_recon',
      phase: 'op_in_flight',
      details: { beforeListIds: [], expected: { key: 'k_recon', name: 'Reconciled List', description: null, isPrivate: false } }
    });
    await github.createList({ name: 'Reconciled List', isPrivate: false });

    const result = await executeReview({
      github,
      store,
      review: reconReview,
      runId,
      isResume: true
    });

    assert.equal(result.status, 'completed');
    // Still exactly 1 list, not 2!
    assert.equal(github.createdLists.length, 1);
    assert.equal(result.createdListKeyMap['k_recon'], 'L_real_1');
  });

  it('recovers when CreateList succeeds but persisting op_verified fails', async () => {
    class FailOnceVerifiedStore extends FileStoreAdapter {
      failVerifiedWrite = true;

      override async appendRunEvent(
        account: { hostname: string; viewerId: string },
        runId: string,
        event: import('../../src/core/ports.js').RunEvent
      ): Promise<void> {
        if (this.failVerifiedWrite && event.phase === 'op_verified') {
          this.failVerifiedWrite = false;
          throw new Error('simulated journal crash');
        }
        await super.appendRunEvent(account, runId, event);
      }
    }

    const tempDir = path.join(os.tmpdir(), `startidy-exec-journal-crash-${Date.now()}`);
    const store = new FailOnceVerifiedStore({ stateDir: tempDir });
    const github = new MockGitHub();
    await saveBaseSnapshot(store);
    const review: Review = {
      ...sampleReview,
      reviewId: 'rev_journal_crash',
      digest: '8'.repeat(64),
      operations: [{ opId: 'op_create_journal', type: 'CreateList', params: { key: 'journal', name: 'Journal List', isPrivate: true }, dependencies: [] }]
    };
    const runId = 'run_journal_crash';

    await assert.rejects(() => executeReview({ github, store, review, runId }), /simulated journal crash/);
    assert.equal(github.createdLists.length, 1);

    const recovered = await executeReview({ github, store, review, runId, isResume: true });
    assert.equal(recovered.createdListKeyMap.journal, 'L_real_1');
    assert.equal(github.createdLists.length, 1);
  });
});
