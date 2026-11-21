# CAPTCHA handling for the autonomous Career Ops extension

[Autopilot guide](./AUTOPILOT.md) · [regional sources](./REGIONAL_SOURCES.md) · [agent contract](../modes/autopilot.md)

The fork contains `captcha-solver.mjs` with a bounded, **best-effort** text-image recognition workflow. The code does **not** guarantee universal CAPTCHA solving, authorize bypasses of site protections, or prove that a job application was submitted.

## Supported and unsupported challenges

| Challenge | Current behavior | Limit |
| --- | --- | --- |
| Text/digit image CAPTCHA | Detect, capture, OCR, fill and inspect page response | Only where the site permits and the form exposes an ordinary text field |
| Cyrillic text CAPTCHA | Normalize a recognized Cyrillic answer | Recognition quality varies |
| reCAPTCHA, hCaptcha, Turnstile | Detect and mark a job-specific blocker | No general interactive anti-bot bypass |
| SmartCaptcha / behavioral or device checks | Report unresolved obstacle | No implemented universal solver |
| Email one-time code / magic link | Optional scoped Gmail OAuth helper | Valid sender and recent message required |
| SMS, MFA, KYC, nonroutine consent | Stop or defer the particular job | No circumvention |

## Recognition pipeline

The application worker uses the **same named Playwright CLI session** as the form, detects the challenge, captures the image and sends it to an available authorized vision service. OpenCode is the first configured option; an OpenAI-compatible vision endpoint can be used when explicitly configured. The worker validates the answer text, fills the ordinary field and observes normal page feedback. The default requested attempts are five, and the solver enforces an upper bound of eight. Do not retry indefinitely or start new browser sessions to evade a challenge.

If the challenge is unresolved, report `captcha` for that job and continue the eligible queue. Never guess MFA tokens, tamper with validation tokens, or mark a CAPTCHA click as a verified application.

## Configuration (examples)

```bash
# Configure an existing vision-capable OpenCode model.
opencode --version
export CAPTCHA_OPENCODE_MODEL="provider/vision-model"
export CAPTCHA_OPENCODE_COMMAND="opencode"

# Optionally configure a compatible vision API with authorized credentials.
export CAPTCHA_VISION_MODEL="your-verified-vision-model"

# Attempt budget for a separately authorized application session.
export AUTOPILOT_CAPTCHA_ATTEMPTS=5
```

Do not commit API keys or OAuth files. Screenshots may include application PII and should remain within the selected profile's local `data/autopilot/captcha/`.

## Diagnostics without sending an application

```bash
node captcha-solver.mjs detect --session career-ops-worker-0 --json
node captcha-solver.mjs ocr ./test-image.png --json
```

The `detect` command identifies challenge type; `ocr` attempts image recognition. `solve` interacts with an existing authorized form and must not be run as a workaround for site security rules. Even when a challenge is accepted, `autopilot-verify.mjs` evidence is still mandatory after Submit.

**Important:** This module was transferred in code review; no real-site CAPTCHA was solved or measured in the current rebuild.
