import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseGhError, GitHubGhAdapter, type GhExecutor } from '../../src/adapters/github-gh.js';
import { FileStoreAdapter } from '../../src/adapters/file-store.js';
import { DomainError } from '../../src/core/errors.js';
import type { Snapshot } from '../../src/generated/snapshot.js';

describe('Phase 2: Adapters Verification', () => {
  describe('GH Adapter Error Mapping', () => {
    it('correctly categorizes auth failure', () => {
      const err = parseGhError('gh: authentication token expired or invalid');
      assert.equal(err.code, 'AUTH_FAILED');
      assert.equal(err.retryable, false);
    });

    it('correctly categorizes network errors as retryable', () => {
      const err = parseGhError('fatal: could not resolve host: github.com');
      assert.equal(err.code, 'NETWORK_ERROR');
      assert.equal(err.retryable, true);
    });

    it('correctly categorizes rate limit errors as retryable', () => {
      const err = parseGhError('HTTP 429: API rate limit exceeded');
      assert.equal(err.code, 'RATE_LIMIT_EXCEEDED');
      assert.equal(err.retryable, true);
    });

    it('correctly categorizes permission errors', () => {
      const err = parseGhError('GraphQL: Resource not accessible by integration (HTTP 403)');
      assert.equal(err.code, 'PERMISSION_DENIED');
      assert.equal(err.retryable, false);
    });
  });

  describe('GH Adapter with Mock Executor', () => {
    it('queries viewer and parses response correctly', async () => {
      const mockExecutor: GhExecutor = async (args, stdin) => {
        assert.ok(args.includes('graphql'));
        return {
          stdout: JSON.stringify({
            data: {
              viewer: {
                id: 'U_mock_123',
                login: 'mockuser'
              }
            }
          }),
          stderr: '',
          exitCode: 0
        };
      };

      const adapter = new GitHubGhAdapter({ executor: mockExecutor });
      const viewer = await adapter.getViewer();

      assert.equal(viewer.hostname, 'github.com');
      assert.equal(viewer.viewerId, 'U_mock_123');
      assert.equal(viewer.login, 'mockuser');
    });

    it('throws DomainError on non-zero exit code', async () => {
      const failingExecutor: GhExecutor = async () => ({
        stdout: '',
        stderr: 'error: bad credentials',
        exitCode: 1
      });

      const adapter = new GitHubGhAdapter({ executor: failingExecutor });
      await assert.rejects(async () => adapter.getViewer(), (err: unknown) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, 'AUTH_FAILED');
        return true;
      });
    });

    it('omits description when updating unrelated list fields', async () => {
      let payload: { variables?: { input?: Record<string, unknown> } } | undefined;
      const executor: GhExecutor = async (_args, stdin) => {
        payload = JSON.parse(stdin ?? '{}');
        return { stdout: JSON.stringify({ data: { updateUserList: { list: { id: 'L_1' } } } }), stderr: '', exitCode: 0 };
      };
      const adapter = new GitHubGhAdapter({ executor });
      await adapter.updateList({ listId: 'L_1', changes: { name: 'Renamed' } });
      assert.deepEqual(payload?.variables?.input, { listId: 'L_1', name: 'Renamed' });
    });

    it('sends an explicit null description when requested', async () => {
      let payload: { variables?: { input?: Record<string, unknown> } } | undefined;
      const executor: GhExecutor = async (_args, stdin) => {
        payload = JSON.parse(stdin ?? '{}');
        return { stdout: JSON.stringify({ data: { updateUserList: { list: { id: 'L_1' } } } }), stderr: '', exitCode: 0 };
      };
      const adapter = new GitHubGhAdapter({ executor });
      await adapter.updateList({ listId: 'L_1', changes: { description: null } });
      assert.deepEqual(payload?.variables?.input, { listId: 'L_1', description: null });
    });
  });

  describe('File Store Adapter', () => {
    const tempDir = path.join(os.tmpdir(), `startidy-test-${Date.now()}`);

    it('isolates accounts and performs atomic writes', async () => {
      const store = new FileStoreAdapter({ stateDir: tempDir });
      const accountA = { hostname: 'github.com', viewerId: 'U_111' };
      const accountB = { hostname: 'github.com', viewerId: 'U_222' };

      const keyA = store.getAccountKey(accountA);
      const keyB = store.getAccountKey(accountB);
      assert.notEqual(keyA, keyB);

      // Save profile for account A
      await store.saveProfile(accountA, {
        schemaVersion: '1.0',
        account: { hostname: 'github.com', viewerId: 'U_111', login: 'user1' },
        stateRevision: 1,
        initialized: true,
        preferences: { namingLanguage: 'en' },
        ignoredRepoIds: ['R_ignore']
      });

      const profileA = await store.loadProfile(accountA);
      assert.ok(profileA);
      assert.equal(profileA.account.login, 'user1');

      // Account B should be independent (null)
      const profileB = await store.loadProfile(accountB);
      assert.equal(profileB, null);
    });

    it('manages account locks exclusively and rejects concurrent lock requests', async () => {
      const store = new FileStoreAdapter({ stateDir: tempDir });
      const account = { hostname: 'github.com', viewerId: 'U_lock_test' };

      const lock1 = await store.acquireLock(account, 'run_1');
      assert.equal(lock1.runId, 'run_1');

      // Attempting to acquire lock while held by process.pid should fail
      await assert.rejects(async () => store.acquireLock(account, 'run_2'), (err: unknown) => {
        assert.ok(err instanceof DomainError);
        assert.equal(err.code, 'LOCK_HELD');
        return true;
      });

      // Release lock1
      await lock1.release();

      // Now lock2 should succeed
      const lock2 = await store.acquireLock(account, 'run_2');
      assert.equal(lock2.runId, 'run_2');
      await lock2.release();
    });

    it('does not steal an old lock while its owning process is alive', async () => {
      const store = new FileStoreAdapter({ stateDir: tempDir });
      const account = { hostname: 'github.com', viewerId: 'U_lock_old_alive' };
      const lock = await store.acquireLock(account, 'run_live');
      const lockPath = path.join(store.baseDir, 'accounts', store.getAccountKey(account), 'account.lock');
      const payload = JSON.parse(await fsp.readFile(lockPath, 'utf8'));
      payload.acquiredAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      await fsp.writeFile(lockPath, JSON.stringify(payload), 'utf8');

      await assert.rejects(
        () => store.acquireLock(account, 'run_contender'),
        (err: unknown) => err instanceof DomainError && err.code === 'LOCK_HELD'
      );
      await lock.release();
    });

    it('reclaims a lock only after its owner PID is confirmed dead', async () => {
      const store = new FileStoreAdapter({ stateDir: tempDir });
      const account = { hostname: 'github.com', viewerId: 'U_lock_dead_owner' };
      const lockDir = path.join(store.baseDir, 'accounts', store.getAccountKey(account));
      await fsp.mkdir(lockDir, { recursive: true });
      await fsp.writeFile(
        path.join(lockDir, 'account.lock'),
        JSON.stringify({ runId: 'run_dead', pid: 2147483647, acquiredAt: new Date().toISOString(), ownerToken: 'dead-owner' }),
        'utf8'
      );

      const lock = await store.acquireLock(account, 'run_reclaimed');
      assert.equal(lock.runId, 'run_reclaimed');
      await lock.release();
    });

    it('allows only one concurrent reclaimer to replace a dead lock', async () => {
      const store = new FileStoreAdapter({ stateDir: tempDir });
      const account = { hostname: 'github.com', viewerId: 'U_lock_concurrent_dead' };
      const lockDir = path.join(store.baseDir, 'accounts', store.getAccountKey(account));
      await fsp.mkdir(lockDir, { recursive: true });
      await fsp.writeFile(
        path.join(lockDir, 'account.lock'),
        JSON.stringify({ runId: 'run_dead', pid: 2147483647, acquiredAt: new Date().toISOString(), ownerToken: 'dead-owner' }),
        'utf8'
      );

      const attempts = await Promise.allSettled([
        store.acquireLock(account, 'run_reclaimer_a'),
        store.acquireLock(account, 'run_reclaimer_b')
      ]);
      const acquired = attempts.filter(
        (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof store.acquireLock>>> => attempt.status === 'fulfilled'
      );
      assert.equal(acquired.length, 1);
      await acquired[0].value.release();
    });

    it('appends and reads run events reliably', async () => {
      const store = new FileStoreAdapter({ stateDir: tempDir });
      const account = { hostname: 'github.com', viewerId: 'U_events_test' };
      const runId = 'run_event_1';

      await store.appendRunEvent(account, runId, {
        eventId: 'evt_1',
        timestamp: new Date().toISOString(),
        runId,
        phase: 'run_start'
      });

      await store.appendRunEvent(account, runId, {
        eventId: 'evt_2',
        timestamp: new Date().toISOString(),
        runId,
        opId: 'op_1',
        phase: 'op_verified',
        details: { result: 'ok' }
      });

      const events = await store.getRunEvents(account, runId);
      assert.equal(events.length, 2);
      assert.equal(events[0].eventId, 'evt_1');
      assert.equal(events[1].eventId, 'evt_2');
      assert.equal(events[1].phase, 'op_verified');
    });
  });
});
