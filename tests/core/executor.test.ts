import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { executeReview } from '../../src/core/executor.js';
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

    async getViewer(): Promise<ViewerInfo> {
      return dummyViewer;
    }
    async readSnapshot(): Promise<RemoteSnapshotData> {
      return {
        account: dummyViewer,
        coverage: { starsComplete: true, listsComplete: true, membershipsComplete: true, error: null },
        repositories: [],
        lists: []
      };
    }
    async readReadme(): Promise<ReadmeDetails> {
      return { content: '', sha: '', truncated: false, byteLength: 0, source: 'none' };
    }
    async createList(input: { name: string; description?: string | null; isPrivate: boolean }): Promise<{ id: string; name: string; isPrivate: boolean }> {
      const id = `L_real_${this.createdLists.length + 1}`;
      const item = { id, name: input.name, isPrivate: input.isPrivate };
      this.createdLists.push(item);
      return item;
    }
    async updateList(): Promise<{ id: string }> {
      return { id: 'L_updated' };
    }
    async deleteList(): Promise<void> {}
    async setMemberships(input: { repositoryId: string; listIds: string[] }): Promise<{ repositoryId: string; listIds: string[] }> {
      if (this.shouldFailOnRepo === input.repositoryId) {
        throw new DomainError({ code: 'NETWORK_ERROR', message: 'Simulated API network error' });
      }
      this.membershipCalls.push(input);
      return input;
    }
    async getList(): Promise<RemoteListInfo | null> {
      return null;
    }
  }

  const sampleReview: Review = {
    schemaVersion: '1.0',
    reviewId: 'rev_test_1',
    createdAt: new Date().toISOString(),
    account: { hostname: 'github.com', viewerId: 'U_exec_test' },
    baseSnapshotId: 'snap_base',
    stateRevision: 0,
    digest: 'digest_123',
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

  it('executes a review successfully and persists result and ledger', async () => {
    const tempDir = path.join(os.tmpdir(), `startidy-exec-${Date.now()}`);
    const store = new FileStoreAdapter({ stateDir: tempDir });
    const github = new MockGitHub();

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
      digest: 'digest_keep',
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
});
