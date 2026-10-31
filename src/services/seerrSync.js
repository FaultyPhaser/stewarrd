import { db } from '../db.js';
import { config } from '../config.js';
import { isAdminId } from './credits.js';
import { createRequest, deleteRequest, getMediaInfo, listAllRequests } from './seerr.js';

/**
 * Keeps Seerr's request list in step with ownership. Our database stays the source of truth:
 * these calls run after the credit transaction and never throw, so a Seerr failure can't undo or
 * block a credit change. Failures are returned to the caller and written to the integrity log.
 *
 *   release -> nothing: an unclaimed item keeps its Seerr request
 *   purge   -> requests for the deleted item are removed; unfilled seasons on them are re-requested for the same user
 *   claim   -> a request is created in Seerr on behalf of the new owner
 */

const reason = (err) => err?.upstreamMessage || err?.message || String(err);

function logProblem(kind, unit, userId, detail) {
  try {
    db.prepare(
      `INSERT INTO integrity_log (run_id, kind, user_id, unit_id, detail) VALUES ('seerr-sync', ?, ?, ?, ?)`,
    ).run(kind, userId ?? null, unit?.unit_id ?? null, detail);
  } catch {
    /* logging must never break the caller */
  }
}

function skipReason(userId) {
  if (!config.seerrSync) return { action: 'disabled', message: '' };
  if (isAdminId(userId)) return { action: 'skipped', message: 'Admin-owned items have no Seerr request.' };
  if (config.seerrSyncUsers.size && !config.seerrSyncUsers.has(userId)) {
    return { action: 'skipped', message: `Seerr sync is limited to other users (SEERR_SYNC_USER_IDS), so user ${userId}'s Seerr requests were not changed.` };
  }
  return null;
}

const seasonsOf = (request) => (request.seasons ?? []).map((s) => s.seasonNumber);

const covers = (request, unit) =>
  unit.media_type === 'movie' || unit.season_number === null || seasonsOf(request).includes(unit.season_number);

/** The user's own (non-4K) Seerr requests that cover this unit. */
const requestsFor = (info, userId, unit) =>
  (info?.requests ?? []).filter((r) => !r.is4k && r.requestedBy?.id === userId && covers(r, unit));

const allowed = (userId) => !config.seerrSyncUsers.size || config.seerrSyncUsers.has(userId);

// Seerr's MediaRequestStatus: 3 = declined, 4 = failed, 5 = completed. Season/media status: 2-4 = still being filled.
const isOpen = (r) => r.status !== 3 && r.status !== 4;

/** True when a season on this request still needs filling (so it must keep a request). */
function unfilled(info, request, seasonNumber) {
  if (request.status === 5) return false;
  const status = (info?.seasons ?? []).find((s) => s.seasonNumber === seasonNumber)?.status;
  return status === undefined || status === 2 || status === 3 || status === 4;
}

/**
 * Works out what to do with Seerr's requests for units that are being deleted from the system.
 * Every open non-4K request that covers a deleted unit is removed. Seerr can't shrink an approved request,
 * so if the request also lists seasons that still need filling, it is recreated for the same requester with
 * only those seasons.
 */
async function planCleanup(units) {
  const first = units[0];
  const info = await getMediaInfo(first.media_type, first.tmdb_id);
  const gone = units.map((u) => u.season_number);
  const wholeMedia = first.media_type === 'movie' || gone.includes(null);
  const plan = [];
  for (const request of info?.requests ?? []) {
    if (request.is4k || !isOpen(request) || !allowed(request.requestedBy?.id)) continue;
    const seasons = seasonsOf(request);
    if (!wholeMedia && seasons.length && !seasons.some((s) => gone.includes(s))) continue;
    const keep = wholeMedia ? [] : seasons.filter((s) => !gone.includes(s) && unfilled(info, request, s));
    plan.push({ requestId: request.id, userId: request.requestedBy?.id, keep });
  }
  return { first, plan };
}

/**
 * Cleans up Seerr after units are deleted from the system (admin purge). Call AFTER the units are removed locally.
 * Releasing an item never touches Seerr. With { dryRun: true } nothing is written and the plan is returned.
 * Requests from users outside SEERR_SYNC_USER_IDS are left alone. Never throws.
 */
export async function removeRequestsInSeerr(units, { dryRun = false } = {}) {
  if (!config.seerrSync) return { action: 'disabled', message: '' };
  const first = units[0];
  if (!first?.tmdb_id) return { action: 'none', message: 'No TMDB id is stored, so Seerr requests could not be found.' };

  try {
    const { plan } = await planCleanup(units);
    if (!plan.length) return { action: 'none', message: 'No Seerr requests needed removing.' };
    if (dryRun) {
      return { action: 'dry_run', plan, message: `Would remove request(s) ${plan.map((p) => p.requestId).join(', ')}.` };
    }

    const removed = [];
    const recreated = [];
    const failed = [];
    for (const step of plan) {
      await deleteRequest(step.requestId);
      removed.push(step.requestId);
      if (!step.keep.length) continue;
      try {
        // Delete first: the unfilled seasons are still on the old request and Seerr would reject a duplicate.
        const body = { mediaType: 'tv', mediaId: first.tmdb_id, userId: step.userId, seasons: step.keep, ignoreQuota: true };
        if (first.tvdb_id) body.tvdbId = first.tvdb_id;
        const created = await createRequest(body);
        if (created?.id) recreated.push({ requestId: created.id, userId: step.userId, seasons: step.keep });
        else throw new Error(created?.message || 'no request was created');
      } catch (err) {
        failed.push({ userId: step.userId, seasons: step.keep });
        logProblem('seerr_sync_failed', null, step.userId, `recreate ${first.title} seasons ${step.keep.join(',')}: ${reason(err)}`);
      }
    }
    const parts = [`Removed Seerr request(s) ${removed.join(', ')}.`];
    if (recreated.length) parts.push(`Recreated for unfilled seasons: ${recreated.map((r) => `${r.requestId} (S${r.seasons.join(',')})`).join('; ')}.`);
    if (failed.length) parts.push(`Could not recreate: ${failed.map((f) => `user ${f.userId} S${f.seasons.join(',')}`).join('; ')} (see the integrity log).`);
    return { action: 'removed', removed, recreated, failed, message: parts.join(' ') };
  } catch (err) {
    logProblem('seerr_sync_failed', null, null, `purge ${first.title}: ${reason(err)}`);
    return { action: 'error', message: `Seerr request was not removed: ${reason(err)}` };
  }
}

const COMPLETED = 5; // Seerr request status: every requested season/movie is available

/**
 * Deletes every completed (filled) non-4K request from Seerr, so it only tracks what still needs filling.
 * Ownership lives in this database, so nothing is lost. Needs SEERR_SYNC; requests from users outside
 * SEERR_SYNC_USER_IDS are left alone. A failure on one request does not stop the others. Never throws.
 */
export async function removeFilledRequests({ dryRun = false } = {}) {
  if (!config.seerrSync) return { action: 'disabled', removed: [], failed: [] };
  try {
    const filled = (await listAllRequests()).filter((r) => r.status === COMPLETED && !r.is4k && allowed(r.requestedBy?.id));
    if (dryRun) {
      const details = filled.map((r) => ({
        id: r.id,
        mediaType: r.media?.mediaType ?? null,
        tmdbId: r.media?.tmdbId ?? null,
        requester: r.requestedBy?.displayName || r.requestedBy?.plexUsername || r.requestedBy?.username || r.requestedBy?.email || `user ${r.requestedBy?.id}`,
        seasons: (r.seasons ?? []).map((s) => s.seasonNumber),
      }));
      return { action: 'dry_run', removed: filled.map((r) => r.id), failed: [], details };
    }
    const removed = [];
    const failed = [];
    for (const r of filled) {
      try {
        await deleteRequest(r.id);
        removed.push(r.id);
      } catch (err) {
        failed.push(r.id);
        logProblem('seerr_sync_failed', null, r.requestedBy?.id, `delete filled request ${r.id}: ${reason(err)}`);
      }
    }
    if (removed.length) logProblem('seerr_requests_cleaned', null, null, `Deleted ${removed.length} filled Seerr request(s)`);
    return { action: removed.length || failed.length ? 'removed' : 'none', removed, failed };
  } catch (err) {
    logProblem('seerr_sync_failed', null, null, `filled-request cleanup: ${reason(err)}`);
    return { action: 'error', removed: [], failed: [], message: reason(err) };
  }
}

/** Creates a Seerr request for the new owner of an adopted unit. */
export async function claimInSeerr(unit, userId) {
  const skipped = skipReason(userId);
  if (skipped) return skipped;
  if (!unit.tmdb_id) return { action: 'none', message: 'No TMDB id is stored, so no Seerr request could be created.' };

  try {
    const info = await getMediaInfo(unit.media_type, unit.tmdb_id);
    if (requestsFor(info, userId, unit).length) {
      return { action: 'exists', message: 'Seerr already lists this on your requests.' };
    }

    const body = { mediaType: unit.media_type, mediaId: unit.tmdb_id, userId, ignoreQuota: true };
    if (unit.media_type === 'tv') {
      body.seasons = unit.season_number === null ? 'all' : [unit.season_number];
      if (unit.tvdb_id) body.tvdbId = unit.tvdb_id;
    }

    const created = await createRequest(body);
    if (!created?.id) {
      // Seerr answers 202 "No seasons available to request" for seasons that are already downloaded.
      const why = created?.message || 'no request was created';
      logProblem('seerr_sync_not_created', unit, userId, `claim: ${why}`);
      return {
        action: 'not_created',
        message: `Seerr did not add this to your requests (${why}). The item is still yours here.`,
      };
    }
    return { action: 'created', requestId: created.id, message: `Added to your Seerr requests (request ${created.id}).` };
  } catch (err) {
    logProblem('seerr_sync_failed', unit, userId, `claim: ${reason(err)}`);
    return { action: 'error', message: `Seerr request was not created: ${reason(err)}` };
  }
}
