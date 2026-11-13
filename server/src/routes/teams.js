import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate, schemas } from '../middleware/validate.js';
import { idempotency } from '../middleware/idempotency.js';
import { inviteLimiter, joinRequestLimiter } from '../middleware/rateLimit.js';
import * as teams from '../services/teamService.js';

/* ------------------------------- /api/teams ------------------------------- */
export const teamsRouter = Router();
teamsRouter.use(requireAuth);
const tp = validate({ params: schemas.teamParams });

teamsRouter.get('/:teamId', tp, async (req, res) => {
  res.json(await teams.getTeamDetails(req.params.teamId, req.userId));
});

teamsRouter.patch('/:teamId', tp, validate({ body: schemas.updateTeam }), async (req, res) => {
  res.json({ team: await teams.updateTeam(req.userId, req.params.teamId, req.body) });
});

teamsRouter.get('/:teamId/audit', tp, async (req, res) => {
  res.json({ items: await teams.getTeamAudit(req.params.teamId, req.userId) });
});

teamsRouter.post('/:teamId/leave', tp, idempotency(), async (req, res) => {
  res.json(await teams.leaveTeam(req.userId, req.params.teamId));
});

teamsRouter.delete('/:teamId/members/:userId', validate({ params: schemas.memberParams }), idempotency(), async (req, res) => {
  res.json(await teams.removeMember(req.userId, req.params.teamId, req.params.userId));
});

teamsRouter.post('/:teamId/leader', tp, validate({ body: schemas.transferLeader }), async (req, res) => {
  res.json({ team: await teams.transferLeadership(req.userId, req.params.teamId, req.body.userId) });
});

teamsRouter.post('/:teamId/invites', tp, async (req, res) => {
  res.status(201).json(await teams.createInvite(req.userId, req.params.teamId));
});

teamsRouter.delete('/:teamId/invites', tp, async (req, res) => {
  res.json(await teams.revokeInvites(req.userId, req.params.teamId));
});

teamsRouter.post('/:teamId/requests', tp, joinRequestLimiter, idempotency(), validate({ body: schemas.joinRequest }), async (req, res) => {
  const { request, created } = await teams.requestToJoin(req.userId, req.params.teamId, req.body.message);
  res.status(created ? 201 : 200).json({ request });
});

/* ------------------------------ /api/invites ------------------------------ */
export const invitesRouter = Router();
invitesRouter.use(requireAuth);

invitesRouter.post('/redeem', inviteLimiter, idempotency(), validate({ body: schemas.redeemInvite }), async (req, res) => {
  res.json({ team: await teams.redeemInvite(req.userId, req.body.code) });
});

/* ------------------------------ /api/requests ----------------------------- */
export const requestsRouter = Router();
requestsRouter.use(requireAuth);
const rp = validate({ params: schemas.requestParams });

requestsRouter.post('/:requestId/accept', rp, idempotency(), async (req, res) => {
  res.json({ request: await teams.decideRequest(req.userId, req.params.requestId, 'accept') });
});

requestsRouter.post('/:requestId/decline', rp, idempotency(), async (req, res) => {
  res.json({ request: await teams.decideRequest(req.userId, req.params.requestId, 'decline') });
});

requestsRouter.post('/:requestId/cancel', rp, idempotency(), async (req, res) => {
  res.json({ request: await teams.cancelRequest(req.userId, req.params.requestId) });
});
