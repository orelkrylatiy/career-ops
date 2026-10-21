// tests/humanizer-lib.test.mjs — lib/humanizer.mjs bridge plumbing
//
// Locks in the Node<->Python bridge contract without requiring the real
// humanizer_framework install:
//   1. No python launcher on PATH -> every helper resolves to null (soft-fail),
//      never throws.
//   2. HUMANIZER_BRIDGE override is honored — a fake bridge script stands in
//      for humanizer-bridge.py and the parsed JSON reaches the caller.
//   3. humanizerValidate pipes the draft through stdin (long drafts cannot
//      ride on argv).
//   4. Non-JSON bridge output degrades to null, not a crash.
//
// The fake bridges are throwaway python scripts in a temp dir; if the machine
// has no python at all, only cases 1 and 4 run (they need no interpreter) and
// the rest are skipped with a pass + note.

import { pass, fail, rmSync } from './helpers.mjs';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

console.log('\nlib/humanizer.mjs — humanizer-framework bridge plumbing');

process.env.HUMANIZER_NO_CACHE = '1';
process.env.HUMANIZER_QUIET = '1';

const tmp = mkdtempSync(join(tmpdir(), 'career-ops-humanizer-'));

const FAKE_BRIDGE = join(tmp, 'fake_bridge.py');
writeFileSync(
  FAKE_BRIDGE,
  [
    'import json, sys',
    'cmd = sys.argv[1]',
    'if cmd == "write":',
    '    print(json.dumps({"ok": True, "text": "fake write text", "provider": "fake", "rewritten": False, "issues": []}))',
    'elif cmd == "validate":',
    '    data = sys.stdin.read()',
    '    print(json.dumps({"ok": True, "text": data.strip(), "hard": False, "issues": [{"code": "fake_ok", "hard": False}]}))',
    'else:',
    '    print(json.dumps({"ok": True, "legs": [], "zai_key": "fake"}))',
    '',
  ].join('\n')
);

const GARBAGE_BRIDGE = join(tmp, 'garbage_bridge.py');
writeFileSync(GARBAGE_BRIDGE, 'print("this is not json")\n');

const CANDIDATES = (process.env.HUMANIZER_PY || 'py,python3,python').split(',');
function findPython(candidates) {
  for (const py of candidates) {
    try {
      execFileSync(py.trim(), ['-c', 'print(1)'], { stdio: 'ignore' });
      return py.trim();
    } catch {
      // try the next launcher
    }
  }
  return null;
}

try {
  // 1. No python launcher -> soft-fail nulls, no throw
  process.env.HUMANIZER_PY = 'no-such-python-launcher-xyz';
  const modNoPython = await import('../lib/humanizer.mjs?case=no-python');
  const [writeNull, validateNull, availableNull] = await Promise.all([
    modNoPython.humanizerWrite({ goal: 'test goal' }),
    modNoPython.humanizerValidate('draft'),
    modNoPython.humanizerAvailable({ refresh: true }),
  ]);
  if (writeNull === null && validateNull === null && availableNull === false) {
    pass('missing python launcher resolves every helper to null (soft-fail)');
  } else {
    fail(`soft-fail contract broken: ${JSON.stringify({ writeNull, validateNull, availableNull })}`);
  }

  const python = findPython(CANDIDATES);
  if (!python) {
    pass('skipped fake-bridge cases: no python interpreter on this machine');
  } else {
    // 2. HUMANIZER_BRIDGE override + JSON plumbing (write)
    process.env.HUMANIZER_PY = python;
    process.env.HUMANIZER_BRIDGE = FAKE_BRIDGE;
    const modFake = await import('../lib/humanizer.mjs?case=fake-bridge');
    const writeResult = await modFake.humanizerWrite({ goal: 'cover letter for ACME' });
    const expected = {
      ok: true,
      text: 'fake write text',
      provider: 'fake',
      rewritten: false,
      issues: [],
    };
    if (JSON.stringify(writeResult) === JSON.stringify(expected)) {
      pass('humanizerWrite parses the bridge JSON reply end to end');
    } else {
      fail(`humanizerWrite unexpected result: ${JSON.stringify(writeResult)}`);
    }

    // 3. validate pipes the draft via stdin
    const validateResult = await modFake.humanizerValidate('  draft letter body  ');
    if (
      validateResult?.ok === true &&
      validateResult.text === 'draft letter body' &&
      validateResult.issues?.[0]?.code === 'fake_ok'
    ) {
      pass('humanizerValidate pipes the draft through stdin and returns normalized text');
    } else {
      fail(`humanizerValidate unexpected result: ${JSON.stringify(validateResult)}`);
    }

    // 3b. empty draft never spawns the bridge
    const emptyResult = await modFake.humanizerValidate('   ');
    if (emptyResult === null) {
      pass('humanizerValidate rejects an empty draft without calling the bridge');
    } else {
      fail(`humanizerValidate should skip empty drafts: ${JSON.stringify(emptyResult)}`);
    }

    // 4. non-JSON bridge output degrades to null
    process.env.HUMANIZER_BRIDGE = GARBAGE_BRIDGE;
    const modGarbage = await import('../lib/humanizer.mjs?case=garbage-bridge');
    const garbageResult = await modGarbage.humanizerWrite({ goal: 'x' });
    if (garbageResult === null) {
      pass('non-JSON bridge output degrades to null');
    } else {
      fail(`non-JSON output should resolve to null: ${JSON.stringify(garbageResult)}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
