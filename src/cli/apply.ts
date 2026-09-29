import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GitHubPort, StorePort, RunResult } from '../core/ports.js';
import type { Review } from '../generated/review.js';
import { validateReview } from '../core/validation.js';
import { executeReview } from '../core/executor.js';
import { DomainError } from '../core/errors.js';

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
    review = loaded;
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
    review = validateReview(JSON.parse(rawContent));
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
