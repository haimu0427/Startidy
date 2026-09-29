import { DomainError, ExitCode, errorCodeToExitCode, type ErrorCode } from '../core/errors.js';

export interface JsonSuccessEnvelope<T = unknown> {
  schemaVersion: '1.0';
  command: string;
  ok: true;
  data: T;
}

export interface JsonErrorEnvelope {
  schemaVersion: '1.0';
  command: string;
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
    retryable: boolean;
  };
  runId?: string;
}

export function printSuccess<T>(command: string, data: T, options?: { json?: boolean; summary?: string }): void {
  if (options?.json) {
    const envelope: JsonSuccessEnvelope<T> = {
      schemaVersion: '1.0',
      command,
      ok: true,
      data
    };
    process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
  } else {
    if (options?.summary) {
      process.stdout.write(options.summary + '\n');
    } else {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    }
  }
}

export function printError(
  command: string,
  error: unknown,
  options?: { json?: boolean; runId?: string }
): number {
  let domainErr: DomainError;

  if (error instanceof DomainError) {
    domainErr = error;
  } else if (error instanceof Error) {
    domainErr = new DomainError({
      code: 'INTERNAL_ERROR',
      message: error.message,
      cause: error
    });
  } else {
    domainErr = new DomainError({
      code: 'INTERNAL_ERROR',
      message: String(error)
    });
  }

  if (options?.json) {
    const envelope: JsonErrorEnvelope = {
      schemaVersion: '1.0',
      command,
      ok: false,
      error: {
        code: domainErr.code,
        message: domainErr.message,
        details: domainErr.details,
        retryable: domainErr.retryable
      },
      runId: options.runId
    };
    process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
  } else {
    process.stderr.write(`Error [${domainErr.code}]: ${domainErr.message}\n`);
    if (domainErr.details) {
      process.stderr.write(JSON.stringify(domainErr.details, null, 2) + '\n');
    }
  }

  return domainErr.exitCode;
}
