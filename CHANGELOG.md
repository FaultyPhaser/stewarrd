# Changelog

All notable changes to Stewarrd are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/). While the version is below `1.0.0`, any release may contain breaking changes, including database migrations.

## [Unreleased]

## [0.1.0-alpha.1] - 2026-10-31

First public alpha.

### Added

- Credit economy for Seerr (Overseerr/Jellyseerr) requests, enforced through the Seerr webhook (`MEDIA_PENDING` and `MEDIA_AUTO_APPROVED`).
- Per-item ownership, with TV tracked per season. Release ("done watching"), claim/adopt and admin buyout.
- Minimum stewardship time (`MIN_STEWARDSHIP_DAYS`) before an owner can release an item.
- Configurable prices and per-user credit allowance overrides in the admin dashboard.
- Month-end "Leaving soon" report with admin-confirmed purge through Radarr/Sonarr. Media is never deleted automatically.
- Weekly integrity check with a dry run and a report. Radarr/Sonarr are the source of truth for what exists.
- Plex PIN sign-in, limited to existing Seerr users.
- Kometa text-file endpoints for a "Leaving soon" collection.
- Optional UI injected into Seerr through a reverse proxy (balance bar, drawer, claim/release buttons, request cost modal).
- Docker image running as a non-root user with a read-only root filesystem.

### Known issues

- The integrity check, release and purge flows (including media deletion) have been tested by hand on one real Seerr/Radarr/Sonarr server only, not formally or on other setups. **Back up `stewarrd.db` and use the dry run first.**
- Stewarrd writes to Seerr: the webhook always approves or declines requests, and the opt-in `SEERR_SYNC=1` deletes filled requests and requests of purged titles, and creates requests on claim. **Back up Seerr's database before enabling `SEERR_SYNC`.**
- Declining an auto-approved request has not been confirmed on Seerr 3.5.
- See [docs/development-notes.md](docs/development-notes.md) for the full list.

[Unreleased]: https://github.com/FaultyPhaser/stewarrd/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/FaultyPhaser/stewarrd/releases/tag/v0.1.0-alpha.1
