import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ErrorObject } from 'ajv';
import type { Snapshot } from '../generated/snapshot.js';
import type { Plan } from '../generated/plan.js';
import type { Review } from '../generated/review.js';
import { DomainError } from './errors.js';
import snapshotSchema from '../schemas/snapshot.schema.json';
import planSchema from '../schemas/plan.schema.json';
import reviewSchema from '../schemas/review.schema.json';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

ajv.addSchema(snapshotSchema, 'snapshot.schema.json');
ajv.addSchema(planSchema, 'plan.schema.json');
ajv.addSchema(reviewSchema, 'review.schema.json');

const validateSnapshotSchema = ajv.getSchema<Snapshot>('snapshot.schema.json')!;
const validatePlanSchema = ajv.getSchema<Plan>('plan.schema.json')!;
const validateReviewSchema = ajv.getSchema<Review>('review.schema.json')!;

function formatAjvErrors(errors?: ErrorObject[] | null): string {
  if (!errors || errors.length === 0) return 'Unknown schema validation error';
  return errors
    .map((e) => `${e.instancePath || '/'}: ${e.message} (${JSON.stringify(e.params)})`)
    .join('; ');
}

export function validateSnapshot(data: unknown): Snapshot {
  const valid = validateSnapshotSchema(data);
  if (!valid) {
    throw new DomainError({
      code: 'PLAN_INVALID',
      message: `Snapshot schema validation failed: ${formatAjvErrors(validateSnapshotSchema.errors)}`,
      details: { errors: validateSnapshotSchema.errors }
    });
  }
  return data as Snapshot;
}

export function validatePlan(data: unknown): Plan {
  const valid = validatePlanSchema(data);
  if (!valid) {
    throw new DomainError({
      code: 'PLAN_INVALID',
      message: `Plan schema validation failed: ${formatAjvErrors(validatePlanSchema.errors)}`,
      details: { errors: validatePlanSchema.errors }
    });
  }
  return data as Plan;
}

export function validateReview(data: unknown): Review {
  const valid = validateReviewSchema(data);
  if (!valid) {
    throw new DomainError({
      code: 'PLAN_INVALID',
      message: `Review schema validation failed: ${formatAjvErrors(validateReviewSchema.errors)}`,
      details: { errors: validateReviewSchema.errors }
    });
  }
  return data as Review;
}
