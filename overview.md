# Project Overview — Hack4Hack Crew Hiring Challenge 2026 (Problem 1)

> Living document. Updated after every important step so Pawan can explain every decision in the interview.
> Secrets (DB password, JWT secret) live only in `server/.env`, which is git-ignored — never in this file.

---

## 1. The challenge

- **What:** Hack4Hack is hiring 2 Full-stack Engineers. Instead of a CV, you solve one of two real product problems.
- **Format:** Online, individual, free, one submission, one problem statement.
- **Rewards:** Top 5 per problem → 45-min interview with the founding team → paid internship (students) or full-time role (remote). Top 50 get written feedback, every complete submission gets a certificate. No salary figures published.
- **Timeline:**
  - Build round: 1 Nov → **15 Nov 2026, 11:59 PM IST** (late = not reviewed)
  - Top 5 announced: 21 Nov
  - Interviews: 23–26 Nov (walkthrough of your submission + a small live change + role chat)
  - Offers: by 30 Nov
- **Submit:** GitHub repo, live URL, 1-page design doc, load-test report, ≤5-min walkthrough video.
- **Rules worth remembering:** AI tools allowed, **but you must be able to explain every line**. Stack preferred: React + Node (Express) + MongoDB.
- **Judging (PS1):** 1) correctness under concurrency, 2) design decisions & how well you defend them, 3) code quality, tests, UX.

## 2. Problem Statement 1 — Race-proof team formation

Build a production-grade team-formation service for a hackathon with 10,000 participants.

### Must-haves → how we build each

| # | Requirement | Our approach |
|---|---|---|
| 1 | Auth | JWT (Bearer token), bcrypt password hashing. Profile has skills + timezone. |
| 2 | Teams: create, invite code, join requests (leader accept/decline), leave, remove | Express REST API + `teamService` holding all the business logic |
| 3 | Rules: min/max size, one team per person, expiring invite codes, leadership transfer, delete when empty | Enforced inside MongoDB **transactions** |
| 4 | **Race-proof:** 50 people grab the last seat, exactly 1 wins | Conditional atomic update (`memberCount < max`) inside a transaction + automated test that fires 50 parallel requests |
| 5 | **Idempotent:** retries never double-join or double-create | `Idempotency-Key` header stored with a unique index + the "one team per person" constraint as a backstop |
| 6 | Real-time board & team pages | Socket.io rooms; events emitted **only after the transaction commits** |
| 7 | Security | Only leader can accept/decline/remove; invite codes are random (~50 bits) + hashed in DB + rate-limited; zod validation on every input |
| 8 | Audit log | `AuditLog` collection written in the same transaction as the change (who / what / when) |
| 9 | Teammate suggestions | Score = complementary skills + timezone closeness, formula explained in API + doc |
| 10 | ≥20 API tests incl. race test, in CI | Vitest + Supertest + mongodb-memory-server (replica set), GitHub Actions |
| 11 | Seed: 10k users, 2k teams | `scripts/seed.js` with batched `insertMany` |
| 12 | Load test: board p95 < 200 ms @100 concurrent | autocannon script, lean queries + indexes + pagination |
| 13 | React UI, mobile + keyboard-only | Vite + React, semantic HTML, focus states, responsive CSS |
| 14 | Deploy | Backend Render, frontend Vercel, DB MongoDB Atlas |

**Bonus (only if time remains):** optimistic UI with rollback, Docker Compose, metrics, chaos test (kill server mid-join).

### Plan (≈48 h)

1. Backend core: models, auth, team logic, race-proof join, idempotency, audit log
2. Tests (≥20 incl. race) + GitHub Actions
3. Socket.io live updates, suggestions, seed script
4. React UI
5. Deploy + load test + tuning
6. Design doc, load-test report, README (later)

---

## 3. Build log (what was done + why — interview prep)

### Step 1 — Project setup
- Monorepo: `server/` (Express API) and `client/` (React). One repo is easier for reviewers to clone and for CI.
- `.gitignore` was created **before** any secret file, so `server/.env` can never be committed. `server/.env.example` shows which variables are needed.
- Server is an ES-module Node project (`"type": "module"`), Node 22.
- Dependencies and why:
  - `express` – HTTP API; `mongoose` – MongoDB ODM with schema + indexes
  - `socket.io` – real-time (WebSockets with automatic fallback + rooms + reconnection built in)
  - `jsonwebtoken` + `bcryptjs` – stateless auth + safe password hashing
  - `zod` – input validation for every request body/query/params
  - `express-rate-limit` – brute-force protection on login and invite-code redemption
  - `helmet`, `cors` – security headers, allowed origin for the React app
  - Dev: `vitest` + `supertest` (API tests), `mongodb-memory-server` (real Mongo in tests, as a replica set so transactions work), `autocannon` (load test)
- Verified Atlas connection (≈330 ms). It is a **replica set**, which matters: **MongoDB transactions only work on replica sets**, and our race-proofing uses transactions.

### Step 2 — Data model (`server/src/models/index.js`)
| Collection | Purpose | Key indexes (and why) |
|---|---|---|
| `Hackathon` | Holds the rules: `minTeamSize`, `maxTeamSize` | `slug` unique |
| `User` | Account: name, email, bcrypt hash, skills, timezone, `utcOffsetMinutes` | `email` unique |
| `Participant` | A user's registration in ONE hackathon. `teamId: null` = no team. Has copies of name/skills/timezone so the board needs no joins. | `{hackathonId, userId}` **unique** → one row per person per hackathon |
| `Team` | name, leader, `memberCount`, **`openSeats`**, skillsWanted, lookingForMembers | `{hackathonId, nameKey}` unique (no duplicate names); board index `{hackathonId, lookingForMembers, updatedAt, openSeats}` |
| `Invite` | Invite codes — **only the SHA-256 hash is stored** | `codeHash` unique |
| `JoinRequest` | Request → leader accepts/declines | **partial unique** `{teamId, userId}` where `status: pending` → can't have 2 pending requests to the same team |
| `AuditLog` | who (`actorId`), what (`action`, `targetUserId`, `details`), when (`createdAt`) | `{teamId, createdAt}` |
| `IdempotencyKey` | Stored responses for retried requests | `{userId, key}` unique, TTL 24 h |

**Interview Q: Why store `openSeats` when you could compute `maxSize - memberCount`?**
Because a normal update filter can't efficiently compare two fields, but it CAN atomically check `openSeats > 0`. Storing it turns "is there a seat? then take it" into **one atomic operation**.

**Interview Q: Why a separate `Participant` collection instead of a `teamId` on `User`?**
A user can join many hackathons. "One team per person per hackathon" becomes a simple rule on one document: `Participant.teamId` must be `null` to join.

### Step 3 — How races are prevented (THE most important part)
Files: `server/src/services/teamService.js` + `server/src/lib/txn.js`

Every change runs in a **MongoDB transaction** and uses **conditional updates**:
```js
// claim the person: only if they're not in a team
Participant.findOneAndUpdate({ hackathonId, userId, teamId: null }, { $set: { teamId } })
// take the seat: only if a seat is open
Team.findOneAndUpdate({ _id, openSeats: { $gt: 0 } }, { $inc: { openSeats: -1, memberCount: 1 } })
```
What happens when 50 people click "join" for the last seat at the same moment:
1. All 50 transactions try to update the **same Team document**.
2. MongoDB lets the first one write; the others get a **WriteConflict** (MongoDB never lets two transactions modify the same document at once).
3. `session.withTransaction()` automatically **retries** the losers. On retry they read fresh data: `openSeats` is now `0`, the conditional update matches nothing → we throw `409 TEAM_FULL`.
4. Result: exactly 1 winner, 49 × `TEAM_FULL`. Proven by `tests/race.test.js`.

**Why a transaction and not just the atomic update?** Joining touches 3+ documents (Participant, Team, AuditLog, JoinRequests). Without a transaction a crash between them could leave "seat taken but person not in team". With a transaction it's all-or-nothing.

**Why not a lock (Redis lock / mutex)?** Locks need extra infrastructure, can stay held if a process crashes, and an in-memory mutex doesn't work with more than one server instance. Optimistic concurrency in the DB works across any number of servers.

Other races handled the same way:
- **Same person joins 5 teams at once** → all write the same Participant doc → only one commits, the rest get `ALREADY_IN_TEAM`.
- **10 accepts with 1 seat left** → request status update is conditional on `status: 'pending'`, seat is conditional on `openSeats > 0`.
- **All members leave at once** → all write the same Team doc → serialised → team deleted exactly once, count never negative.
- **Invite revoked while someone joins** → the join does `$inc uses` on the Invite doc inside the transaction, so it conflicts with the revoke instead of using a stale code.

**Team rules implemented:**
- Max size → `openSeats` check. Min size → `meetsMinimum` flag shown in UI/board (a team below the minimum is "forming").
- One team per person → `teamId: null` condition + unique Participant row.
- Invite codes expire (48 h, `INVITE_CODE_TTL_HOURS`); generating a new code revokes the old one.
- Leader leaves → member with the earliest `joinedTeamAt` becomes leader (fair + deterministic).
- Last member leaves → team deleted, invites revoked, pending requests cancelled.
- Joining a team auto-cancels your other pending requests.

### Step 4 — Idempotency (`server/src/middleware/idempotency.js`)
Client sends `Idempotency-Key: <uuid>` (one per user action, reused on retries).
1. We **insert the key first** (unique index) before doing any work.
2. A retry while the first request is still running → insert fails → `409 REQUEST_IN_PROGRESS`.
3. A retry after it finished → we **replay the saved response** (header `Idempotent-Replayed: true`); the work is not repeated.
4. 5xx responses delete the key so the user can genuinely retry. A key stuck "in progress" > 60 s (server crashed) is reclaimed.
5. **Second line of defence:** even without a key, the data model makes a double join impossible (`teamId: null` condition).

### Step 5 — Security
- **Auth:** JWT in the `Authorization: Bearer` header; passwords hashed with bcrypt. Login compares against a dummy hash when the email doesn't exist → same response time → can't discover which emails are registered.
- **Leader-only actions** (accept/decline/remove/edit/invite/transfer) check `team.leaderId` **inside** the transaction.
- **Invite codes:** 10 chars from a 32-letter alphabet = **50 bits of randomness** (`crypto.randomBytes`), stored only as a SHA-256 hash, **rate limited to 10 attempts / 15 min per user**. Brute force would need ~10^11 years.
- "Code doesn't exist" and "code revoked" return the same error → attackers learn nothing.
- **Validation:** every body/query/param goes through a `zod` schema (`middleware/validate.js`). Skills are lower-cased + de-duplicated; timezones must be real IANA names; JSON bodies limited to 20 kB.
- `helmet` security headers, CORS restricted to the frontend origin, `trust proxy` set so rate limits see the real client IP behind Render's proxy.

### Step 6 — Real-time (`server/src/socket.js`, `lib/realtime.js`)
- Socket.io, authenticated with the same JWT.
- Rooms: `hackathon:<id>` (board), `team:<id>` (members only), `user:<id>` (private notifications).
- **Events are emitted only after the transaction commits** (services push events into a list; `runTxn` publishes after commit). If a transaction is rolled back, nobody hears about it.
- On reconnect the client refetches via REST, so a missed event can't leave the screen wrong forever.

### Step 7 — Teammate suggestions (`server/src/services/suggestionService.js`)
`score = 100 × (0.7 × skillScore + 0.3 × timezoneScore)`
- `skillScore` = share of the team's **missing** skills the candidate has (skills wanted minus skills members already have). Someone who only duplicates existing skills scores 0 → that's what "complementary" means.
- `timezoneScore` = `1 − hoursApart / 12` (hours measured around the 24 h clock, so UTC+12 and UTC−11 are 1 h apart).
- Team timezone = circular mean of the members' offsets.
- Two modes: in a team → ranks people; solo → ranks teams. Each result includes a breakdown (matched skills, hours apart).
- Why 70/30: skills decide whether the team can build at all; timezone only affects convenience.

### Step 8 — Tests + CI
- 36 tests, Vitest + Supertest, against a **real in-memory MongoDB replica set** (`mongodb-memory-server`) — same engine as Atlas, transactions included.
- `tests/race.test.js`: 50-way last seat, 10 parallel accepts, 1 user × 5 teams, 10 parallel creates, 4 members leave at once.
- Others: auth, validation, team rules, invite expiry/rate limit, join requests, idempotency, audit log, board pagination, suggestions, Socket.io live updates.
- Ran the suite 4× in a row: all green (no flaky race tests).
- GitHub Actions: `.github/workflows/ci.yml` runs `npm test` on every push.

### Step 9 — Seed + load test
- `npm run seed` → 10,000 users, 2,000 teams (5,067 in teams, 4,933 solo). ~70 s on Atlas. One bcrypt hash reused, `insertMany` in batches of 1000, deterministic random so every run is identical.
- Demo logins: `demo1@hack4hack.dev` … `demo5@hack4hack.dev`, password `password123`.
- `npm run loadtest` (autocannon, 100 connections). autocannon doesn't report p95, so the script records every response time and computes the exact p95 itself.
- **First run FAILED: p95 = 1059 ms, only 113 req/s.** Investigation: `/health` did 4,900 req/s, so Node was fine. Cause: **Atlas free tier (M0) is throttled to ~100 operations/second**, and every board request did a DB lookup of the hackathon.
- Fixes: (1) cache hackathon settings for 30 s; (2) board responses micro-cached for 1 s **and the promise itself is cached**, so 100 simultaneous requests share ONE DB query.
- **Second run PASSED: p95 = 146 ms at 1,035 req/s** (page 1); p95 = 158 ms for a mix of page 2 / people / skill filter. 0 errors. (Load generator and server on the same laptop, DB on Atlas.)
- **Interview Q: Isn't a cache "cheating" on freshness?** The 1 s cache only affects the first page load; every change is pushed instantly over WebSockets, and writes never read from the cache — all correctness checks happen inside the DB transaction.
- CI on GitHub (Linux) passed: 36/36.

### Step 10 — React frontend (`client/`)
Vite + React 19 + React Router + socket.io-client. No UI library — plain CSS with design tokens (light + dark mode).
- **Pages:** Login / Register (skills + timezone, demo-account buttons), **Board** (my status, create team, join with code, suggestions, live Teams / People tabs with skill filter + Load more), **Team page** (members, leader controls, join requests, invite code, activity log), **Profile**.
- **`src/api.js`** — fetch wrapper. Every POST/PATCH/DELETE gets ONE `Idempotency-Key` per user action and **reuses it for automatic retries** (network error, or `REQUEST_IN_PROGRESS`). This is the client half of idempotency.
- **`src/state.jsx`** — one Socket.io connection per login; private notifications (request accepted/declined, someone asked to join) become toasts; on reconnect everything is refetched.
- **Live board (`useLiveBoard` in `Board.jsx`):** first page via REST, then WebSocket events upsert/remove cards; changed cards flash briefly. A team that fills its last seat disappears from everyone's board instantly.
- **Optimistic UI (bonus):** "Request to join" flips to "Requested ✓" immediately and **rolls back** if the server says no (e.g. TEAM_FULL).
- **Mobile:** fluid grid (`auto-fill, minmax(280px, 1fr)`), 44 px touch targets, stacked layout under 600 px.
- **Keyboard-only:** skip link, real `<button>`/`<a>`/`<label>` everywhere, visible focus ring, tabs follow the ARIA tabs pattern (arrow keys), `aria-live` toasts, `role="alert"` errors, confirmation before destructive actions.
- Production build: 104 kB gzipped JS.
- Pawan tested demo1 + demo2 in two browsers: live updates work without refresh.
- Fix after review: the hackathon room subscription moved to app level (`state.jsx`), so people viewing a team page they're NOT a member of also get live seat counts / deletion notices (previously only on the Board).
- `client/vercel.json` rewrites every path to `index.html`, so refreshing `/teams/:id` on Vercel doesn't 404.

### Step 11 — Deploy config
- `render.yaml` (Render Blueprint): API in **Singapore** — the closest Render region to the Atlas cluster in **AWS Mumbai (ap-south-1)**. Fewer km between server and DB = lower latency on every query.
- Atlas Network Access: `0.0.0.0/0` added (Render's free tier has no fixed outgoing IP). Security still comes from the DB username/password + TLS.

### Step 12 — Integrity checker (`server/src/lib/integrity.js`, `npm run verify`)
Scans the DB and lists any broken invariant:
1. `team.memberCount` = number of Participants in that team
2. `openSeats = maxSize − memberCount`, and `1 ≤ memberCount ≤ maxSize`
3. exactly one leader per team, and it equals `team.leaderId`
4. no Participant points at a deleted team
5. nobody registered twice in one hackathon

Ran against Atlas (10k users + manual testing): **2,001 teams / 5,069 members checked in 0.9 s → OK**.

### Step 13 — Chaos test (bonus) (`server/tests/chaos.test.js`)
1. Start the real server as a separate process.
2. Fire **340 requests at once** (300 joins for only 120 free seats + 40 leaders leaving → leader transfers and team deletions racing with joins).
3. After 40 responses, **kill the server with SIGKILL** (no clean shutdown).
4. Restart it, retry only the requests that got no answer, **with the same Idempotency-Key**.
5. Assert: integrity check = 0 violations, and everyone who was told "joined" really is in that team.

**Interview Q: Why can't a crash corrupt anything?** Each join/leave is ONE transaction. A killed process never sends `commitTransaction`, so MongoDB throws away its half-done writes. The DB only ever holds complete "before" or "after" states.

**Interesting detail (good to mention):** a transaction left open by a crashed process keeps its document "reserved" until MongoDB's `transactionLifetimeLimitSeconds` (60 s on Atlas) aborts it. New requests touching that same team just retry (`withTransaction` retries on write conflicts) and succeed once it's aborted — slower for up to a minute, but never wrong. In tests the limit is set to 5 s so the test is fast.

**Retries after a crash:** the idempotency key of a killed request is stuck "in_progress". After the stale window (60 s in prod, 1 s in the test) a retry may re-run the action — and if the original had actually committed, the data model rejects the duplicate (`ALREADY_IN_TEAM`). That's why we have two layers.

### Step 14 — Metrics (bonus) (`server/src/lib/metrics.js`, `GET /metrics`)
Prometheus format via `prom-client`:
- `http_request_duration_seconds{method,route,status}` — histogram → p95 per endpoint in production, not just in the load test. Labelled by **route pattern** (`/api/teams/:teamId`), not raw URL, so the number of series stays small.
- `txn_retries_total` — incremented every time `withTransaction` re-runs our code because of a **write conflict**. This is a **live counter of races that happened and were resolved safely**. (Great demo: run the race, watch it go up.)
- `txn_attempts_total{outcome=committed|aborted}`, `api_errors_total{code}` (e.g. how many `TEAM_FULL`), `socket_connections`, plus Node process metrics (memory, event-loop lag, GC).
- Optional `METRICS_TOKEN` env var to protect the endpoint.
- Test: after a 20-way race, `/metrics` shows `txn_retries_total > 0` and `TEAM_FULL` errors. Tests: **38**.

### Decision — not merging Pawan's earlier hackathon-platform project
Judging is about depth on concurrency/design, not breadth. Merging a second codebase 2 days before the deadline adds risk and interview surface without scoring. Instead its strongest idea (fully offline `docker compose up`) is reused as the official Docker Compose bonus, and the project is mentioned in the README/interview as background.
