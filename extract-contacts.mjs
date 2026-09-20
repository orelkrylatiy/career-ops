#!/usr/bin/env node
// Legacy compatibility tombstone.
//
// Contact harvesting is outside the autonomous web-application core. This file
// remains temporarily system-managed so old installs overwrite the previous
// implementation instead of silently retaining it.

console.error(
  'extract-contacts.mjs has been retired from the autonomous web-applier core.',
);
process.exitCode = 2;
