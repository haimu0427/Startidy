import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type {
  StorePort,
  LockHandle,
  AccountProfile,
  AccountLedger,
  RunEvent,
  RunResult,
  PendingRun
} from '../core/ports.js';
import type { Snapshot } from '../generated/snapshot.js';
import type { Review } from '../generated/review.js';
import { DomainError } from '../core/errors.js';
import { validateSnapshot, validateReview } from '../core/validation.js';

export function getDefaultStateDir(): string {
  if (process.env.STARTIDY_STATE_DIR) {
    return path.resolve(process.env.STARTIDY_STATE_DIR);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'startidy');
  }
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdgData, 'startidy');
}

export class FileStoreAdapter implements StorePort {
  readonly baseDir: string;

  constructor(options?: { stateDir?: string }) {
    this.baseDir = options?.stateDir ? path.resolve(options.stateDir) : getDefaultStateDir();
  }

  getAccountKey(account: { hostname: string; viewerId: string }): string {
    const raw = `${account.hostname.toLowerCase()}#${account.viewerId}`;
    const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
    const safeHost = account.hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
    return `${safeHost}_${hash}`;
  }

  private getAccountDir(account: { hostname: string; viewerId: string }): string {
    return path.join(this.baseDir, 'accounts', this.getAccountKey(account));
  }

  private async ensureDir(dirPath: string): Promise<void> {
    await fsp.mkdir(dirPath, { recursive: true });
  }

  private async atomicWriteFile(filePath: string, content: string): Promise<void> {
    const dir = path.dirname(filePath);
    await this.ensureDir(dir);
    const tmpPath = `${filePath}.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
    await fsp.writeFile(tmpPath, content, 'utf8');
    await fsp.rename(tmpPath, filePath);
  }

  private assertDigest(digest: string): void {
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new DomainError({
        code: 'PLAN_INVALID',
        message: 'Review digest must be a lowercase SHA-256 hex string'
      });
    }
  }

  async acquireLock(account: { hostname: string; viewerId: string }, runId: string): Promise<LockHandle> {
    const accountDir = this.getAccountDir(account);
    await this.ensureDir(accountDir);
    const lockPath = path.join(accountDir, 'account.lock');
    const ownerToken = crypto.randomUUID();

    const lockPayload = JSON.stringify(
      {
        runId,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        ownerToken,
        hostname: account.hostname,
        viewerId: account.viewerId
      },
      null,
      2
    );

    const writeExclusiveLock = async (): Promise<void> => {
      const handle = await fsp.open(lockPath, 'wx');
      await handle.writeFile(lockPayload, 'utf8');
      await handle.close();
    };

    try {
      await writeExclusiveLock();
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        let existingLock: { runId: string; pid: number; acquiredAt: string; ownerToken: string } | null = null;
        try {
          const content = await fsp.readFile(lockPath, 'utf8');
          existingLock = JSON.parse(content);
        } catch {
          throw new DomainError({
            code: 'LOCK_HELD',
            message: `Account lock is unreadable and will not be reclaimed automatically: ${lockPath}`,
            details: { lockPath }
          });
        }

        if (
          !existingLock?.runId ||
          !Number.isInteger(existingLock.pid) ||
          typeof existingLock.acquiredAt !== 'string' ||
          !existingLock.ownerToken
        ) {
          throw new DomainError({
            code: 'LOCK_HELD',
            message: `Account lock is malformed and will not be reclaimed automatically: ${lockPath}`,
            details: { lockPath, lock: existingLock }
          });
        }

        let processIsDead = false;
        try {
          process.kill(existingLock.pid, 0);
        } catch (probeError: unknown) {
          if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') {
            processIsDead = true;
          } else {
            // EPERM and unknown probe failures are not proof that the owner died.
            throw new DomainError({
              code: 'LOCK_HELD',
              message: `Account lock is held by PID ${existingLock.pid} (runId: ${existingLock.runId})`,
              details: { lock: existingLock }
            });
          }
        }

        if (!processIsDead) {
          throw new DomainError({
            code: 'LOCK_HELD',
            message: `Account lock is currently held by PID ${existingLock.pid} (runId: ${existingLock.runId}, acquired: ${existingLock.acquiredAt})`,
            details: { lock: existingLock }
          });
        }

        // A dead owner can be reclaimed. Rename first so concurrent reclaimers
        // cannot unlink a newly acquired replacement lock.
        const quarantinePath = `${lockPath}.stale.${crypto.randomUUID()}`;
        try {
          await fsp.rename(lockPath, quarantinePath);
          await writeExclusiveLock();
          await fsp.unlink(quarantinePath).catch(() => undefined);
        } catch (retryErr) {
          await fsp.unlink(quarantinePath).catch(() => undefined);
          throw new DomainError({
            code: 'LOCK_HELD',
            message: 'Failed to acquire account lock after safely reclaiming a dead owner',
            cause: retryErr
          });
        }
      } else {
        throw err;
      }
    }

    return {
      runId,
      release: async () => {
        try {
          const content = await fsp.readFile(lockPath, 'utf8');
          const data = JSON.parse(content) as { runId?: string; ownerToken?: string };
          if (data.runId === runId && data.ownerToken === ownerToken) {
            await fsp.unlink(lockPath);
          }
        } catch {
          // Ignored if lock is already deleted or moved
        }
      }
    };
  }

  async loadProfile(account: { hostname: string; viewerId: string }): Promise<AccountProfile | null> {
    const profilePath = path.join(this.getAccountDir(account), 'profile.json');
    try {
      const content = await fsp.readFile(profilePath, 'utf8');
      return JSON.parse(content) as AccountProfile;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async saveProfile(account: { hostname: string; viewerId: string }, profile: AccountProfile): Promise<void> {
    const profilePath = path.join(this.getAccountDir(account), 'profile.json');
    await this.atomicWriteFile(profilePath, JSON.stringify(profile, null, 2));
  }

  async loadLedger(account: { hostname: string; viewerId: string }): Promise<AccountLedger> {
    const ledgerPath = path.join(this.getAccountDir(account), 'ledger.json');
    try {
      const content = await fsp.readFile(ledgerPath, 'utf8');
      return JSON.parse(content) as AccountLedger;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          schemaVersion: '1.0',
          account: {
            hostname: account.hostname,
            viewerId: account.viewerId
          },
          entries: {}
        };
      }
      throw err;
    }
  }

  async saveLedger(account: { hostname: string; viewerId: string }, ledger: AccountLedger): Promise<void> {
    const ledgerPath = path.join(this.getAccountDir(account), 'ledger.json');
    await this.atomicWriteFile(ledgerPath, JSON.stringify(ledger, null, 2));
  }

  async saveSnapshot(account: { hostname: string; viewerId: string }, snapshot: Snapshot): Promise<string> {
    validateSnapshot(snapshot);
    const snapshotPath = path.join(this.getAccountDir(account), 'snapshots', `${snapshot.snapshotId}.json`);
    await this.atomicWriteFile(snapshotPath, JSON.stringify(snapshot, null, 2));
    return snapshotPath;
  }

  async loadSnapshot(account: { hostname: string; viewerId: string }, snapshotId: string): Promise<Snapshot | null> {
    const snapshotPath = path.join(this.getAccountDir(account), 'snapshots', `${snapshotId}.json`);
    try {
      const content = await fsp.readFile(snapshotPath, 'utf8');
      const parsed = JSON.parse(content);
      return validateSnapshot(parsed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async createRun(account: { hostname: string; viewerId: string }, runId: string, review: Review): Promise<void> {
    validateReview(review);
    this.assertDigest(review.digest);
    const runDir = path.join(this.getAccountDir(account), 'runs', runId);
    await this.ensureDir(runDir);
    const reviewPath = path.join(runDir, 'review.json');
    await this.atomicWriteFile(reviewPath, JSON.stringify(review, null, 2));

    const byDigestDir = path.join(this.getAccountDir(account), 'runs', 'by-digest');
    await this.ensureDir(byDigestDir);
    const digestPointerPath = path.join(byDigestDir, `${review.digest}.json`);
    await this.atomicWriteFile(digestPointerPath, JSON.stringify({ runId, createdAt: new Date().toISOString() }));
  }

  async appendRunEvent(
    account: { hostname: string; viewerId: string },
    runId: string,
    event: RunEvent
  ): Promise<void> {
    const runDir = path.join(this.getAccountDir(account), 'runs', runId);
    await this.ensureDir(runDir);
    const eventsPath = path.join(runDir, 'events.jsonl');
    const line = JSON.stringify(event) + '\n';
    await fsp.appendFile(eventsPath, line, 'utf8');
  }

  async getRunEvents(account: { hostname: string; viewerId: string }, runId: string): Promise<RunEvent[]> {
    const eventsPath = path.join(this.getAccountDir(account), 'runs', runId, 'events.jsonl');
    try {
      const content = await fsp.readFile(eventsPath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      const events: RunEvent[] = [];
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // Ignore incomplete trailing line
        }
      }
      return events;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }
  }

  async saveRunResult(account: { hostname: string; viewerId: string }, runId: string, result: RunResult): Promise<void> {
    const resultPath = path.join(this.getAccountDir(account), 'runs', runId, 'result.json');
    await this.atomicWriteFile(resultPath, JSON.stringify(result, null, 2));
  }

  async loadRunResult(account: { hostname: string; viewerId: string }, runId: string): Promise<RunResult | null> {
    const resultPath = path.join(this.getAccountDir(account), 'runs', runId, 'result.json');
    try {
      const content = await fsp.readFile(resultPath, 'utf8');
      return JSON.parse(content) as RunResult;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async loadReview(account: { hostname: string; viewerId: string }, runId: string): Promise<Review | null> {
    const reviewPath = path.join(this.getAccountDir(account), 'runs', runId, 'review.json');
    try {
      const content = await fsp.readFile(reviewPath, 'utf8');
      const parsed = JSON.parse(content);
      return validateReview(parsed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  async findRunByReviewDigest(
    account: { hostname: string; viewerId: string },
    digest: string
  ): Promise<{ runId: string; result: RunResult | null } | null> {
    this.assertDigest(digest);
    const digestPointerPath = path.join(this.getAccountDir(account), 'runs', 'by-digest', `${digest}.json`);
    try {
      const content = await fsp.readFile(digestPointerPath, 'utf8');
      const { runId } = JSON.parse(content) as { runId: string };
      const result = await this.loadRunResult(account, runId);
      return { runId, result };
    } catch {
      // Fallback for runs created before the digest pointer existed.
      const runsDir = path.join(this.getAccountDir(account), 'runs');
      try {
        const entries = await fsp.readdir(runsDir, { withFileTypes: true });
        const matches: Array<{ runId: string; result: RunResult | null; createdAt: string }> = [];
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name !== 'by-digest') {
            const review = await this.loadReview(account, entry.name);
            if (review && review.digest === digest) {
              const result = await this.loadRunResult(account, entry.name);
              matches.push({ runId: entry.name, result, createdAt: review.createdAt });
            }
          }
        }
        matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const selected = matches.find((match) => match.result?.status === 'completed') ?? matches[0];
        if (selected) return { runId: selected.runId, result: selected.result };
      } catch {
        return null;
      }
      return null;
    }
  }

  async listPendingRuns(account: { hostname: string; viewerId: string }): Promise<PendingRun[]> {
    const runsDir = path.join(this.getAccountDir(account), 'runs');
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(runsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const runDirs = entries.filter((e) => e.isDirectory() && e.name !== 'by-digest');
    const pending: PendingRun[] = [];

    for (const dir of runDirs) {
      const runId = dir.name;
      const review = await this.loadReview(account, runId);
      if (!review) continue;

      const result = await this.loadRunResult(account, runId);
      const events = await this.getRunEvents(account, runId);
      const terminalFromJournal = events.some(
        (event) => event.phase === 'run_finish' || event.phase === 'run_cancelled'
      );
      if (!terminalFromJournal && (!result || (result.status !== 'completed' && result.status !== 'cancelled'))) {
        pending.push({ runId, review, result });
      }
    }
    pending.sort((a, b) => b.review.createdAt.localeCompare(a.review.createdAt));
    return pending;
  }

  async getCachedReadme(accountKey: string, repoId: string, sha?: string): Promise<string | null> {
    const cacheFile = path.join(this.baseDir, 'accounts', accountKey, 'cache', 'readmes', `${repoId}.json`);
    try {
      const content = await fsp.readFile(cacheFile, 'utf8');
      const data = JSON.parse(content);
      if (sha && data.sha !== sha) {
        return null;
      }
      return data.content ?? null;
    } catch {
      return null;
    }
  }

  async saveCachedReadme(
    accountKey: string,
    repoId: string,
    sha: string,
    content: string
  ): Promise<void> {
    const cacheFile = path.join(this.baseDir, 'accounts', accountKey, 'cache', 'readmes', `${repoId}.json`);
    await this.atomicWriteFile(cacheFile, JSON.stringify({ repoId, sha, content, cachedAt: Date.now() }, null, 2));
  }
}
