import fsp from 'node:fs/promises';
import path from 'node:path';
import type { StorePort } from '../core/ports.js';
import type { Review } from '../generated/review.js';
import { validateSnapshot, validatePlan } from '../core/validation.js';
import { validatePlanSemantics } from '../core/plan.js';
import { validatePlanPolicy } from '../core/policy.js';
import { createReview } from '../core/diff.js';
import { DomainError } from '../core/errors.js';

export interface PreviewCommandResult {
  reviewId: string;
  createdAt: string;
  digest: string;
  totalOperations: number;
  summary: Review['summary'];
  outPath?: string;
  review?: Review;
}

export async function runPreview(options: {
  store: StorePort;
  snapshotPath: string;
  planPath: string;
  outPath?: string;
}): Promise<PreviewCommandResult> {
  const { store, snapshotPath, planPath, outPath } = options;

  let snapshotContent: string;
  try {
    snapshotContent = await fsp.readFile(path.resolve(snapshotPath), 'utf8');
  } catch (err) {
    throw new DomainError({
      code: 'PLAN_INVALID',
      message: `Failed to read snapshot file: ${snapshotPath}`,
      cause: err
    });
  }

  const snapshot = validateSnapshot(JSON.parse(snapshotContent));

  let planContent: string;
  if (planPath === '-') {
    planContent = await new Promise<string>((resolve, reject) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        data += chunk;
      });
      process.stdin.on('end', () => resolve(data));
      process.stdin.on('error', (err) => reject(err));
    });
  } else {
    try {
      planContent = await fsp.readFile(path.resolve(planPath), 'utf8');
    } catch (err) {
      throw new DomainError({
        code: 'PLAN_INVALID',
        message: `Failed to read plan file: ${planPath}`,
        cause: err
      });
    }
  }

  const plan = validatePlan(JSON.parse(planContent));
  const profile = await store.loadProfile(snapshot.account);

  validatePlanSemantics(plan, snapshot);
  validatePlanPolicy({ plan, snapshot, profile });

  const review = createReview({ plan, snapshot });

  let writtenPath: string | undefined;
  if (outPath) {
    writtenPath = path.resolve(outPath);
    await fsp.mkdir(path.dirname(writtenPath), { recursive: true });
    await fsp.writeFile(writtenPath, JSON.stringify(review, null, 2), 'utf8');
  }

  return {
    reviewId: review.reviewId,
    createdAt: review.createdAt,
    digest: review.digest,
    totalOperations: review.operations.length,
    summary: review.summary,
    outPath: writtenPath,
    review: outPath ? undefined : review
  };
}
