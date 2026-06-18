# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/mennotech/unifi-protect-pagerduty-cfworker/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/mennotech/unifi-protect-pagerduty-cfworker/releases/tag/v1.0.0
