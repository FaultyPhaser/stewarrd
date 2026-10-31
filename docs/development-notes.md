# Development notes

Internal notes: current state, known limitations, deployment lessons and suggested next steps. For user-facing release history see [CHANGELOG.md](../CHANGELOG.md).

## Current state

Stewarrd tracks per-user request credits for the Seerr/arr stack. It runs as a sidecar container next to Seerr, and Seerr's webhook is the enforcement point.

### Features

- **Credits and allowances**
  - Global default via `DEFAULT_CREDITS`.
  - Per-user allowance overrides (migration v5, `users.credit_allowance`). `NULL` means follow the default.
  - Changing an override adjusts the user's balance immediately and writes an `ALLOWANCE_CHANGED` row to the integrity log.
  - Admin UI: "Credit allowance per user" in the dashboard's Admin mode.
- **Request enforcement (webhook)**
  - On `MEDIA_PENDING` the service charges the requester, or declines the request in Seerr if they can't afford it.
  - Every approval, decline and refund is recorded in `request_events` (migration v6).
- **Live info inside Seerr (injection)**
  - `public/inject.js` is injected by the reverse proxy and shows the credit balance on a side bar, a cost note and decline notice on title pages, and Done Watching / Save buttons.
  - Request buttons stay clickable. When the user can't afford the request, a modal appears instead of submitting. This applies on detail pages and on index/discover teaser cards.
  - The injected script authenticates with the user's Seerr session cookie (`connect.sid`) for user endpoints only. `/api/admin` still requires the Plex login.
- **API additions**
  - `GET /api/user/credits` returns `credits`, `allowance` and `costs: { movie, tv }`.
  - `GET /api/user/activity` returns recent request outcomes.
  - `GET /api/media/status` now includes `request: { unitCost, balance, canAfford }`.
- **Caching:** `.js` and `.css` files under `/public` are served with `no-cache`.
- **Frontend:** the dashboard and the injected UI are now Preact + TypeScript in `web/`, built by Vite into `public/` (generated, git-ignored). `dev-panel.js` is now the `DevPanel` component. See the README, "Frontend development".

- **Integrity check, release and purge rework** (tested by hand on the author's real Seerr/Radarr/Sonarr server, including purge; no formal or multi-setup testing yet)
  - The `PURGED` status is gone (migration v7). Releasing an item, downloaded or not, flags it for the leaving-soon list. An admin purge deletes the row after Radarr/Sonarr delete the files.
  - Releasing never touches Seerr. A purge deletes the show's open Seerr requests; seasons on them that are still unfilled are re-requested for the same user.
  - `POST /api/admin/integrity/run` now reconciles with Radarr/Sonarr, then with open Seerr requests, then deletes filled Seerr requests. `{"dryRun": true}` writes nothing; `{"force": true}` lifts the removal cap.
  - "Import missing items" and "Sync direct additions" (and `POST /api/admin/sync`) are removed. Only the integrity check and "Reset & re-import" remain.
  - `GET /api/admin/purge/:unitId/preview` is a dry run of the Seerr side of a purge.
  - Requires `SEERR_SYNC=1` for any Seerr deletion or re-request.
- **Own unit identity (migration v8)** (verified on a real dry run and real run: 79 missing items were added)
  - `media_flags` is rebuilt: `unit_id` stays the key, and the new `ref_key` is the identity (`movie:<tmdb>`, `tv:<tvdb>`, or `tv:t<tmdb>` for a show with no TVDB id) plus the season. `seerr_id`, `tmdb_id` and `tvdb_id` are optional. `unit_id` values are kept, so ledger links survive. The ledger keeps its old `media_id` column as history.
  - The migration stops with a message naming the units if two would share one identity, and changes nothing.
  - Radarr (TMDB) and Sonarr (TVDB) alone decide what exists, so items Seerr doesn't know are added too. A show split across several Seerr records is handled as one show.
  - The reconcile fills in a unit's missing TVDB/TMDB id from the Sonarr series it matches (`IDS_BACKFILLED`), and reports entries that have no usable id (`NO_USABLE_ID`).
  - The show routes and the web UI group seasons by `groupKey` (the `ref_key`) instead of Seerr's `mediaId`. `POST /api/admin/purge-show/:groupKey` takes it.

- **Minimum stewardship time (migration v9)**
  - Replaces the Tautulli last-stream cooldown, which is removed (`COOLDOWN_DAYS` and `TAUTULLI_*` are gone; Tautulli is no longer used).
  - An owner can release an item only after holding it for N days (`MIN_STEWARDSHIP_DAYS`, default 30; admin dashboard setting "Minimum stewardship time", 0 = off). `media_flags.held_since` is set on request and on claim. Existing items have no hold.
  - Setting "Apply to claimed (saved) items" (on by default) decides whether a claim starts the hold.
  - Admin is exempt, an admin assignment clears the hold, and acting as a user applies that user's rules.
  - Deleting an item (admin purge or integrity removal) refunds an active owner what they paid (`DELETE_REFUND`), regardless of the hold.
  - New endpoints: `GET` and `POST /api/admin/settings`. Dev mode: `POST /api/dev/backdate` replaces `/stream`.

### Verified

- The automated suite passes (50 backend tests, 31 web tests), and the typecheck and web build succeed.
- The Seerr status codes used by the import, reconcile and Seerr cleanup code match Seerr's `develop` branch (`server/constants/media.ts`):
  - Request status: 1 pending, 2 approved, 3 declined, 4 failed, 5 completed.
  - Media and season status: 1 unknown, 2 pending, 3 processing, 4 partially available, 5 available, 6 blocklisted, 7 deleted.
  - This was checked against `develop`, not against the Seerr version you run.
- The Unraid deployment is running: the migrations ran, the nginx injection works, and a declined request shows as Declined in Seerr.

### Not verified in a browser

- The newest change, the teaser-card interception.
- Side bar and panel placement on Seerr 3.5 pages.
- Request-button detection on Seerr 3.5 pages.

## Known limitations

1. **Season cost check is approximate (TV).**
   - The client-side check uses the per-season cost, because a teaser card can't know how many seasons will be selected.
   - A multi-season request can pass the check with, for example, 2 credits when it needs 4.
   - The webhook declines it server-side, so nothing is overcharged, but the user sees the decline instead of the modal.
2. **Client-side checks are a convenience, not enforcement.** If the cached balance is stale or the card can't be identified, the click goes through. The webhook is the real gate.
3. **Card detection is heuristic.** Type is read from the nearest parent containing exactly one `/movie/` or `/tv/` link. A different card layout in a Seerr update falls through to the webhook decline.
4. **No decline reason in Seerr.**
   - Seerr 3.5's API has no comment or reason field on requests (comments exist only on issues).
   - Users see a plain "Declined" in Seerr's UI and notifications. The reason appears only through the injected UI and the activity endpoint.
5. **Older declines have no notice.** Decline notices only exist for requests recorded after migration v6.
6. **Declining an auto-approved request is untested.** The webhook handles `MEDIA_AUTO_APPROVED` (charge and track, no second approve call). If the requester can't afford it, it tries to decline the already approved request. I haven't confirmed Seerr 3.5 allows that, and a refusal is only logged, so that request stays approved. The webhook must also be subscribed to "Request Automatically Approved" in Seerr.
7. **Decline can lag in the Seerr UI.** After a decline, Seerr's UI may show the old status for a short time until refreshed.
8. **Reset & re-import** wipes the `users` table, so allowance overrides are lost with it.
9. **Lowering an allowance below spent credits** leaves a negative balance (overdraw), as the import already does. Requests are declined until it recovers.

## Deployment notes (Unraid, Nginx Proxy Manager)

- Rebuild the image after every `git pull`: `docker build -t stewarrd:latest .`, then recreate the container. "Apply" alone reuses the old image.
- The Seerr proxy host's **Advanced** box needs all three blocks together: `/sidecar-api/`, `/sidecar-assets/`, and a `location /` that sets `Accept-Encoding ""` and the `sub_filter`. The `location /` block must repeat the Details-tab forward host and port.
- **Cache Assets must be OFF** on that proxy host. When it was on, it cached a `307 → /login` for `/sidecar-assets/inject.js` and broke injection.
- Test injection the way a browser does: `curl -s --compressed -H 'Accept-Encoding: gzip, br' https://<domain>/ | grep sidecar-assets`. A bare curl gave a false positive.
- Verify the sidecar address directly with `curl -i http://<ip>:3055/healthz`, which should return `{"ok":true}` with no `x-powered-by` header.
- Seerr and `/sidecar-api` must share one domain so the session cookie is sent.
- Seerr is a PWA. If injection seems missing after a proxy change, unregister the service worker and clear site data.

## Suggested next steps

1. **Verify declining an auto-approved request.** Test against Seerr 3.5 that an already approved request can be declined, and handle a refusal beyond logging it.
2. **Season-aware check.** Count selected seasons in Seerr's request dialog so the modal can use the full cost.
3. **Post-decline verification.** Read the request back after declining and record the final Seerr status, so a decline that didn't stick is visible.
4. **Surface activity in the dashboard.** Add a user-facing request history and a credit-history view backed by `request_events` and the ledger.
5. **Optional notifications.** Push the decline reason through Discord/ntfy etc., since Seerr's native notification carries none.
6. **Selector hardening.** If side bar or button placement is off on Seerr 3.5, tune the selectors in `inject.js`.
7. **Versioned asset URLs.** Append a version query to the `inject.js` script tag, to protect against proxy and browser caching.

