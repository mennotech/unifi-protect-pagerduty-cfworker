# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2026-06-18

### Added

- `X-Worker-Error` response header echoing the error message for easier
  troubleshooting in proxy/edge logs.
- Distinct authentication errors: a missing `Worker-Key` header now returns
  `Missing Worker-Key header` (401), and an unconfigured `WORKER_KEY` secret
  returns `Server misconfigured: WORKER_KEY secret is not set` (500), separate
  from the `Unauthorized` (401) mismatch response.

### Fixed

- Trim the `Worker-Key` header and `WORKER_KEY` secret before comparison so a
  stray newline or whitespace (e.g. from piping a file into
  `wrangler secret put`) no longer causes a spurious 401.

## [1.0.0] - 2026-06-18

### Added

- Cloudflare Worker that receives UniFi Protect webhook events and forwards them
  to PagerDuty as Events API v2 alerts.
- `Worker-Key` header authentication against the `WORKER_KEY` secret.
- `PagerDuty-Routing-Key` header to supply the PagerDuty integration key per request.
- `PagerDuty-Severity` header support with validation (`critical`, `error`,
  `warning`, `info`), defaulting to `critical`.
- `TEST` alarm handling that creates a fresh, non-deduplicated `info` event.
- Production alarm deduplication by `alarm_id` + `device`.
- Timestamp normalization for epoch-millisecond and ISO inputs.
- Vitest test suite covering authentication, routing, severity, and payload handling.
- Documentation on safely handling the `WORKER_KEY` secret on Cloudflare.

### Security

- Constant-time comparison of the `Worker-Key` header to prevent timing attacks.

### Fixed

- Hardened timestamp parsing to avoid a crash on out-of-range values.
- Graceful `502` response when the PagerDuty request fails instead of an
  unhandled exception.

[Unreleased]: https://github.com/mennotech/unifi-protect-pagerduty-cfworker/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/mennotech/unifi-protect-pagerduty-cfworker/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/mennotech/unifi-protect-pagerduty-cfworker/releases/tag/v1.0.0
