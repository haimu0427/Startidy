import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runDoctor } from '../../src/cli/doctor.js';
import { runSnapshot } from '../../src/cli/snapshot.js';
import { runDetails } from '../../src/cli/details.js';
import { runPreview } from '../../src/cli/preview.js';
import { runApply } from '../../src/cli/apply.js';
import { runStatus } from '../../src/cli/status.js';
import { FileStoreAdapter } from '../../src/adapters/file-store.js';
import type { GitHubPort, ViewerInfo, RemoteSnapshotData, ReadmeDetails, RemoteListInfo } from '../../src/core/ports.js';
import type { Plan } from '../../src/generated/plan.js';
import { DomainError } from '../../src/core/errors.js';

describe('Phase 3 & CLI Workflow Integration', () => {
  const dummyViewer: ViewerInfo = {
    hostname: 'github.com',
    viewerId: 'U_cli_test',
    login: 'clitest'
  };

  class MockGitHub implements GitHubPort {
    lists: RemoteListInfo[] = [];

    async getViewer(): Promise<ViewerInfo> {
      return dummyViewer;
    }
    async readSnapshot(): Promise<RemoteSnapshotData> {
      return {
        account: dummyViewer,
        coverage: { starsComplete: true, listsComplete: true, membershipsComplete: true, error: null },
        repositories: [
          { id: 'R_10', owner: 'cli', name: 'repo-10', description: 'desc 10', primaryLanguage: 'JS', isStarred: true }
        ],
        lists: this.lists
      };
    }
    async readReadme(): Promise<ReadmeDetails> {
      return { content: '# Readme', sha: 'sha10', truncated: false, byteLength: 8, source: 'README.md' };
    }
    async createList(input: { name: string; description?: string | null; isPrivate: boolean }): Promise<{ id: string; name: string; isPrivate: boolean }> {
      const id = `L_mock_${this.lists.length + 1}`;
      const item = { id, name: input.name, description: input.description ?? null, isPrivate: input.isPrivate, repositoryIds: [] };
      this.lists.push(item);
      return { id, name: input.name, isPrivate: input.isPrivate };
    }
    async updateList(input: { listId: string; changes: { name?: string; description?: string | null; isPrivate?: boolean } }): Promise<{ id: string }> {
      return { id: input.listId };
    }
    async deleteList(input: { listId: string }): Promise<void> {
      this.lists = this.lists.filter((l) => l.id !== input.listId);
    }
    async setMemberships(input: { repositoryId: string; listIds: string[] }): Promise<{ repositoryId: string; listIds: string[] }> {
      for (const list of this.lists) {
        list.repositoryIds = list.repositoryIds.filter((id) => id !== input.repositoryId);
        if (input.listIds.includes(list.id)) {
          list.repositoryIds.push(input.repositoryId);
        }
      }
      return input;
    }
    async getList(listId: string): Promise<RemoteListInfo | null> {
      return this.lists.find((l) => l.id === listId) ?? null;
    }
    async readLists(): Promise<RemoteListInfo[]> {
      return this.lists.map((list) => ({ ...list, repositoryIds: [...list.repositoryIds] }));
    }
  }

  it('runs complete lifecycle: doctor -> snapshot -> preview -> apply -> status', async () => {
    const tempDir = path.join(os.tmpdir(), `startidy-cli-test-${Date.now()}`);
    await fsp.mkdir(tempDir, { recursive: true });

    const github = new MockGitHub();
    const store = new FileStoreAdapter({ stateDir: tempDir });

    // 1. Doctor
    const docResult = await runDoctor(github);
    assert.equal(docResult.checksPassed, true);
    assert.equal(docResult.viewer?.login, 'clitest');

    // 2. Snapshot
    const snapPath = path.join(tempDir, 'snapshot.json');
    const snapResult = await runSnapshot({ github, store, outPath: snapPath });
    assert.equal(snapResult.totalStars, 1);
    assert.equal(snapResult.candidatesCount, 1);
    assert.ok(snapResult.outPath);

    // 3. Preview with valid plan
    const plan: Plan = {
      schemaVersion: '1.0',
      account: { hostname: 'github.com', viewerId: 'U_cli_test' },
      baseSnapshotId: snapResult.snapshotId,
      mode: 'incremental',
      scope: { repoIds: ['R_10'], listIds: [] },
      lists: {
        create: [{ key: 'frontend', name: 'Frontend', isPrivate: true }],
        update: [],
        delete: []
      },
      decisions: [
        {
          repoId: 'R_10',
          outcome: 'assign',
          addTo: [{ newListKey: 'frontend' }],
          removeFrom: [],
          reason: 'Categorize under frontend'
        }
      ]
    };

    const planPath = path.join(tempDir, 'plan.json');
    await fsp.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');

    const revPath = path.join(tempDir, 'review.json');
    const prevResult = await runPreview({
      store,
      snapshotPath: snapPath,
      planPath,
      outPath: revPath
    });

    assert.ok(prevResult.reviewId.startsWith('rev_'));
    assert.equal(prevResult.summary.creates, 1);
    assert.equal(prevResult.summary.membershipChanges, 1);

    // 4. Apply
    const applyResult = await runApply({
      github,
      store,
      reviewPath: revPath
    });

    assert.equal(applyResult.status, 'completed');
    assert.equal(applyResult.appliedOperations.length, 2);

    // 5. Status
    const statusResult = await runStatus({
      github,
      store,
      runId: applyResult.runId
    });

    assert.equal(statusResult.status, 'completed');
    assert.equal(statusResult.resumable, false);
    assert.equal(statusResult.appliedOperations.length, 2);
  });

  it('rejects invalid plan with PLAN_INVALID in preview', async () => {
    const tempDir = path.join(os.tmpdir(), `startidy-cli-invalid-${Date.now()}`);
    await fsp.mkdir(tempDir, { recursive: true });

    const github = new MockGitHub();
    const store = new FileStoreAdapter({ stateDir: tempDir });

    const snapPath = path.join(tempDir, 'snapshot.json');
    await runSnapshot({ github, store, outPath: snapPath });

    const invalidPlan = {
      schemaVersion: '1.0',
      missingFields: true
    };

    const planPath = path.join(tempDir, 'invalid-plan.json');
    await fsp.writeFile(planPath, JSON.stringify(invalidPlan), 'utf8');

    await assert.rejects(
      async () => runPreview({ store, snapshotPath: snapPath, planPath }),
      (err: unknown) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, 'PLAN_INVALID');
        return true;
      }
    );
  });

  it('caches empty README results to prevent redundant network calls', async () => {
    const tempDir = path.join(os.tmpdir(), `startidy-cli-details-${Date.now()}`);
    await fsp.mkdir(tempDir, { recursive: true });

    let readReadmeCount = 0;
    class DetailsMockGitHub extends MockGitHub {
      override async readReadme(): Promise<ReadmeDetails> {
        readReadmeCount++;
        return { content: '', sha: '', truncated: false, byteLength: 0, source: 'none' };
      }
    }

    const github = new DetailsMockGitHub();
    const store = new FileStoreAdapter({ stateDir: tempDir });

    const snapPath = path.join(tempDir, 'snapshot.json');
    await runSnapshot({ github, store, outPath: snapPath });

    // First call fetches from github
    const res1 = await runDetails({
      github,
      store,
      snapshotPath: snapPath,
      candidates: true
    });
    assert.equal(res1.count, 1);
    assert.equal(readReadmeCount, 1);

    // Second call should hit local cache
    const res2 = await runDetails({
      github,
      store,
      snapshotPath: snapPath,
      candidates: true
    });
    assert.equal(res2.count, 1);
    assert.equal(readReadmeCount, 1); // Not incremented!
  });

  it('rejects tampered review with PLAN_INVALID in apply', async () => {
    const tempDir = path.join(os.tmpdir(), `startidy-cli-tamper-${Date.now()}`);
    await fsp.mkdir(tempDir, { recursive: true });

    const github = new MockGitHub();
    const store = new FileStoreAdapter({ stateDir: tempDir });

    const snapPath = path.join(tempDir, 'snapshot.json');
    const snapResult = await runSnapshot({ github, store, outPath: snapPath });

    const planPath = path.join(tempDir, 'plan.json');
    await fsp.writeFile(
      planPath,
      JSON.stringify(
        {
          schemaVersion: '1.0',
          account: { hostname: dummyViewer.hostname, viewerId: dummyViewer.viewerId },
          baseSnapshotId: snapResult.snapshotId,
          mode: 'bootstrap',
          scope: { repoIds: ['R_10'], listIds: [] },
          lists: {
            create: [{ key: 'k_test', name: 'Test List', isPrivate: false }],
            update: [],
            delete: []
          },
          decisions: [
            {
              repoId: 'R_10',
              outcome: 'assign',
              addTo: [{ newListKey: 'k_test' }],
              removeFrom: [],
              reason: 'Assigning to new list'
            }
          ]
        },
        null,
        2
      )
    );

    const prevResult = await runPreview({ store, snapshotPath: snapPath, planPath });
    assert.ok(prevResult.review);

    // Tamper with the derived operation list while retaining the valid digest.
    const tamperedReview = {
      ...prevResult.review,
      operations: [
        ...(prevResult.review?.operations ?? []),
        { opId: 'op_injected_delete', type: 'DeleteList', params: { listId: 'L_never_delete', reason: 'injected' }, dependencies: [] }
      ]
    };
    const tamperedReviewPath = path.join(tempDir, 'tampered-review.json');
    await fsp.writeFile(tamperedReviewPath, JSON.stringify(tamperedReview, null, 2));

    await assert.rejects(
      async () => runApply({ github, store, reviewPath: tamperedReviewPath }),
      (err: unknown) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, 'PLAN_INVALID');
        assert.match(err.message, /operations or summary/);
        return true;
      }
    );
  });

  it('snapshot excludes repos involved in pending run', async () => {
    const tempDir = path.join(os.tmpdir(), `startidy-cli-pending-${Date.now()}`);
    await fsp.mkdir(tempDir, { recursive: true });

    const github = new MockGitHub();
    const store = new FileStoreAdapter({ stateDir: tempDir });

    // Initial snapshot
    const snapResult = await runSnapshot({ github, store });

    // Create a pending run for R_10
    const pendingRunId = 'run_pending_test';
    const pendingAccount = { hostname: dummyViewer.hostname, viewerId: dummyViewer.viewerId };
    const pendingReview: any = {
      schemaVersion: '1.0',
      reviewId: 'rev_pending_test',
      createdAt: new Date().toISOString(),
      account: pendingAccount,
      baseSnapshotId: snapResult.snapshotId,
      stateRevision: 0,
      plan: {
        schemaVersion: '1.0',
        account: pendingAccount,
        baseSnapshotId: snapResult.snapshotId,
        mode: 'bootstrap',
        scope: { repoIds: ['R_10'], listIds: [] },
        lists: { create: [], update: [], delete: [] },
        decisions: [{ repoId: 'R_10', outcome: 'assign', addTo: [], removeFrom: [], reason: 'pending' }]
      },
      digest: '1'.repeat(64),
      operations: [],
      summary: { totalCandidates: 1, creates: 0, updates: 0, deletes: 0, membershipChanges: 0, deferred: 0, ignored: 0 }
    };

    await store.createRun(dummyViewer, pendingRunId, pendingReview);
    await store.saveRunResult(dummyViewer, pendingRunId, {
      runId: pendingRunId,
      status: 'partial',
      startedAt: new Date().toISOString(),
      appliedOperations: [],
      createdListKeyMap: {}
    });

    // Next snapshot should detect pending run and exclude R_10 from candidates
    const nextSnap = await runSnapshot({ github, store });
    assert.equal(nextSnap.snapshot?.pendingRunId, pendingRunId);
    assert.equal(nextSnap.candidatesCount, 0); // R_10 is excluded!
  });

  it('requires recovery instead of silently selecting one of multiple pending runs', async () => {
    const tempDir = path.join(os.tmpdir(), `startidy-cli-multiple-pending-${Date.now()}`);
    await fsp.mkdir(tempDir, { recursive: true });
    const github = new MockGitHub();
    const store = new FileStoreAdapter({ stateDir: tempDir });
    const snapshot = await runSnapshot({ github, store });
    const account = { hostname: dummyViewer.hostname, viewerId: dummyViewer.viewerId };

    for (const [runId, digest, reviewId] of [
      ['run_pending_one', '2'.repeat(64), 'rev_pending_one'],
      ['run_pending_two', '3'.repeat(64), 'rev_pending_two']
    ]) {
      await store.createRun(account, runId, {
        schemaVersion: '1.0', reviewId, createdAt: new Date().toISOString(), account,
        baseSnapshotId: snapshot.snapshotId, stateRevision: 0,
        plan: {
          schemaVersion: '1.0', account, baseSnapshotId: snapshot.snapshotId, mode: 'bootstrap',
          scope: { repoIds: ['R_10'], listIds: [] }, lists: { create: [], update: [], delete: [] },
          decisions: [{ repoId: 'R_10', outcome: 'defer', reason: 'pending' }]
        },
        digest, operations: [],
        summary: { totalCandidates: 1, creates: 0, updates: 0, deletes: 0, membershipChanges: 0, deferred: 1, ignored: 0 }
      });
    }

    await assert.rejects(
      () => runSnapshot({ github, store }),
      (error: unknown) => error instanceof DomainError && error.code === 'RESTORE_REQUIRED'
    );
  });
});
