---
name: career-ops-plugin-gmail
description: How to pull job leads from a Gmail label into the career-ops pipeline.
license: MIT
---

# gmail plugin

Reads a Gmail label, extracts clean job URLs from authentic (DMARC-passing)
emails, and returns them as leads. It can also send an explicitly requested
plain-text message through the same OAuth account. Outbound mail is never
triggered by scanning.

## Command

- `node plugins.mjs run gmail` — ingest new leads from the configured label.
- `node gmail-flow.mjs send --to recruiter@example.com --subject "..." --body-file draft.md --key req-123`
  — send one explicit message. Add `--dry-run` to verify the account and
  payload without sending. The key is recorded locally after a successful send.

## Setup

Put `GMAIL_CLIENT_ID` + `GMAIL_CLIENT_SECRET` + `GMAIL_REFRESH_TOKEN` in `.env`
(an OAuth Desktop client + a refresh token from the consent flow). Configure the
label + lookback in `config/plugins.yml`:

```yaml
plugins:
  gmail: { enabled: true, label: "Job Leads", days_back: 7, sender_email: "you@example.com" }
```

## Data it produces

`Job[]` ({ title, url, company, location }) — the engine de-dups against the
pipeline and appends new ones. It maintains its own processed-message cursor in
`data/gmail-state.json` to avoid re-reading the same emails.

Outbound idempotency is stored in `data/gmail-sent.json` (ignored by git).
Initial OAuth consent, login, OTP/2FA and CAPTCHA remain human-in-the-loop;
the plugin uses an already authorized refresh token.
