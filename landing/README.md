# Career Ops landing

Standalone static sales landing for the managed Career Ops service.

The customer-facing interface is Telegram. The page intentionally sells outcomes and workflow rather than exposing internal discovery mechanics.

## Telegram CTA

Before production deployment, set the bot URL on the root html element in index.html:

    <html lang="ru" data-telegram-url="https://t.me/YOUR_BOT_USERNAME">

Until a valid https://t.me/... URL is configured, CTA clicks show a visible configuration notice instead of sending traffic to an invented Telegram account.

## Validation

Run:

    node landing/scripts/check-site.mjs

The check covers the Telegram-first product boundary, pricing copy, CTA safety, responsive/reduced-motion support, disclosure language, and guards against accidental fake social-proof metrics.
