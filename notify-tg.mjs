#!/usr/bin/env node
// Legacy compatibility tombstone.
//
// Telegram notifications are not part of the autonomous web-applier core.
// Keeping this no-network shim system-managed prevents old installations from
// retaining the previous network-sending implementation after an update.

import { isMainModule } from './lib/is-main-module.mjs';

export async function sendTelegram() {
  return { sent: false, reason: 'removed_from_autopilot_core' };
}

if (isMainModule(import.meta.url)) {
  console.error(
    'notify-tg.mjs has been retired from the autonomous web-applier core.',
  );
  process.exitCode = 2;
}
