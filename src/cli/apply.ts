import fsp from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { GitHubPort, StorePort, RunResult } from '../core/ports.js';
import type { Review } from '../generated/review.js';
import { validateReview } from '../core/validation.js';
import { executeReview } from '../core/executor.js';
import { DomainError } from '../core/errors.js';
import { validatePlanPolicy } from '../core/policy.js';
import { computeDiff, computeReviewDigest } from '../core/diff.js';
import { validatePlanSemantics } from '../core/plan.js';

export async function prepareReviewForApply(options: {
  github: GitHubPort;
  store: StorePort;
  review: Review;
}): Promise<Review> {
  const { github, store } = options;
  const unverifiedReview = validateReview(options.review);
  const viewer = await github.getViewer();
  if (
    viewer.viewerId !== unverifiedReview.account.viewerId ||
    viewer.hostname !== unverifiedReview.account.hostname
  ) {
    throw new DomainError({
      code: 'AUTH_FAILED',
      message: `Current GitHub identity (${viewer.hostname}/${viewer.viewerId}) does not match review account (${unverifiedReview.account.hostname}/${unverifiedReview.account.viewerId})`
    });
  }

  const baseSnapshot = await store.loadSnapshot(viewer, unverifiedReview.baseSnapshotId);
  if (!baseSnapshot) {
    throw new DomainError({
      code: 'PLAN_STALE',
      message: `Base snapshot not found in store: ${unverifiedReview.baseSnapshotId}`
    });
  }
  if (
    baseSnapshot.account.hostname !== unverifiedReview.account.hostname ||
    baseSnapshot.account.viewerId !== unverifiedReview.account.viewerId ||
    baseSnapshot.stateRevision !== unverifiedReview.stateRevision
  ) {
    throw new DomainError({
      code: 'PLAN_STALE',
      message: 'Review account or state revision does not match its saved base snapshot'
    });
  }

  const profile = await store.loadProfile(viewer);
  validatePlanSemantics(unverifiedReview.plan, baseSnapshot);
  validatePlanPolicy({ plan: unverifiedReview.plan, snapshot: baseSnapshot, profile });

  const { operations, summary } = computeDiff(unverifiedReview.plan, baseSnapshot);
  const expectedDigest = computeReviewDigest(
    unverifiedReview.plan,
    baseSnapshot.snapshotId,
    baseSnapshot.stateRevision,
    operations
  );
  if (unverifiedReview.digest !== expectedDigest) {
    throw new DomainError({
      code: 'PLAN_INVALID',
      message: 'Review digest mismatch: review file has been modified or does not match base snapshot.'
    });
  }
  if (!isDeepStrictEqual(unverifiedReview.operations, operations) || !isDeepStrictEqual(unverifiedReview.summary, summary)) {
    throw new DomainError({
      code: 'PLAN_INVALID',
      message: 'Review operations or summary do not match the canonical diff for its plan and snapshot'
    });
  }
  return { ...unverifiedReview, operations, summary };
}

export async function runApply(options: {
  github: GitHubPort;
  store: StorePort;
  reviewPath?: string;
  resumeRunId?: string;
}): Promise<RunResult> {
  const { github, store, reviewPath, resumeRunId } = options;

  let review: Review;
  let isResume = false;

  if (resumeRunId) {
    isResume = true;
    const viewer = await github.getViewer();
    const loaded = await store.loadReview(viewer, resumeRunId);
    if (!loaded) {
      throw new DomainError({
        code: 'STATE_CONFLICT',
        message: `No review found to resume for runId: ${resumeRunId}`
      });
    }
    review = await prepareReviewForApply({ github, store, review: loaded });
  } else if (reviewPath) {
    let rawContent: string;
    try {
      rawContent = await fsp.readFile(path.resolve(reviewPath), 'utf8');
    } catch (err) {
      throw new DomainError({
        code: 'PLAN_INVALID',
        message: `Failed to read review file at ${reviewPath}`,
        cause: err
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch (err) {
      throw new DomainError({
        code: 'PLAN_INVALID',
        message: `Failed to parse review JSON at ${reviewPath}`,
        cause: err
      });
    }

    review = await prepareReviewForApply({ github, store, review: validateReview(parsed) });
  } else {
    throw new DomainError({
      code: 'PLAN_INVALID',
      message: 'Must specify either --review <path> or --resume <runId>'
    });
  }

  return await executeReview({
    github,
    store,
    review,
    runId: resumeRunId,
    isResume
  });
}
