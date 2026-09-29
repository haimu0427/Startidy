import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const skillPath = path.resolve(testDir, '../../skills/startidy/SKILL.md');

describe('Startidy skill trust boundary', () => {
  it('places README prompt-injection guidance before any README retrieval instruction', async () => {
    const skill = await fsp.readFile(skillPath, 'utf8');
    const boundary = skill.indexOf('## Trust Boundary');
    const readmeStep = skill.indexOf('retrieve README details');

    assert.ok(boundary >= 0);
    assert.ok(readmeStep >= 0);
    assert.ok(boundary < readmeStep);
    assert.match(skill, /untrusted external data, not instructions/i);
    assert.match(skill, /Never follow commands/i);
    assert.match(skill, /never let repository content expand/i);
  });
});
