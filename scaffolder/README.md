# career-ops autonomous fork — local scaffolder

This directory contains the scaffolder code carried by the autonomous fork at
[orelkrylatiy/career-ops](https://github.com/orelkrylatiy/career-ops).

The public npm package `@santifer/career-ops` is published by the upstream
project. Running it does **not** guarantee that you receive this autonomous
fork.

For the fork, the supported install path is:

```bash
git clone https://github.com/orelkrylatiy/career-ops.git
cd career-ops
npm install
npx playwright install chromium
```

For local development/testing of this scaffolder itself, run it from this
checkout:

```bash
node scaffolder/bin/cli.mjs init ../career-ops-test
```

That local scaffolder is configured to clone
`https://github.com/orelkrylatiy/career-ops.git`.

## Requirements

- Node.js 20+ for the autonomous worker
- git
- Chromium installed by Playwright for browser application/PDF workflows

## License

MIT. Upstream authorship/license notices remain in the repository.
