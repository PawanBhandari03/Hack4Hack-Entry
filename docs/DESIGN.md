# Design: race-proof team formation

**Stack:** React + Vite · Node 22 / Express 5 · MongoDB (Atlas, replica set) · Socket.io · Vitest

## 1. Data model

| Collection | Key fields | Constraint that matters |
|---|---|---|
| `Hackathon` | `minTeamSize`, `maxTeamSize` | — |
| `User` | email, bcrypt hash, skills, IANA timezone (+ cached UTC offset) | `email` unique |
| `Participant` | one per (user, hackathon): **`teamId` (null = solo)**, `role`, `joinedTeamAt`, `lookingForTeam`, and copies of name, skills and timezone for the board | **unique `{hackathonId, userId}`** |
| `Team` | `leaderId`, `memberCount`, **`openSeats`**, `maxSize`, `skillsWanted` | unique `{hackathonId, nameKey}` |
| `Invite` | **SHA-256 hash** of the code, `expiresAt`, `revokedAt` | `codeHash` unique |
| `JoinRequest` | team, user, `status` | **partial unique `{teamId, userId}` where `status = pending`** |
| `AuditLog` | actor, action, target, details, `createdAt` | written in the same transaction as the change |
| `IdempotencyKey` | (user, key) → stored status and body | unique, TTL 24 h |

`openSeats` is stored rather than computed. That turns "check there is a seat, then take it" into **one atomic conditional update**.

## 2. How races are prevented

Every change runs inside a **MongoDB transaction** (`withTransaction`) built from **conditional single-document updates**:

```js
Participant.findOneAndUpdate({ hackathonId, userId, teamId: null }, { $set: { teamId } })        // claim the person
Team.findOneAndUpdate({ _id, openSeats: { $gt: 0 } }, { $inc: { openSeats: -1, memberCount: 1 } }) // take the seat
```

Fifty people race for the last seat. All 50 transactions write the same `Team` document. MongoDB commits one and aborts the rest with a **WriteConflict**. `withTransaction` retries each loser against fresh data, its condition `openSeats > 0` no longer matches, and it returns **409 `TEAM_FULL`**. One user joining 5 teams at once conflicts the same way, on their single `Participant` row (`ALREADY_IN_TEAM`). Leaves, kicks, accepts, leader transfer and deleting the team when the last member leaves all follow the same pattern. Because each operation is a single transaction, a crash can never leave a half-done join.

**Idempotency** has two layers:
1. The client sends one `Idempotency-Key` per user action. The server inserts the key *before* doing the work, then replays the stored response on a retry, or returns `409 REQUEST_IN_PROGRESS` while the original is still running.
2. As a backstop, the data model itself makes a second join impossible.

**Real-time:** services queue events, and `runTxn` publishes them **only after commit**. A rolled-back change is never broadcast. Clients refetch on reconnect.

**Proof:**
- 39 tests in CI, including races of 50 users on 1 seat, 10 accepts at once, 1 user joining 5 teams, 10 simultaneous creates, and all members leaving at once.
- A **chaos test** that SIGKILLs the server mid-burst (340 operations), restarts it, retries with the same keys, then runs an integrity checker (`npm run verify`). It found 0 violations.
- `/metrics` exposes `txn_retries_total`, a live count of races that were resolved safely.

## 3. Trade-offs

| Choice | Why | Cost |
|---|---|---|
| Optimistic concurrency (transactions + conditions), **not locks** | No Redis or lock service, no stuck locks after a crash, and it works with any number of API instances | Hot teams cause retries. The driver's immediate retries turned a 50-way race into **1,010 retries**. Our own loop with **jittered exponential backoff**, the hot document written last, and a full-team fast path cut that to **49** (one per loser). Visible in `/metrics`. |
| Denormalized `openSeats` and Participant copies | One atomic check; the board needs no joins | Profile edits must update the copies (one `updateMany`) |
| Invite code joins instantly; join request needs the leader | Codes are the leader's pre-approval | A leaked code lets anyone in until it's revoked (48 h expiry, one-click regenerate) |
| Codes: 50-bit random, stored hashed, 10 attempts per 15 min per user | Brute force becomes hopeless; a DB leak doesn't expose codes | The leader sees a code only once (regenerate to see a new one) |
| 1 s board cache with stale-while-revalidate | Atlas M0 allows about 100 ops/s; p95 went from 1,059 ms to **91–95 ms** | The board can be about 1 s stale. Writes never use the cache, and WebSockets push changes instantly. |
| Leader leaves → earliest-joined member becomes leader | Deterministic and fair; no vote needed | May not be the person the team would choose (manual transfer exists) |
| Formation deadline blocks create/join/request/accept, but **not** leave | Matches a real "team formation closes" cut-off without trapping people | Hackathon settings are cached for 30 s, so a deadline change takes ≤ 30 s to apply |
| Per-user anti-spam limits: 30 join requests / 15 min, 20 team creations / h | Stops one account flooding 2,000 leaders | In-memory per instance (needs Redis when scaled out) |
| Min size shown as "forming / meets minimum", not enforced on leave | Blocking people from leaving traps them | A team can drop below the minimum. Enforcement belongs at submission time. |
| Suggestions: `0.7 × missing-skill coverage + 0.3 × timezone closeness` | Explainable, cheap, and the breakdown is returned | Heuristic, not learned. Scans at most 500 candidates. |

## 4. With one more week

- Redis adapter for Socket.io plus horizontal scaling. Move the board cache to Redis, with invalidation on write.
- Finalize step: lock a team once it meets the minimum size before the deadline. Organizer dashboard with exports.
- Short-lived access tokens plus refresh tokens in httpOnly cookies, instead of a 7-day JWT in localStorage.
- Suggestions: weight by experience level and availability, and learn from accepted requests.
- Playwright end-to-end and axe accessibility tests in CI. OpenTelemetry tracing. Load test from k6 Cloud in-region.
