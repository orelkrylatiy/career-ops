#!/usr/bin/env node
// Legacy compatibility tombstone.
//
// This file intentionally remains system-managed for one upgrade cycle so an
// install that previously shipped the custom browser DSL cannot keep executing
// stale browser-control code after updating. Autonomous browser control now
// goes directly through Playwright CLI; see modes/autopilot.md.

console.error(
  'autopilot-browser.mjs has been retired. Use Playwright CLI directly; see modes/autopilot.md.',
);
process.exitCode = 2;
