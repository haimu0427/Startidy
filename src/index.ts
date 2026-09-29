#!/usr/bin/env node
import { Command } from 'commander';
import { GitHubGhAdapter } from './adapters/github-gh.js';
import { FileStoreAdapter } from './adapters/file-store.js';
import { runDoctor } from './cli/doctor.js';
import { runSnapshot } from './cli/snapshot.js';
import { runDetails } from './cli/details.js';
import { runPreview } from './cli/preview.js';
import { runApply } from './cli/apply.js';
import { runResolve } from './cli/resolve.js';
import { runStatus } from './cli/status.js';
import { printSuccess, printError } from './cli/output.js';
import { DomainError } from './core/errors.js';

const program = new Command();

program
  .name('startidy')
  .description('Contract-driven GitHub Stars organizer for agents and developers')
  .version('2.0.0')
  .option('--state-dir <dir>', 'Custom state directory path');

function getContext(cmdOpts: { stateDir?: string }) {
  const globalOpts = program.opts();
  const stateDir = cmdOpts.stateDir || globalOpts.stateDir;
  const store = new FileStoreAdapter({ stateDir });
  const github = new GitHubGhAdapter();
  return { store, github };
}

// 1. doctor
program
  .command('doctor')
  .description('Diagnose environment, dependencies, and GitHub authentication')
  .option('--json', 'Output machine-readable JSON envelope')
  .action(async (opts) => {
    const { github } = getContext(opts);
    try {
      const data = await runDoctor(github);
      printSuccess('doctor', data, {
        json: opts.json,
        summary: `Doctor checks passed: Node ${data.nodeVersion}, gh CLI ${data.ghVersion ?? 'ok'}, Viewer: ${data.viewer?.login}`
      });
      process.exit(0);
    } catch (err) {
      const code = printError('doctor', err, { json: opts.json });
      process.exit(code);
    }
  });

// 2. snapshot
program
  .command('snapshot')
  .description('Capture complete GitHub stars, lists, and candidates state')
  .option('--out <file>', 'Save snapshot to file')
  .option('--json', 'Output machine-readable JSON envelope')
  .action(async (opts) => {
    const { github, store } = getContext(opts);
    try {
      const data = await runSnapshot({ github, store, outPath: opts.out });
      printSuccess('snapshot', data, {
        json: opts.json,
        summary: `Captured snapshot ${data.snapshotId} for ${data.account.login}: ${data.totalStars} stars, ${data.totalLists} lists, ${data.candidatesCount} candidates`
      });
      process.exit(0);
    } catch (err) {
      const code = printError('snapshot', err, { json: opts.json });
      process.exit(code);
    }
  });

// 3. details
program
  .command('details')
  .description('Fetch repo READMEs for candidate or targeted repositories')
  .requiredOption('--snapshot <file>', 'Snapshot file path')
  .option('--candidates', 'Target candidate repositories from snapshot')
  .option('--repo-id <ids...>', 'Target specific repository IDs')
  .option('--offset <number>', 'Candidate pagination offset', (v) => parseInt(v, 10), 0)
  .option('--limit <number>', 'Candidate pagination limit', (v) => parseInt(v, 10), 20)
  .option('--refresh', 'Bypass README cache and fetch fresh from GitHub', false)
  .option('--out <file>', 'Save details to file')
  .option('--json', 'Output machine-readable JSON envelope')
  .action(async (opts) => {
    const { github, store } = getContext(opts);
    try {
      const data = await runDetails({
        github,
        store,
        snapshotPath: opts.snapshot,
        candidates: opts.candidates,
        repoIds: opts.repoId,
        offset: opts.offset,
        limit: opts.limit,
        refresh: opts.refresh,
        outPath: opts.out
      });
      printSuccess('details', data, {
        json: opts.json,
        summary: `Fetched details for ${data.count} repositories (offset: ${data.offset}, hasMore: ${data.hasMore})`
      });
      process.exit(0);
    } catch (err) {
      const code = printError('details', err, { json: opts.json });
      process.exit(code);
    }
  });

// 4. preview
program
  .command('preview')
  .description('Validate plan and generate review preview with digest')
  .requiredOption('--snapshot <file>', 'Snapshot file path')
  .requiredOption('--plan <file>', 'Plan file path (or - for stdin)')
  .option('--out <file>', 'Save review to file')
  .option('--json', 'Output machine-readable JSON envelope')
  .action(async (opts) => {
    const { store } = getContext(opts);
    try {
      const data = await runPreview({
        store,
        snapshotPath: opts.snapshot,
        planPath: opts.plan,
        outPath: opts.out
      });
      printSuccess('preview', data, {
        json: opts.json,
        summary: `Generated preview review ${data.reviewId} (digest: ${data.digest.slice(0, 12)}...): ${data.summary.creates} creates, ${data.summary.membershipChanges} memberships, ${data.summary.updates} updates, ${data.summary.deletes} deletes`
      });
      process.exit(0);
    } catch (err) {
      const code = printError('preview', err, { json: opts.json });
      process.exit(code);
    }
  });

// 5. apply
program
  .command('apply')
  .description('Execute planned review or resume an interrupted run')
  .option('--review <file>', 'Review file path')
  .option('--resume <runId>', 'Resume previously interrupted run ID')
  .option('--json', 'Output machine-readable JSON envelope')
  .action(async (opts) => {
    const { github, store } = getContext(opts);
    try {
      const data = await runApply({
        github,
        store,
        reviewPath: opts.review,
        resumeRunId: opts.resume
      });
      printSuccess('apply', data, {
        json: opts.json,
        summary: `Run ${data.runId} status: ${data.status} (applied ${data.appliedOperations.length} operations)`
      });
      process.exit(0);
    } catch (err) {
      const runId =
        err instanceof DomainError && typeof err.details?.runId === 'string'
          ? err.details.runId
          : opts.resume;
      const code = printError('apply', err, { json: opts.json, runId });
      process.exit(code);
    }
  });

// 6. resolve
program
  .command('resolve')
  .description('Record an explicit resolution for a needs_review operation')
  .requiredOption('--run <runId>', 'Run ID awaiting manual resolution')
  .requiredOption('--action <action>', 'One of: adopt, retry, accept-current, abort')
  .option('--list-id <id>', 'Existing List ID to adopt (required for adopt)')
  .option('--json', 'Output machine-readable JSON envelope')
  .action(async (opts) => {
    const { github, store } = getContext(opts);
    try {
      const data = await runResolve({
        github,
        store,
        runId: opts.run,
        action: opts.action,
        listId: opts.listId
      });
      printSuccess('resolve', data, {
        json: opts.json,
        summary: data.resumeRequired
          ? `Recorded ${data.action} for ${data.opId}; run startidy apply --resume ${data.runId} to continue`
          : `Run ${data.runId} cancelled; verified changes were preserved`
      });
      process.exit(0);
    } catch (err) {
      const code = printError('resolve', err, { json: opts.json, runId: opts.run });
      process.exit(code);
    }
  });

// 7. status
program
  .command('status')
  .description('Check execution status and history of a run')
  .requiredOption('--run <runId>', 'Run ID to inspect')
  .option('--json', 'Output machine-readable JSON envelope')
  .action(async (opts) => {
    const { github, store } = getContext(opts);
    try {
      const data = await runStatus({
        github,
        store,
        runId: opts.run
      });
      printSuccess('status', data, {
        json: opts.json,
        summary: `Run ${data.runId}: status=${data.status}, resumable=${data.resumable}, events=${data.totalEvents}`
      });
      process.exit(0);
    } catch (err) {
      const code = printError('status', err, { json: opts.json });
      process.exit(code);
    }
  });

program.parse(process.argv);

if (!process.argv.slice(2).length) {
  program.outputHelp();
}
