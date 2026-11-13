# TeamUp: race-proof team formation

A production-grade team-formation service for a 10,000-participant hackathon, built for the **Hack4Hack Crew Hiring Challenge 2026 (Problem 1)**.

People create teams, invite others with expiring codes, request to join (the leader accepts or declines), and find each other on a live "looking for teammates" board. **When 50 people click "join" for the last seat at the same instant, exactly one gets it.**

- **Live app:** _TBD_  ·  **API:** _TBD_
- **Design doc (1 page):** [docs/DESIGN.md](docs/DESIGN.md)  ·  **Load-test report:** [docs/LOADTEST.md](docs/LOADTEST.md)
- **Demo logins:** `demo1@hack4hack.dev` … `demo5@hack4hack.dev`, password `password123`

## Highlights

| Requirement | Where / proof |
|---|---|
| Race-proof last seat (50 → exactly 1) | MongoDB transactions + conditional updates, [`teamService.js`](server/src/services/teamService.js) · [`tests/race.test.js`](server/tests/race.test.js) |
| Idempotent retries | `Idempotency-Key` middleware + data-model backstop · [`idempotency.js`](server/src/middleware/idempotency.js) |
| Real-time board and team pages | Socket.io, events published only after commit · [`socket.js`](server/src/socket.js) |
| Team rules | min/max size, 1 team per person, expiring codes, leader hand-off, team deleted when empty |
| Security | JWT (HS256 pinned), bcrypt, leader-only actions, 50-bit hashed invite codes, rate limits, zod validation everywhere |
| Audit log | who / what / when, written in the same transaction |
| Teammate suggestions | `0.7 × missing-skill coverage + 0.3 × timezone closeness`, with a per-result breakdown |
| Tests + CI | **39 tests** (Vitest + Supertest on a real MongoDB replica set), GitHub Actions |
| Seed | 10,000 users + 2,000 teams |
| Load test | Board **p95 91–95 ms** with 100 concurrent users (target < 200 ms) |
| UI | React, works on phones, keyboard-only accessible |
| **Bonus** | Optimistic UI with rollback · `docker compose up` (fully offline) · Prometheus `/metrics` · **chaos test** (SIGKILL mid-join → 0 integrity violations) |

## Run it

### Option A: one command, fully offline (Docker)

```bash
docker compose up --build
```
UI at http://localhost:8080 and API at http://localhost:4000 (`/health`, `/metrics`). The database is seeded with 10k users automatically on first start.

### Option B: dev mode

Requires Node ≥ 20 and a MongoDB **replica set** (Atlas free tier works). Transactions don't run on a standalone mongod.

```bash
# API
cd server
cp .env.example .env        # set MONGODB_URI and JWT_SECRET
npm install
npm run seed                # 10,000 users, 2,000 teams (wipes the DB!)
npm run dev                 # http://localhost:4000

# UI (second terminal)
cd client
npm install
npm run dev                 # http://localhost:5173 (uses VITE_API_URL, default http://localhost:4000)
```

### Scripts (in `server/`)

| Command | What it does |
|---|---|
| `npm test` | 39 API tests, including race, real-time, metrics and chaos tests (in-memory MongoDB replica set; no setup needed) |
| `npm run seed` | Wipe and seed 10,000 users / 2,000 teams |
| `npm run loadtest` | Realistic and saturation load tests, exact p95 (`TARGET=…` to point elsewhere) |
| `npm run verify` | Check every invariant (member counts, seats, one leader, no orphans) against the DB |

## API

All endpoints are under `/api`. Every endpoint except register, login and the hackathon list needs `Authorization: Bearer <jwt>`. Mutations accept an `Idempotency-Key` header. Errors look like `{ "error": { "code": "TEAM_FULL", "message": "…" } }`.

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register`, `/auth/login` | rate-limited |
| GET / PATCH | `/auth/me` | profile: skills, timezone, bio |
| GET | `/hackathons` | public |
| GET / PATCH | `/hackathons/:id/me` | my team and requests; toggle `lookingForTeam` |
| GET | `/hackathons/:id/board/teams` · `/board/people` | `?limit&cursor&skill`, cursor-paginated |
| GET | `/hackathons/:id/suggestions` | people for my team, or teams for me |
| POST | `/hackathons/:id/teams` | create a team (creator becomes leader) |
| GET / PATCH | `/teams/:id` | details (leader also sees requests); edit is leader-only |
| GET | `/teams/:id/audit` | members only |
| POST | `/teams/:id/leave` | leader hand-off; team deleted when empty |
| DELETE | `/teams/:id/members/:userId` | leader only |
| POST | `/teams/:id/leader` | transfer leadership |
| POST / DELETE | `/teams/:id/invites` | generate (revokes old) / revoke codes |
| POST | `/invites/redeem` | `{ code }`, 10 tries / 15 min |
| POST | `/teams/:id/requests` | request to join |
| POST | `/requests/:id/accept` · `/decline` · `/cancel` | |

**Socket.io events:** `board:team`, `board:team-removed`, `board:person` (hackathon room) · `team:updated`, `team:requests`, `team:deleted` (members only) · `me:updated`, `notify` (private).

## Project layout

```
server/
  src/models/          data model + indexes
  src/services/        teamService (all rules, race-proof), boardService, suggestionService
  src/middleware/      auth, zod validation, idempotency, rate limits, errors
  src/lib/             transactions, realtime publish, invite codes, metrics, integrity checker
  tests/               race, chaos, realtime, teams, auth, board tests
  scripts/             seed, loadtest, verify-integrity
client/src/            api.js (idempotent fetch), state.jsx (socket), pages/
docs/                  DESIGN.md, LOADTEST.md, raw load-test JSON
```

## Honest notes: what's missing

- Single API instance. Scaling out needs the Socket.io Redis adapter and a shared cache (see the design doc).
- The JWT lives in localStorage with a 7-day expiry. Production should use short-lived tokens plus refresh cookies.
- The minimum team size is shown ("forming" / "meets minimum") but not enforced on leave. A "finalize team" step would enforce it.
- Free-tier hosting (Render 0.1 CPU, Atlas M0 at about 100 ops/s) limits deployed throughput. See the load-test report.
