# Deploy guide (Railway or Render for the API, Vercel for the UI, Atlas for the DB)

Total time: about 15 minutes. The order matters: deploy the API first, because the frontend needs its URL baked in at build time.

> **Why not Render's free tier for the API?** It gives 0.1 CPU. A simulation with exactly that limit (`docker-compose.render-sim.yml`) failed the load test: p95 about 1.4 s, with even `/health` capped near 100 req/s. See [LOADTEST.md](LOADTEST.md) §C. The API needs roughly 0.5–1 vCPU: **Railway** (shared vCPU, Singapore region, trial credit) or **Render Starter**.

## 0. Atlas
- Current cluster: AWS Mumbai (ap-south-1). Network Access includes `0.0.0.0/0`.
- **Recommended: put the database in the same region as the API.**
  - A join makes about 10 sequential DB round-trips. Singapore ↔ Mumbai adds roughly 50–60 ms each, so about 0.5 s per join, versus 1–2 ms in the same region.
  - Board reads are cached, so they aren't affected much.
  - If the API goes to Railway or Render in **Singapore**, create a free M0 cluster in **AWS Singapore (ap-southeast-1)** under the same project, then run `npm run seed` against it (about 70 s).
  - Alternatively, keep Mumbai and accept slower writes. Note it in the load-test report.
- Connection string format: `mongodb+srv://<user>:<password>@cluster0.v6elg4f.mongodb.net/hack4hack?retryWrites=true&w=majority`

## 1a. API on Railway (recommended)
1. railway.app → **New Project → Deploy from GitHub repo**, then pick `Hack4Hack-Entry`.
2. Service **Settings**:
   - **Root Directory** `/server`
   - Start command `npm start` (auto-detected)
   - **Region:** Southeast Asia (Singapore), the closest to Atlas Mumbai
3. **Variables:**
   | Key | Value |
   |---|---|
   | `MONGODB_URI` | the Atlas string (with the real password) |
   | `JWT_SECRET` | a long random string |
   | `CLIENT_ORIGIN` | `http://localhost:5173` for now; updated in step 3 |
   | `NODE_ENV` | `production` |

   Railway injects `PORT` itself, and the server reads it.
4. **Networking → Generate Domain.** Then check `https://<api>.up.railway.app/health`, which should return `{"ok":true}`.

## 1b. API on Render (alternative; use the Starter plan, not Free)
- **New → Blueprint** on this repo (`render.yaml`), or create a Web Service manually:
  - Root `server`
  - Build `npm ci --omit=dev`
  - Start `npm start`
  - Region **Singapore**
  - Health check `/health`
- Set the same variables as above.

## 2. Frontend on Vercel
1. vercel.com → **Add New → Project**, then import `Hack4Hack-Entry`.
2. Settings:
   - **Root Directory:** `client`
   - Framework: Vite
   - Build `npm run build`
   - Output `dist`
3. Environment variable: `VITE_API_URL` = the API URL from step 1 (no trailing slash).
4. Deploy. `client/vercel.json` already rewrites deep links such as `/teams/123` to `index.html`.

## 3. Connect them
- Set the API's `CLIENT_ORIGIN` = `https://<app>.vercel.app,http://localhost:5173`, then redeploy or restart.

## 4. Post-deploy checklist
- [ ] **Smoke test** (read-only, about 5 s). It checks health, login, the board, CORS for the Vercel origin and a real WebSocket subscription:
  ```bash
  cd server
  TARGET=https://<api> ORIGIN=https://<app>.vercel.app npm run smoke
  ```
- [ ] Open the Vercel URL and log in as `demo1@hack4hack.dev` / `password123`. The green "live" dot in the header means the WebSocket connected.
- [ ] **Rate limits behind the proxy:** log in, then check that `/metrics` and the logs don't show every user sharing one IP bucket. If reviewers using demo accounts hit `429` on login, the proxy hop count in `app.set('trust proxy', 1)` (`server/src/app.js`) needs adjusting.
- [ ] Deployed load test, then fill in `docs/LOADTEST.md` §D with whatever the result is:
  ```bash
  cd server
  TARGET=https://<api> npm run loadtest
  ```
- [ ] Live race demo (also good for the video):
  ```bash
  cd server
  TARGET=https://<api> npm run race-demo
  ```
  This needs `server/.env` pointing at the same Atlas DB and the same `JWT_SECRET` as the deployment.
- [ ] Time a single join in production. If writes feel slow (API region ↔ Mumbai round-trips), consider putting the API in Mumbai/India if the host offers it.
- [ ] Put the live URLs at the top of `README.md`.

## Notes
- Node is pinned to `22.x` in `server/package.json` (`engines`), the version CI tests on. Railway and Render both read it.
- Build with dev dependencies left out (`NODE_ENV=production` makes npm skip them; Render uses `npm ci --omit=dev`). Otherwise `mongodb-memory-server`, which is only used by the tests, downloads a ~600 MB MongoDB binary during the build. If a host insists on installing dev deps, set `MONGOMS_DISABLE_POSTINSTALL=1`.
- `npm run seed` wipes the database. Never run it against Atlas after reviewers start using the app.
- Free/sleeping instances take 30–50 s to wake up. Open `/health` before a demo.
