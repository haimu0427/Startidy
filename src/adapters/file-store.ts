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
  RunResult
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

  async acquireLock(account: { hostname: string; viewerId: string }, runId: string): Promise<LockHandle> {
    const accountDir = this.getAccountDir(account);
    await this.ensureDir(accountDir);
    const lockPath = path.join(accountDir, 'account.lock');

    const lockPayload = JSON.stringify(
      {
        runId,
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        hostname: account.hostname,
        viewerId: account.viewerId
      },
      null,
      2
    );

    try {
      // Exclusive creation 'wx'
      const handle = await fsp.open(lockPath, 'wx');
      await handle.writeFile(lockPayload, 'utf8');
      await handle.close();
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        // Lock file exists. Inspect it
        let existingLock: { runId: string; pid: number; acquiredAt: string } | null = null;
        try {
          const content = await fsp.readFile(lockPath, 'utf8');
          existingLock = JSON.parse(content);
        } catch {
          // Corrupted lock file
        }

        let isRunning = false;
        let isExpired = false;

        if (existingLock?.acquiredAt) {
          const lockTime = new Date(existingLock.acquiredAt).getTime();
          if (!Number.isNaN(lockTime)) {
            const ageMs = Date.now() - lockTime;
            const LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes
            if (ageMs > LOCK_TTL_MS) {
              isExpired = true;
            }
          }
        }

        if (existingLock?.pid && !isExpired) {
          try {
            process.kill(existingLock.pid, 0);
            isRunning = true;
          } catch (e: unknown) {
            if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
              isRunning = false;
            } else {
              isRunning = true;
            }
          }
        }

        if (isRunning) {
          throw new DomainError({
            code: 'LOCK_HELD',
            message: `Account lock is currently held by PID ${existingLock?.pid} (runId: ${existingLock?.runId ?? 'unknown'}, acquired: ${existingLock?.acquiredAt ?? 'unknown'})`,
            details: { lock: existingLock }
          });
        }

        // Stale lock: remove and retry once
        try {
          await fsp.unlink(lockPath);
          const handle = await fsp.open(lockPath, 'wx');
          await handle.writeFile(lockPayload, 'utf8');
          await handle.close();
        } catch (retryErr) {
          throw new DomainError({
            code: 'LOCK_HELD',
            message: 'Failed to acquire account lock after clearing stale lock',
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
          const data = JSON.parse(content);
          if (data.runId === runId) {
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
    const runDir = path.join(this.getAccountDir(account), 'runs', runId);
    await this.ensureDir(runDir);
    const reviewPath = path.join(runDir, 'review.json');
    await this.atomicWriteFile(reviewPath, JSON.stringify(review, null, 2));
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
