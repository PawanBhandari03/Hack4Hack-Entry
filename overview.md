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

**Interesting detail (good to mention):** a transaction left open by a crashed process keeps its document "reserved" until MongoDB's `transactionLifetimeLimitSeconds` (60 s on Atlas) aborts it. New requests touching that same team keep hitting write conflicts. Our retry loop (`lib/txn.js`) backs off and retries for up to 15 s; if the orphan is still there after that, the API answers **`503 TRY_AGAIN` with `Retry-After: 2`** (never a 500, and nothing was written), and the React client automatically retries with the **same Idempotency-Key** until the orphan is aborted. So: slower for up to a minute for that one team, never wrong. In the chaos test the limit is 5 s (instead of Atlas' 60 s) so the test runs fast — with 60 s the retries would simply take longer.

**Retries after a crash:** the idempotency key of a killed request is stuck "in_progress". After the stale window (60 s in prod, 1 s in the test) a retry may re-run the action — and if the original had actually committed, the data model rejects the duplicate (`ALREADY_IN_TEAM`). That's why we have two layers.

### Step 14 — Metrics (bonus) (`server/src/lib/metrics.js`, `GET /metrics`)
Prometheus format via `prom-client`:
- `http_request_duration_seconds{method,route,status}` — histogram → p95 per endpoint in production, not just in the load test. Labelled by **route pattern** (`/api/teams/:teamId`), not raw URL, so the number of series stays small.
- `txn_retries_total` — incremented every time `withTransaction` re-runs our code because of a **write conflict**. This is a **live counter of races that happened and were resolved safely**. (Great demo: run the race, watch it go up.)
- `txn_attempts_total{outcome=committed|aborted}`, `api_errors_total{code}` (e.g. how many `TEAM_FULL`), `socket_connections`, plus Node process metrics (memory, event-loop lag, GC).
- Optional `METRICS_TOKEN` env var to protect the endpoint.
- Test: after a 20-way race, `/metrics` shows `txn_retries_total > 0` and `TEAM_FULL` errors. Tests: **38**.

### Step 15 — Performance round 2: profiling (important interview story)
Why: Render's free tier gives only **0.1 CPU**, so CPU per request decides whether the deployed load test passes.

1. **Profiled** the board endpoint with Node's built-in inspector (CPU profile during a load test).
2. **Finding #1 — JWT was ~50% of CPU.** Given a plain-string secret, `jsonwebtoken` first tries `crypto.createPublicKey(secret)` (fails), then builds a secret key — **on every request**. Fix: build the key once with `crypto.createSecretKey()` at startup (`middleware/auth.js`). Also pinned `algorithms: ['HS256']` (security: a token can't choose its own algorithm).
   → 743 → 1,340 req/s.
3. **Finding #2 — `JSON.stringify` was the next top cost.** The board was cached as an object and re-serialised per request. Fix: cache the **JSON string** and `res.send()` it. → 1,340 → 2,134 req/s.
4. **Added a "realistic" load-test run** (100 users each refreshing twice per second = 200 req/s), next to the two saturation runs (no think time). Surprise: **realistic FAILED (p95 236 ms)** while saturation passed.
   **Why:** traffic arrives in bursts; whenever the 1 s cache had just expired, the whole burst waited for the same Atlas query.
   **Fix: stale-while-revalidate** (`boardService.js` `cached()`): an entry 1–10 s old is served instantly while ONE background query refreshes it. Nobody waits for the DB except the first request after >10 s of silence.

| Run (laptop → Atlas Mumbai) | Before | After |
|---|---|---|
| Realistic 100 users × 2 req/s | p95 236 ms ❌ | **p95 95 ms ✅** |
| Saturation page 1 | 1,035 req/s, p95 146 ms | **2,711 req/s, p95 91 ms ✅** |
| Saturation mix (p2, people, skill filter) | p95 158 ms | **p95 109 ms ✅** |

**Interview Q: what's the staleness guarantee?** Board page data is at most ~1 s old under traffic (max 10 s right after an idle period, then refreshed). It's a *read view* only: joins/leaves never read the cache, they check `openSeats` inside the transaction, and live changes reach the UI over WebSockets immediately.

**Also learned:** endpoints that hit the DB every time (e.g. `/api/auth/me`) top out at ~100 req/s because **Atlas M0 is throttled to ~100 ops/s**. Paid tiers remove this; it's an infrastructure limit, not a code one.

### Step 16 — Docker Compose (bonus) — `docker compose up --build`
- `mongo` (Mongo 7 started as a **single-node replica set** — needed for transactions; the healthcheck runs `rs.initiate()` on first boot), `seed` (one-shot, only seeds an EMPTY DB: `SEED_IF_EMPTY=true`), `api` (waits for seed to finish), `web` (React built into static files, served by nginx with SPA fallback).
- Tested: whole stack up, seeded 10k users in **1.6 s** (local DB), login works, deep links work, all 3 load-test runs PASS against it. Fully offline.
- CI now has 3 jobs: server tests, client build, `docker compose build`.

### Step 17 — Docs
- `README.md` — what it is, highlights table (requirement → file → proof), how to run (Docker or dev), scripts, API reference, socket events, layout, honest "what's missing".
- `docs/DESIGN.md` — the required **1-page design doc**: data model, how races are prevented, trade-offs table, what we'd do with one more week.
- `docs/LOADTEST.md` — load-test report with all 5 runs **including the 2 failures and how each was diagnosed**, plus raw JSON in `docs/loadtest/`. Deployed (Render) run still to be added.

### Step 18 — Team-formation deadline + anti-spam limits
- `Hackathon.teamFormationClosesAt` is now **enforced** (`assertFormationOpen` in `teamService.js`): after it, create / join by code / request / accept → `409 TEAM_FORMATION_CLOSED`. **Leaving is still allowed** (blocking it would trap people). The check runs inside `addMemberInTxn`, so even an accept that races with the deadline is caught.
- Demo hackathon deadline = 60 days out (so reviewers can try everything during interview week). Board shows "Team formation closes in Xd Yh".
- New per-user rate limits: **30 join requests / 15 min**, **20 team creations / hour** — stops one account spamming every leader.
- New test (39 total): after the deadline, create/join/request all get `TEAM_FORMATION_CLOSED`, leave still returns 200.

### Step 19 — Linting (code quality)
- `oxlint` (very fast Rust linter, comes with the Vite template) on client AND server, `--deny-warnings`, runs in CI before tests/build.
- Fixes it drove: unused catch variable; moved `tzLabel`/`TIMEZONES` to `client/src/lib/format.js` and the React context + `useApp` hook to `client/src/appContext.js` (files that export components should only export components — React Fast Refresh). The four "setState inside effect" spots are intentional (data fetch on id change, syncing with the socket) and are annotated with the reason.

### Step 20 — Browser (end-to-end) tests with Playwright (`e2e/`)
Real Chromium, real UI, real server + DB (run against the Docker stack so test users don't pollute the Atlas demo data). 5 tests:
1. **Full flow:** register through the form → create team → generate invite code → a SECOND browser registers and joins with the code → the leader's page shows the new member **without reloading** (WebSockets) + activity log entry.
2. **Join request:** requester clicks "Request to join" → leader gets a live toast → accepts → requester's page turns into a member view live.
3. **Phone layout:** 375 px wide viewport, page has **no horizontal scroll**.
4. **Keyboard only:** first Tab lands on "Skip to content", tabs switch with arrow keys, a team is created using only the keyboard.
5. **Accessibility:** axe-core scan (WCAG 2 A/AA) of board and team pages → **0 serious/critical violations**.

All 5 pass locally. CI has a new `e2e` job: `docker compose up` → wait for health → run Playwright → upload the report on failure.
Fix it found: the invite-code element and its section were both labelled "Invite code" (ambiguous for screen readers too) → code element now "Current invite code".

### Decision — not merging Pawan's earlier hackathon-platform project
Judging is about depth on concurrency/design, not breadth. Merging a second codebase 2 days before the deadline adds risk and interview surface without scoring. Instead its strongest idea (fully offline `docker compose up`) is reused as the official Docker Compose bonus, and the project is mentioned in the README/interview as background.

### Step 22 — Retry storm found & fixed (great interview story)
Built `npm run race-demo` (`server/scripts/race-demo.js`): 50 real seeded users hit the LAST seat of a team **over HTTP against any deployment** (for the video). First run against Atlas: correct (1 × 200, 49 × TEAM_FULL, integrity OK) **but took 23.5 s**. `/metrics` showed why: **`txn_retries_total = 1,010`** for 50 requests.

**Cause:** the driver's `withTransaction()` retries a WriteConflict *immediately*. The 49 losers spun in a tight loop against the same Team document while the winner was still committing — and on Atlas M0 (≈100 ops/s throttle) that storm also slowed the winner down.

**Fixes:**
1. **Own transaction loop with exponential backoff + jitter** (`lib/txn.js`): on `TransientTransactionError`, abort, wait a random 0..min(100, 4·2ⁿ) ms, re-run on fresh data; on `UnknownTransactionCommitResult` retry only the commit. Max 15 s.
2. **Touch the hot document last:** in `addMemberInTxn` the seat update is now the final write before commit, so the winner holds the contended Team doc for the shortest time.
3. **Invite is no longer a second hot doc:** joins used to `$inc` a counter on the Invite to serialise against revokes. Now create/revoke bump `team.inviteEpoch` instead — joins already write the Team doc, so revoke-vs-join is still serialised, without a second contended document.
4. **Fast path:** `redeemInvite` checks `openSeats` before starting a transaction; once a team is full, later requests get TEAM_FULL instantly.
5. `ensureParticipant` reads first (1 op) instead of user lookup + upsert (2 ops) for already-registered users.

**Result:** retries **1,010 → 49** (each loser retries exactly once); 23.5 s → ~9 s on Atlas M0. The remaining time is purely M0's ops/s cap (≈18 DB ops per join × 50); on an unthrottled MongoDB the same 50-way race finishes well under 1 s (the whole test incl. creating 52 users takes 1.2 s).
Also fixed: metric route labels lost their prefix on error responses (`/redeem` instead of `/api/invites/redeem`) — Express resets `req.baseUrl` before the error handler, so each router now stores it in `res.locals` first. Test added.

**Follow-up fix:** the retry loop gives up after 15 s with a clean **503 `TRY_AGAIN` + `Retry-After`** (instead of a 500); the client retries automatically with the same Idempotency-Key. 3 unit tests for the loop (`tests/txn.test.js`): retries then succeeds, gives up with 503, never retries business errors like TEAM_FULL. **43 tests.**

**Interview Q: "What's the downside of optimistic concurrency?"** → Retry storms under contention. Show this story: measured it, explained it, fixed it with backoff + jitter + ordering, and proved it with the metric.

### Step 23 — Small gaps closed
- **Profile edits are now live:** `PATCH /api/auth/me` broadcasts the person's updated card to every board they're on (and refreshes their team page). Before, other users only saw new skills after a refresh. Test added (40 total).
- **Suggestions explain themselves:** every response includes a `formula` object describing exactly how `score`, `skillScore` and `timezoneScore` are computed (requirement: "the scoring must be explained").

### Step 24 — Simulated Render FREE before deploying → it fails → host decision
- `docker-compose.render-sim.yml` caps the API container at **0.1 CPU / 512 MB** (Render free).
- Result: **FAIL** — ~45 req/s, realistic p95 **1,392 ms**, timeouts. Even `/health` (does nothing) maxes at ~90–100 req/s with multi-second tails: at 0.1 CPU the process is frozen ~90% of every 100 ms by CPU throttling. No code change can fix that.
- **Decision (needs Pawan):** API on **Railway** (shared vCPU, Singapore, trial credit) or **Render Starter** (0.5 CPU, $7/mo). Frontend stays on Vercel (free, static). `docs/DEPLOY.md` rewritten: Railway first, Render Starter as alternative, post-deploy checklist (trust-proxy/rate-limit check, deployed load test, race demo, live URLs in README). `render.yaml` plan set to `starter`.
- Recorded honestly in `docs/LOADTEST.md` §C with the raw JSON.
- **Interview angle:** "I load-tested the hosting tier *before* deploying and found 0.1 CPU can't meet the SLO — so I sized the instance from data."

### Step 25 — CPU sizing with a proper "100 concurrent users" model
- My "realistic" autocannon run (`connectionRate: 2`) turned out to be a **thundering herd**: all 100 connections start together and fire in the *same millisecond* twice a second. Renamed it **"Burst"** (kept as a stress test).
- Added the standard model — **k6-style virtual users**: each of 100 VUs requests the board, waits, thinks a random 0.5–1.5 s, repeats (exactly how k6 scripts with `sleep()` model users).
- Ran everything with the API capped at 0.1 / 0.5 / 1.0 CPU:

| API CPU | ≈ host | 100 VUs p95 | Saturation p95 |
|---|---|---:|---:|
| 0.1 | Render Free | ❌ 8,048 ms | ❌ 997 ms |
| 0.5 | Render Starter | ✅ 20 ms | ❌ 300 ms |
| 1.0 | Railway vCPU | ✅ 12 ms | ✅ 157 ms |

- **Conclusion:** the requirement passes easily from 0.5 CPU; Render Free can't meet it under any model → deploy the API on Railway (1 vCPU) or Render Starter. All in `docs/LOADTEST.md` ("CPU sizing").
- **Interview Q: "What does 100 concurrent users mean in your test?"** → "Two models: 100 k6-style virtual users with think time (the realistic one — p95 12 ms on 1 vCPU), and 100 connections with zero think time (saturation — p95 ~150 ms on 1 vCPU, 91 ms on a full core). I also ran a synchronized burst as a stress test; that one needs horizontal scaling."

### Step 21 — Deploy guide
`docs/DEPLOY.md`: Render (API, Singapore) → Vercel (client, `VITE_API_URL`) → set `CLIENT_ORIGIN` → verify + deployed load test. Waiting on Pawan's Render/Vercel accounts.

---

## 4. Interview cheat sheet (say these out loud until they feel natural)

**"Walk me through what happens when 50 people click join on the last seat."**
Each request starts a MongoDB transaction. Inside it: (1) claim the person — update their Participant only if `teamId` is null; (2) take the seat — `findOneAndUpdate` on the Team only if `openSeats > 0`, decrementing it. All 50 transactions write the same Team document; MongoDB lets one commit and aborts the others with a WriteConflict. `withTransaction` retries them; on retry `openSeats` is 0, the conditional update matches nothing, and they get 409 TEAM_FULL. The race test fires 50 parallel requests and asserts exactly one 200 and 49 409s, and that the DB has exactly 4 members.

**"Why not just check the count, then insert?"**
Check-then-act is the classic race: two requests both read "1 seat left", both insert. The condition has to be *inside* the write so the database evaluates it atomically.

**"Why not a lock / Redis / a mutex?"**
An in-process mutex breaks with 2+ server instances. A distributed lock needs extra infra and can stay held if a process dies. Optimistic concurrency in the database needs nothing extra and the DB is already the source of truth.

**"Why do you need a transaction at all if the update is atomic?"**
A join touches several documents: Participant, Team, AuditLog, the user's other JoinRequests. The transaction makes them all-or-nothing — a crash can't leave "seat taken, person not in team". The chaos test kills the server mid-burst to prove it.

**"What's the downside of your approach?"**
Under heavy contention on one team, losers retry — more DB work and latency for that hot team. It's bounded (a team has ≤4 seats so it fills fast) and visible in `/metrics` (`txn_retries_total`).

**"How is it idempotent?"**
Two layers. (1) Client sends an `Idempotency-Key` per action and reuses it on retries; server inserts the key first (unique index), replays the stored response for a finished request, says 409 IN_PROGRESS for a running one. (2) Even without a key, the data model can't double-join: you need `teamId: null` to join.

**"What if the server crashes after committing but before saving the idempotency response?"**
The key stays "in_progress"; after 60 s it's treated as stale and the retry re-runs. Re-running a join finds `teamId` already set → ALREADY_IN_TEAM. No duplicate — that's why layer 2 exists.

**"How do live updates work? What if a message is lost?"**
Socket.io rooms per hackathon, per team (members only), per user. Events are emitted only after the transaction commits. On reconnect the client refetches everything over REST, so a lost event can't leave the screen wrong for long.

**"How do you stop invite-code brute force?"**
50 bits of randomness from `crypto.randomBytes` (1 quadrillion combos), only the SHA-256 hash stored, 10 attempts per 15 min per user, same error for "wrong" and "revoked". At 10 guesses / 15 min you'd need ~10^11 years.

**"How did you hit p95 < 200 ms?"**
Measured first. Baseline failed (1,059 ms) because Atlas free tier caps ~100 ops/s. Added a 1 s micro-cache with promise sharing → 146 ms. Then profiled: 50% of CPU was jsonwebtoken rebuilding the key every request → created the key once. Cached the serialized JSON. A realistic test then exposed a cache stampede → stale-while-revalidate. Final p95 91–95 ms.

**"Isn't caching wrong for a real-time board?"**
The cache is a read view, ≤1 s old. Writes never read it, they check inside the transaction. And changes are pushed over WebSockets instantly anyway.

**"Why MongoDB and not Postgres?"**
The challenge prefers it, and it handles this fine: single-document atomic conditional updates + multi-document transactions on a replica set. In Postgres I'd do the same with `UPDATE teams SET open_seats = open_seats - 1 WHERE id = $1 AND open_seats > 0` + a unique constraint on (hackathon, user).

**"How does the suggestion score work?"**
70% "what share of the team's missing skills do they have" (skills wanted minus skills members already have — duplicates score 0), 30% timezone closeness (1 − hours apart / 12, measured around the clock). Each result returns the breakdown.

**"What would break first at 10× scale?"**
Single API instance: Socket.io needs the Redis adapter to broadcast across instances, the in-memory caches/rate limits need Redis, and Atlas M0's ops/s limit. Code-wise the concurrency model already works across instances.

**"What would you do with one more week?"** — see `docs/DESIGN.md` §4: Redis adapter + horizontal scaling, finalize/lock teams before deadline, refresh tokens in httpOnly cookies, smarter suggestions, OpenTelemetry tracing.

**"What did AI do vs you?"** — Be honest: AI tools were used (allowed by the rules). Know every file: models → teamService → txn.js → idempotency → socket → board/suggestions → client api.js/state.jsx. Re-read this overview before the interview.

**Live-change practice (they will ask for a small change):** try these yourself before the interview:
1. Change max team size of the demo hackathon to 5 (seed / Hackathon doc) and watch seats update.
2. Add a new audit action, e.g. log `PROFILE_UPDATED` in `PATCH /auth/me`.
3. Change the suggestion weights to 60/40 in `suggestionService.js` and update the test.
4. Add a field "github URL" to the user profile (model → zod schema → route → Profile page).

---

## 5. Walkthrough video — draft script (≤ 5 min)

Setup before recording: deployed app open in 2 browser windows side by side (normal + incognito), a terminal in `server/`, the GitHub repo + Actions tab, `/health` opened once to wake Render.

| Time | Show | Say (roughly) |
|---|---|---|
| 0:00–0:20 | README on GitHub | "I picked Problem 1, race-proof team formation. React, Node/Express, MongoDB, Socket.io. Everything here is tested in CI." |
| 0:20–1:30 | Two browsers: A creates a team, generates a code; B joins with it → A's page updates instantly; B sends a request elsewhere; leader gets a toast and accepts | "Invite codes join instantly; requests need the leader. Notice I never refresh: updates are pushed over WebSockets, and only after the database transaction commits." |
| 1:30–2:40 | `teamService.js` → `addMemberInTxn`; `txn.js` | "The core idea: two conditional updates in one transaction: claim the person only if `teamId` is null, take the seat only if `openSeats > 0`. If 50 people race, MongoDB lets one transaction write the team document and aborts the others with a write conflict. They retry with backoff, see zero seats, and get TEAM_FULL." |
| 2:40–3:20 | Terminal: `TARGET=<prod> npm run race-demo` → `49 × TEAM_FULL, 1 × joined, integrity OK` | "This is 50 real users hitting the last seat on the deployed app right now. Exactly one wins, and the integrity checker confirms counts and leaders are consistent." |
| 3:20–3:50 | `/metrics` → `txn_retries_total`; mention the retry-storm story | "My first version used the driver's immediate retries: 1,010 retries for one race. Backoff with jitter and writing the hot document last brought it to 49." |
| 3:50–4:20 | Actions tab (all green) + `docs/LOADTEST.md` table | "40 API tests including race and chaos tests, plus 5 Playwright browser tests including accessibility. Board p95 is 95 ms with 100 users. It first failed at 1 second; profiling found JWT verification was half the CPU." |
| 4:20–4:50 | Phone-width window + Tab through the board | "Works on phones and with the keyboard alone. axe finds no serious violations." |
| 4:50–5:00 | `docs/DESIGN.md` §4 | "With another week: Redis adapter to scale out, team finalization, refresh tokens. Thanks!" |
