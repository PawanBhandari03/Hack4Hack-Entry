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
