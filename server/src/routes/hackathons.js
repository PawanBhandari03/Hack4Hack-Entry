import { Router } from 'express';
import { Hackathon } from '../models/index.js';
import { requireAuth } from '../middleware/auth.js';
import { validate, schemas } from '../middleware/validate.js';
import { idempotency } from '../middleware/idempotency.js';
import { createTeamLimiter } from '../middleware/rateLimit.js';
import * as teams from '../services/teamService.js';
import * as board from '../services/boardService.js';
import { getSuggestions } from '../services/suggestionService.js';
import { tagRouteBase } from '../lib/metrics.js';

const router = Router();
router.use(tagRouteBase);
const hp = validate({ params: schemas.hackathonParams });

router.get('/', async (_req, res) => {
  const list = await Hackathon.find().sort({ createdAt: -1 }).lean();
  res.json({
    items: list.map((h) => ({
      id: String(h._id),
      name: h.name,
      slug: h.slug,
      description: h.description,
      minTeamSize: h.minTeamSize,
      maxTeamSize: h.maxTeamSize,
      teamFormationClosesAt: h.teamFormationClosesAt ?? null,
    })),
  });
});

router.use(requireAuth);

/** My registration, my team, my pending requests (auto-registers me). */
router.get('/:hackathonId/me', hp, async (req, res) => {
  res.json(await teams.getMyState(req.params.hackathonId, req.userId));
});

router.patch('/:hackathonId/me', hp, validate({ body: schemas.lookingForTeam }), async (req, res) => {
  res.json({ me: await teams.setLookingForTeam(req.params.hackathonId, req.userId, req.body.lookingForTeam) });
});

router.get('/:hackathonId/board/teams', hp, validate({ query: schemas.boardQuery }), async (req, res) => {
  res.type('json').send(await board.listOpenTeams(req.params.hackathonId, req.validQuery));
});

router.get('/:hackathonId/board/people', hp, validate({ query: schemas.boardQuery }), async (req, res) => {
  res.type('json').send(await board.listPeopleLooking(req.params.hackathonId, req.validQuery));
});

router.get('/:hackathonId/stats', hp, async (req, res) => {
  res.type('json').send(await board.getBoardStats(req.params.hackathonId));
});

router.get('/:hackathonId/suggestions', hp, async (req, res) => {
  res.json(await getSuggestions(req.params.hackathonId, req.userId));
});

router.post('/:hackathonId/teams', hp, createTeamLimiter, idempotency(), validate({ body: schemas.createTeam }), async (req, res) => {
  res.status(201).json({ team: await teams.createTeam(req.userId, req.params.hackathonId, req.body) });
});

export default router;
