import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import { chargeForRequest, getBalance, recordRequestEvent, refundRequest, upsertUser } from '../services/credits.js';
import { getCosts } from '../services/settings.js';
import { approveRequest, declineRequest, getRequest, getTitle } from '../services/seerr.js';

const router = Router();

function secretMatches(header) {
  const given = Buffer.from(String(header ?? '').replace(/^Bearer\s+/i, ''));
  const wanted = Buffer.from(config.webhookSecret);
  if (!wanted.length) return false; // an unset secret must never match an empty header
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

router.post('/', async (req, res, next) => {
  try {
    if (!secretMatches(req.get('authorization'))) throw new HttpError(401, 'Invalid webhook secret');

    const body = req.body ?? {};
    // Pending requests wait for us to approve them; auto-approved ones (admin, or users with Auto-Approve) are already approved.
    const autoApproved = body.notification_type === 'MEDIA_AUTO_APPROVED';
    if (body.notification_type !== 'MEDIA_PENDING' && !autoApproved) {
      console.log(`Webhook ignored: ${body.notification_type ?? 'no notification_type'}`);
      return res.json({ ignored: true, reason: 'Not a Request Created event' });
    }

    const requestId = Number.parseInt(body.request?.request_id, 10);
    if (!Number.isInteger(requestId) || requestId <= 0) throw new HttpError(400, 'Missing request_id');

    // The webhook payload doesn't carry the requester's id, so read the request back from Seerr.
    const request = await getRequest(requestId);
    const requester = request?.requestedBy;
    const seerrMedia = request?.media;
    if (!requester?.id || !seerrMedia?.id) throw new HttpError(502, 'Seerr returned an incomplete request');

    const type = request.type === 'movie' ? 'movie' : 'tv';
    const seasons = (Array.isArray(request.seasons) ? request.seasons : []).map((s) => s.seasonNumber);
    const costs = getCosts();
    const unitCost = type === 'movie' ? costs.movie : costs.tvSeason;

    upsertUser({
      id: requester.id,
      email: requester.email ?? null,
      username: requester.displayName || requester.plexUsername || requester.username || requester.email || null,
      plexId: requester.plexId ?? null,
    });

    const title = await getTitle(type, seerrMedia.tmdbId);
    const result = chargeForRequest({
      requestId,
      requesterId: requester.id,
      unitCost,
      seasons,
      available: false, // a brand-new request has not been downloaded yet
      media: { seerrId: seerrMedia.id, tmdbId: seerrMedia.tmdbId ?? null, tvdbId: seerrMedia.tvdbId ?? null, mediaType: type, title },
    });

    if (result.duplicate) return res.json({ action: 'none', reason: 'Already processed' });

    const event = { requestId, userId: requester.id, mediaType: type, tmdbId: seerrMedia.tmdbId ?? null, title };

    if (!result.ok) {
      try {
        await declineRequest(requestId);
      } catch (err) {
        if (!autoApproved) throw err;
        console.log(`Could not decline auto-approved request ${requestId}: ${err.message}`);
      }
      console.log(`Declined request ${requestId}: needs ${result.cost} credit(s), user ${requester.id} has ${result.balance}`);
      recordRequestEvent({ ...event, action: 'DECLINED', cost: result.cost, balance: result.balance, reason: 'insufficient_credits' });
      return res.json({ action: 'declined', cost: result.cost, balance: result.balance });
    }

    try {
      if (!autoApproved) await approveRequest(requestId);
    } catch (err) {
      refundRequest(requestId); // don't keep credits for a request that wasn't approved
      recordRequestEvent({ ...event, action: 'REFUNDED', cost: result.cost, balance: getBalance(requester.id), reason: 'approve_failed' });
      throw err;
    }
    recordRequestEvent({ ...event, action: 'APPROVED', cost: result.cost, balance: result.balance });
    res.json({ action: 'approved', cost: result.cost, units: result.units, balance: result.balance });
  } catch (err) {
    next(err);
  }
});

export default router;
