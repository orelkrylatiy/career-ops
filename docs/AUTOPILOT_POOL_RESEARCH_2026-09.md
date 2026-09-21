# Autopilot Pool Research — 2026-09-21

This note records the discovery research behind the September 2026 autonomous
worker expansion. The goal was to increase the number of independently
discoverable vacancies without adding duplicate adapters or relying on brittle
browser search as the primary source.

## What the repository already had

The provider layer already includes structured/public adapters for:

- Greenhouse
- Lever
- Ashby
- Workday
- iCIMS
- BambooHR
- SmartRecruiters
- Workable
- Teamtailor
- Personio

SmartRecruiters, Workable, Teamtailor and Personio therefore did **not** need new
provider implementations. Their limiting factor is how many company career
surfaces are present in the user's catalog/registry, not whether Career Ops can
parse them.

Useful upstream/public interfaces confirmed during research:

- SmartRecruiters Posting API:
  https://developers.smartrecruiters.com/docs/posting-api
- Teamtailor public jobs RSS:
  https://help.teamtailor.com/en/articles/12214493-rss-feed-of-your-job-listings
- Personio public XML job feed:
  https://developer.personio.de/v2025.12/page/retrieving-open-job-positions-via-xml

The existing Career Ops providers remain the implementation authority; this
document is not a contract for those third-party interfaces.

## Reverse-scan gap

`scan-ats-full.mjs` previously walked only five company directories:

- Greenhouse
- Lever
- Ashby
- Workday
- iCIMS

It already consumes the maintained company-identifier datasets from
`Feashliaa/job-board-aggregator`:

https://github.com/Feashliaa/job-board-aggregator

That dataset also maintains `data/bamboohr_companies.json`. Career Ops already
had a hardened `providers/bamboohr.mjs`, so BambooHR was a low-risk pool
expansion: reuse a tested provider and add only the missing reverse-directory
routing.

## Implemented

BambooHR is now a first-class `scan-ats-full.mjs` source.

The reverse scanner:

1. downloads/caches the maintained BambooHR tenant list;
2. validates each tenant identifier with the same conservative slug charset;
3. constructs only `https://<tenant>.bamboohr.com/careers`;
4. lets the existing BambooHR provider call the public `/careers/list` surface;
5. uses a conservative concurrency of 10;
6. leaves the existing URL/dedup/blacklist/filter pipeline unchanged.

BambooHR's public list response does not provide a posting date. The normal
reverse scan therefore continues to require `--include-undated` to keep those
rows. Autopilot deep scan already uses that flag, so the autonomous worker gains
the new pool immediately.

## Paylocity: researched, not enabled in this change

The same upstream dataset also carries a Paylocity tenant file. Its maintained
scraper currently discovers jobs by reading a `window.pageData` JSON blob from
public recruiting HTML pages such as:

`https://recruiting.paylocity.com/recruiting/jobs/All/<guid>/`

That is useful evidence that broader coverage is possible, but Career Ops does
not yet have a hardened Paylocity provider. The surface is HTML/layout-dependent
rather than the already-tested BambooHR JSON path, and the dataset shape is also
different (GUID/name objects rather than a flat slug list).

For this release, Paylocity stays a follow-up candidate rather than being added
to the production autonomous sweep without equivalent SSRF guards, parser tests,
rate-limit behavior and liveness diagnostics.

## Licensing note

The external job-board-aggregator dataset currently declares CC BY-NC 4.0 for
its dataset. Career Ops was already consuming that source before this change.
Anyone deploying the reverse directory data in a commercial context should
review that upstream license rather than assuming the repository's MIT license
covers third-party datasets.

## Next pool improvements

The next discovery work should be measured from scan telemetry, not provider
count. High-value follow-ups are:

- add a hardened Paylocity provider + reverse directory only after fixture/live
  validation;
- grow the source registry with more verified SmartRecruiters, Workable,
  Teamtailor and Personio company surfaces, because their parsers already exist;
- report jobs discovered/kept per source so pool expansion is measured by new,
  deduplicated postings rather than raw company identifiers.
