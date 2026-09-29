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
      return input;
    }
    async getList(listId: string): Promise<RemoteListInfo | null> {
      return this.lists.find((l) => l.id === listId) ?? null;
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
});
