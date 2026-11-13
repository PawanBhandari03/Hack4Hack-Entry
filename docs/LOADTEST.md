# Load-test report — "looking for teammates" board

**Requirement:** p95 < 200 ms on the board endpoint with 100 concurrent users.
**Result:** ✅ met in every final run. The best result was **p95 = 91 ms at 2,711 req/s**, with 0 errors.

| | |
|---|---|
| Endpoint | `GET /api/hackathons/:id/board/teams?limit=20` (authenticated, JWT) |
| Data | Seeded: 10,000 users, 2,000 teams, 4,933 solo participants (`npm run seed`) |
| Tool | [autocannon](https://github.com/mcollina/autocannon) via `server/scripts/loadtest.js`. autocannon doesn't report p95, so the script records **every** response time and computes exact percentiles. |
| Command | `TARGET=http://localhost:4000 npm run loadtest` |
| Raw results | [`docs/loadtest/*.json`](loadtest/) |

## The three runs (each 20 s, 100 connections)

1. **Realistic.** 100 users, each refreshing the board twice per second (200 req/s total).
2. **Saturation.** 100 connections firing back-to-back with zero think time, page 1 only. This is the worst case.
3. **Saturation mix.** Page 1, page 2 (cursor), the People tab and a skill filter, in rotation.

## Final results

**A. API on a laptop (Node 22), database on MongoDB Atlas M0, AWS Mumbai**: [4-final-local-atlas.json](loadtest/4-final-local-atlas.json)

| Run | Requests | Req/s | p50 | p90 | **p95** | p99 | Non-200 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Realistic 100 × 2 req/s | 4,000 | 200 | 48 ms | 79 ms | **95 ms** | 144 ms | 0 |
| Saturation, page 1 | 54,205 | 2,711 | 29 ms | 76 ms | **91 ms** | 121 ms | 0 |
| Saturation mix | 46,974 | 2,349 | 32 ms | 87 ms | **109 ms** | 179 ms | 0 |

**B. Fully offline `docker compose up` (Mongo 7 single-node replica set in Docker)**: [5-docker-compose-local-mongo.json](loadtest/5-docker-compose-local-mongo.json)

| Run | Requests | Req/s | p50 | p90 | **p95** | p99 | Non-200 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Realistic 100 × 2 req/s | 2,024 | 202 | 71 ms | 135 ms | **171 ms** | 325 ms | 0 |
| Saturation, page 1 | 15,203 | 1,520 | 52 ms | 80 ms | **104 ms** | 143 ms | 0 |
| Saturation mix | 14,882 | 1,488 | 58 ms | 90 ms | **106 ms** | 198 ms | 0 |

These were 10 s runs, with Docker Desktop's VM sharing the laptop's CPU with the load generator.

**C. Pre-deploy simulation of Render's FREE instance (0.1 CPU, 512 MB)** with `docker-compose.render-sim.yml`: ❌ [6-render-free-simulation-0.1cpu-FAILED.json](loadtest/6-render-free-simulation-0.1cpu-FAILED.json)

| Run | Req/s | p50 | **p95** | Timeouts |
|---|---:|---:|---:|---:|
| Realistic 100 × 2 req/s | 46 | 603 ms | **1,392 ms** | 128 |
| Saturation, page 1 | 42 | 298 ms | **1,493 ms** | 154 |

Diagnosis: even the trivial `/health` endpoint only manages about 90–100 req/s at 0.1 CPU, with p97.5 above 2 s, because of CPU throttling. One-tenth of a CPU can't serve 100 concurrent users at p95 < 200 ms whatever the code does. **Decision:** host the API on an instance with at least ~0.5–1 vCPU (Railway shared vCPU, or Render Starter) rather than Render free. See [DEPLOY.md](DEPLOY.md).

**D. Deployed:** *to be added after deployment.*

Caveat: in A and B the load generator ran on the same machine as the API, so the two competed for CPU. The numbers are therefore pessimistic for the server, but they include no internet round-trip.

## How we got there (including the failures)

| # | Change | Result |
|---|---|---|
| 1 | Baseline: indexed, `.lean()` query with projection and cursor pagination | ❌ **p95 1,059 ms, 113 req/s** ([json](loadtest/1-before-caching-FAILED.json)) |
| | **Diagnosis:** `/health` served 4,900 req/s, so Node was not the limit. The free Atlas tier (M0) is throttled to about 100 ops/s, and every board request made a DB call. | |
| 2 | Cache hackathon settings for 30 s. Cache board pages for 1 s, caching the *promise* so concurrent misses share one query. | ✅ p95 146 ms, 1,035 req/s ([json](loadtest/2-after-caching.json)) |
| 3 | CPU profile (Node inspector): **~50% of CPU was in `jsonwebtoken`**, which rebuilt a crypto key from the secret string on every request (it tried `createPublicKey` first). Fixed by building the `KeyObject` once and pinning HS256. | 743 → 1,340 req/s (profiler run) |
| 4 | Next hotspot: `JSON.stringify`. The serialized JSON string is now cached. | 1,340 → 2,134 req/s (profiler run) |
| 5 | Added the *realistic* run. ❌ **p95 236 ms**, worse than saturation. **Diagnosis:** cache stampede. Users arrive in bursts, and whenever the 1 s entry had expired, the whole burst waited on the same Atlas query. | ([json](loadtest/3-realistic-run-FAILED-cache-stampede.json)) |
| 6 | **Stale-while-revalidate:** an entry 1–10 s old is served instantly while ONE background query refreshes it. | ✅ final results above |

## Why caching doesn't weaken correctness

- The cache is a **read view only**. Joins, leaves and accepts never read it. They check `openSeats` inside a MongoDB transaction (see [DESIGN.md](DESIGN.md)).
- Board data is at most about 1 s old under traffic, or up to 10 s right after an idle period. Every change is also pushed to clients over WebSockets immediately.

## Known limits

- **Atlas M0 caps DB-bound endpoints** (e.g. `/api/auth/me`) at about 100 req/s. A paid tier (M10+) removes this. It's an infrastructure limit, not a code one.
- **Render free tier = 0.1 CPU,** which is too little for the target (see §C). For real traffic, use at least one full vCPU and run 2+ instances behind the load balancer. The cache is per instance, which is fine at this TTL. Socket.io would then need the Redis adapter.
