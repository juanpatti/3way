import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('public repository boundary', () => {
  it('keeps private working material out of a clean clone', () => {
    const repository = mkdtempSync(join(tmpdir(), '3way-public-boundary-'));
    try {
      writeFileSync(join(repository, '.gitignore'), readFileSync('.gitignore'));
      execFileSync('git', ['init', '--quiet'], { cwd: repository });

      expect(() => execFileSync(
        'git', ['check-ignore', '--quiet', '--no-index', 'internal/private.md'],
        { cwd: repository },
      )).not.toThrow();

      // The root CLAUDE.md is Claude Code's own working instructions, kept at the
      // root so the tool auto-loads it — but it is private and must never ship in a
      // clean clone. Ignored alongside internal/.
      expect(() => execFileSync(
        'git', ['check-ignore', '--quiet', '--no-index', 'CLAUDE.md'],
        { cwd: repository },
      )).not.toThrow();
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
