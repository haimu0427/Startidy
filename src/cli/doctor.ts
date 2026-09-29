import { spawnSync } from 'node:child_process';
import type { GitHubPort } from '../core/ports.js';
import { DomainError } from '../core/errors.js';

export interface DoctorResult {
  cliVersion: string;
  nodeVersion: string;
  nodeSupported: boolean;
  ghInstalled: boolean;
  ghVersion?: string;
  authOk: boolean;
  viewer?: {
    hostname: string;
    viewerId: string;
    login: string;
  };
  checksPassed: boolean;
}

export async function runDoctor(github: GitHubPort): Promise<DoctorResult> {
  const cliVersion = '2.0.0';
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.replace(/^v/, '').split('.')[0], 10);
  const nodeSupported = major >= 22;

  let ghInstalled = false;
  let ghVersion: string | undefined;

  try {
    const ghCheck = spawnSync('gh', ['--version'], { encoding: 'utf8' });
    if (ghCheck.status === 0) {
      ghInstalled = true;
      ghVersion = ghCheck.stdout.split('\n')[0].trim();
    }
  } catch {
    ghInstalled = false;
  }

  let authOk = false;
  let viewer: { hostname: string; viewerId: string; login: string } | undefined;

  if (ghInstalled) {
    try {
      viewer = await github.getViewer();
      authOk = true;
    } catch {
      authOk = false;
    }
  }

  const checksPassed = nodeSupported && ghInstalled && authOk;

  if (!checksPassed) {
    let msg = 'Doctor diagnosis failed:';
    if (!nodeSupported) msg += ` Node.js ${nodeVersion} is not supported (requires >= 22.0.0).`;
    if (!ghInstalled) msg += ' GitHub CLI (gh) is not installed or not found in PATH.';
    if (!authOk) msg += ' GitHub authentication failed via gh.';

    throw new DomainError({
      code: !ghInstalled ? 'DEPENDENCY_MISSING' : !authOk ? 'AUTH_FAILED' : 'POLICY_VIOLATION',
      message: msg,
      details: { cliVersion, nodeVersion, nodeSupported, ghInstalled, ghVersion, authOk, viewer }
    });
  }

  return {
    cliVersion,
    nodeVersion,
    nodeSupported,
    ghInstalled,
    ghVersion,
    authOk,
    viewer,
    checksPassed
  };
}
