import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const py = ['python3', 'python'].find(cmd => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0);

test('Humanizer resolves voice-dna.md from the active candidate direction', { skip: !py }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'career-ops-voice-'));
  try {
    const voice = path.join(dir, 'voice-dna.md');
    writeFileSync(voice, '# Profile-specific voice settings\n', 'utf8');
    const script = 'import runpy; import sys; print(runpy.run_path(sys.argv[1])["_default_voice_path"]())';
    const out = spawnSync(py, ['-c', script, path.join(root, 'humanizer-bridge.py')], {
      env: { ...process.env, CAREER_OPS_ROOT: dir },
      encoding: 'utf8', timeout: 15_000, shell: false,
    });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(path.normalize(out.stdout.trim()), path.normalize(voice));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
