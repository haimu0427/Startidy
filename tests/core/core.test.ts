import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { determineCandidates } from '../../src/core/candidates.js';
import { buildSnapshot, assertSnapshotComplete } from '../../src/core/snapshot.js';
import { validatePlanPolicy } from '../../src/core/policy.js';
import { validatePlanSemantics } from '../../src/core/plan.js';
import { computeDiff, createReview } from '../../src/core/diff.js';
import { DomainError } from '../../src/core/errors.js';
import { validateReview } from '../../src/core/validation.js';
import type { RemoteSnapshotData, AccountProfile, AccountLedger } from '../../src/core/ports.js';
import type { Plan } from '../../src/generated/plan.js';
import type { Snapshot } from '../../src/generated/snapshot.js';

describe('Phase 1: Core Logic & Contract Verification', () => {
  const dummyViewer = { hostname: 'github.com', viewerId: 'U_123', login: 'octocat' };

  const sampleRemote: RemoteSnapshotData = {
    account: dummyViewer,
    coverage: {
      starsComplete: true,
      listsComplete: true,
      membershipsComplete: true,
      error: null
    },
    repositories: [
      { id: 'R_1', owner: 'foo', name: 'repo-1', description: 'desc 1', primaryLanguage: 'TypeScript', isStarred: true },
      { id: 'R_2', owner: 'bar', name: 'repo-2', description: 'desc 2', primaryLanguage: 'Rust', isStarred: true },
      { id: 'R_3', owner: 'baz', name: 'repo-3', description: 'desc 3', primaryLanguage: 'Go', isStarred: true },
      { id: 'R_old_unstarred', owner: 'old', name: 'repo-old', description: null, primaryLanguage: null, isStarred: false }
    ],
    lists: [
      { id: 'L_dev', name: 'Developer Tools', description: 'Tools', isPrivate: true, repositoryIds: ['R_1'], unsupportedItemCount: 0 }
    ]
  };

  describe('Candidates Determination', () => {
    it('identifies unclassified stars and pre-existing list memberships correctly', () => {
      const candidates = determineCandidates({
        repositories: sampleRemote.repositories,
        lists: sampleRemote.lists
      });

      // R_1 is starred and in L_dev -> suggested keep
      const c1 = candidates.find((c) => c.repoId === 'R_1');
      assert.ok(c1);
      assert.equal(c1.suggestedAction, 'keep');

      // R_2 and R_3 are starred and not in any list -> suggested assign
      const c2 = candidates.find((c) => c.repoId === 'R_2');
      assert.ok(c2);
      assert.equal(c2.suggestedAction, 'assign');

      const c3 = candidates.find((c) => c.repoId === 'R_3');
      assert.ok(c3);
      assert.equal(c3.suggestedAction, 'assign');

      // R_old_unstarred is not starred -> must be excluded
      const cOld = candidates.find((c) => c.repoId === 'R_old_unstarred');
      assert.equal(cOld, undefined);
    });

    it('respects ledger history, deferred items, and ignored repos', () => {
      const profile: AccountProfile = {
        schemaVersion: '1.0',
        account: dummyViewer,
        stateRevision: 1,
        initialized: true,
        preferences: {},
        ignoredRepoIds: ['R_3']
      };

      const ledger: AccountLedger = {
        schemaVersion: '1.0',
        account: dummyViewer,
        entries: {
          R_1: {
            repoId: 'R_1',
            lastOutcome: 'assign',
            lastRunId: 'run_prev',
            lastVerifiedAt: new Date().toISOString(),
            assignedListIds: ['L_dev']
          },
          R_2: {
            repoId: 'R_2',
            lastOutcome: 'defer',
            lastRunId: 'run_prev',
            lastVerifiedAt: new Date().toISOString(),
            assignedListIds: [],
            reason: 'Insufficient info'
          }
        }
      };

      const candidates = determineCandidates({
        repositories: sampleRemote.repositories,
        lists: sampleRemote.lists,
        profile,
        ledger
      });

      // R_1 was assigned to L_dev, remote is still L_dev -> skipped
      assert.equal(candidates.find((c) => c.repoId === 'R_1'), undefined);

      // R_2 was deferred -> candidate for assign with reason
      const c2 = candidates.find((c) => c.repoId === 'R_2');
      assert.ok(c2);
      assert.equal(c2.suggestedAction, 'assign');
      assert.match(c2.reason, /Insufficient info/);

      // R_3 is in profile.ignoredRepoIds -> skipped
      assert.equal(candidates.find((c) => c.repoId === 'R_3'), undefined);
    });

    it('excludes repos in active pending runs', () => {
      const candidates = determineCandidates({
        repositories: sampleRemote.repositories,
        lists: sampleRemote.lists,
        pendingRunRepoIds: new Set(['R_2'])
      });

      assert.equal(candidates.find((c) => c.repoId === 'R_2'), undefined);
    });
  });

  describe('Snapshot Integrity & Build', () => {
    it('rejects incomplete snapshot coverage', () => {
      const incompleteSnapshot: Snapshot = {
        schemaVersion: '1.0',
        snapshotId: 'snap_1',
        capturedAt: new Date().toISOString(),
        account: dummyViewer,
        coverage: {
          starsComplete: false,
          listsComplete: true,
          membershipsComplete: true,
          error: 'Rate limit'
        },
        repositories: [],
        lists: [],
        stateRevision: 0,
        candidates: []
      };

      assert.throws(() => assertSnapshotComplete(incompleteSnapshot), (err: unknown) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, 'STATE_CONFLICT');
        return true;
      });
    });

    it('builds a valid normalized snapshot matching schema', () => {
      const snapshot = buildSnapshot({
        remote: sampleRemote
      });

      assert.equal(snapshot.schemaVersion, '1.0');
      assert.ok(snapshot.snapshotId.startsWith('snap_'));
      assert.equal(snapshot.repositories.length, 4);
      assertSnapshotComplete(snapshot);
    });
  });

  describe('Plan Policy & Semantics Validation', () => {
    let snapshot: Snapshot;

    it('validates a correct incremental plan', () => {
      snapshot = buildSnapshot({ remote: sampleRemote });

      const plan: Plan = {
        schemaVersion: '1.0',
        account: { hostname: 'github.com', viewerId: 'U_123' },
        baseSnapshotId: snapshot.snapshotId,
        mode: 'incremental',
        scope: { repoIds: ['R_2'], listIds: [] },
        lists: {
          create: [{ key: 'web-tools', name: 'Web Tools', isPrivate: true }],
          update: [],
          delete: []
        },
        decisions: [
          {
            repoId: 'R_2',
            outcome: 'assign',
            addTo: [{ newListKey: 'web-tools' }],
            removeFrom: [],
            reason: 'Categorized under web tools'
          }
        ]
      };

      assert.doesNotThrow(() => validatePlanSemantics(plan, snapshot));
      assert.doesNotThrow(() => validatePlanPolicy({ plan, snapshot }));
    });

    it('rejects normalized new-list names that collide with snapshot lists', () => {
      snapshot = buildSnapshot({ remote: sampleRemote });
      const plan: Plan = {
        schemaVersion: '1.0',
        account: { hostname: 'github.com', viewerId: 'U_123' },
        baseSnapshotId: snapshot.snapshotId,
        mode: 'incremental',
        scope: { repoIds: ['R_2'], listIds: [] },
        lists: { create: [{ key: 'collision', name: '  developer tools  ', isPrivate: true }], update: [], delete: [] },
        decisions: [{ repoId: 'R_2', outcome: 'assign', addTo: [{ newListKey: 'collision' }], removeFrom: [], reason: 'test' }]
      };

      assert.throws(() => validatePlanSemantics(plan, snapshot), (err: unknown) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, 'PLAN_INVALID');
        assert.match(err.message, /conflicts with an existing snapshot list/);
        return true;
      });
    });

    it('rejects list deletion or updates in incremental mode', () => {
      snapshot = buildSnapshot({ remote: sampleRemote });

      const planWithDelete: Plan = {
        schemaVersion: '1.0',
        account: { hostname: 'github.com', viewerId: 'U_123' },
        baseSnapshotId: snapshot.snapshotId,
        mode: 'incremental',
        scope: { repoIds: ['R_2'], listIds: [] },
        lists: {
          create: [],
          update: [],
          delete: [{ listId: 'L_dev', reason: 'Unwanted' }]
        },
        decisions: [
          {
            repoId: 'R_2',
            outcome: 'keep'
          }
        ]
      };

      assert.throws(() => validatePlanPolicy({ plan: planWithDelete, snapshot }), (err: unknown) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, 'POLICY_VIOLATION');
        return true;
      });
    });

    it('rejects removing memberships in incremental mode', () => {
      snapshot = buildSnapshot({ remote: sampleRemote });

      const planWithRemove: Plan = {
        schemaVersion: '1.0',
        account: { hostname: 'github.com', viewerId: 'U_123' },
        baseSnapshotId: snapshot.snapshotId,
        mode: 'incremental',
        scope: { repoIds: ['R_1'], listIds: [] },
        lists: { create: [], update: [], delete: [] },
        decisions: [
          {
            repoId: 'R_1',
            outcome: 'assign',
            addTo: [],
            removeFrom: [{ listId: 'L_dev' }],
            reason: 'Try to remove in incremental'
          }
        ]
      };

      assert.throws(() => validatePlanPolicy({ plan: planWithRemove, snapshot }), (err: unknown) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, 'POLICY_VIOLATION');
        return true;
      });
    });

    it('enforces that deleting a list requires explicit removal decisions for all its members', () => {
      snapshot = buildSnapshot({ remote: sampleRemote });

      // In targeted mode, attempting to delete L_dev without decision removing R_1
      const unsafeDeletePlan: Plan = {
        schemaVersion: '1.0',
        account: { hostname: 'github.com', viewerId: 'U_123' },
        baseSnapshotId: snapshot.snapshotId,
        mode: 'targeted',
        scope: { repoIds: ['R_2'], listIds: ['L_dev'] },
        lists: {
          create: [],
          update: [],
          delete: [{ listId: 'L_dev', reason: 'Retiring list' }]
        },
        decisions: [
          {
            repoId: 'R_2',
            outcome: 'keep'
          }
        ]
      };

      assert.throws(() => validatePlanPolicy({ plan: unsafeDeletePlan, snapshot }), (err: unknown) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, 'POLICY_VIOLATION');
        assert.match(err.message, /member R_1 is missing an explicit removal decision/);
        return true;
      });
    });

    it('enforces scope completeness and rejects out-of-scope decisions', () => {
      snapshot = buildSnapshot({ remote: sampleRemote });

      const mismatchPlan: Plan = {
        schemaVersion: '1.0',
        account: { hostname: 'github.com', viewerId: 'U_123' },
        baseSnapshotId: snapshot.snapshotId,
        mode: 'incremental',
        scope: { repoIds: ['R_2'], listIds: [] },
        lists: { create: [], update: [], delete: [] },
        decisions: [
          { repoId: 'R_2', outcome: 'keep' },
          { repoId: 'R_3', outcome: 'keep' } // R_3 is not in scope.repoIds
        ]
      };

      assert.throws(() => validatePlanSemantics(mismatchPlan, snapshot), (err: unknown) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, 'SCOPE_MISMATCH');
        return true;
      });
    });
  });

  describe('Diff Calculation & Review Generation', () => {
    it('computes clean atomic operations and review matching review schema', () => {
      const snapshot = buildSnapshot({ remote: sampleRemote });

      const plan: Plan = {
        schemaVersion: '1.0',
        account: { hostname: 'github.com', viewerId: 'U_123' },
        baseSnapshotId: snapshot.snapshotId,
        mode: 'incremental',
        scope: { repoIds: ['R_1', 'R_2', 'R_3'], listIds: [] },
        lists: {
          create: [{ key: 'new-lang', name: 'Languages', isPrivate: true }],
          update: [],
          delete: []
        },
        decisions: [
          {
            // R_1 is already in L_dev; adding new-lang: (L_dev ∪ new-lang)
            repoId: 'R_1',
            outcome: 'assign',
            addTo: [{ newListKey: 'new-lang' }],
            removeFrom: [],
            reason: 'Add to Languages'
          },
          {
            repoId: 'R_2',
            outcome: 'defer',
            reason: 'Need more analysis'
          },
          {
            repoId: 'R_3',
            outcome: 'keep'
          }
        ]
      };

      const diff = computeDiff(plan, snapshot);
      assert.equal(diff.operations.length, 2); // 1 CreateList + 1 SetMemberships

      const createOp = diff.operations.find((op) => op.type === 'CreateList');
      assert.ok(createOp);
      assert.equal(createOp.opId, 'op_create_new-lang');

      const memOp = diff.operations.find((op) => op.type === 'SetMemberships');
      assert.ok(memOp);
      assert.equal(memOp.opId, 'op_memberships_R_1');
      assert.deepEqual(memOp.dependencies, ['op_create_new-lang']);

      assert.equal(diff.summary.creates, 1);
      assert.equal(diff.summary.membershipChanges, 1);
      assert.equal(diff.summary.deferred, 1);

      const review = createReview({ plan, snapshot });
      assert.ok(review.reviewId.startsWith('rev_'));
      assert.ok(review.digest);

      // Validate review against Ajv schema
      const validated = validateReview(review);
      assert.equal(validated.reviewId, review.reviewId);
    });
  });
});
