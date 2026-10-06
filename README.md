# SyncBeat

**SyncBeat** – A full‑stack, real‑time synchronized music room web application built with **Node.js**, **Express**, **Socket.io**, and the **YouTube IFrame Player API**.

---

## Quick Start (Local Development)
```bash
npm install      # install dependencies
npm start        # start the server (listens on PORT env or 3000)
```
Open `http://localhost:3000` in a browser.

---

## Deploying to a Public URL
The application is ready to be deployed on any platform that can run a **Node.js** server and supports **WebSockets** (required for Socket.io). Below are three popular, free‑tier options.

### 1️⃣ Deploy with **Render** (Docker)
1. **Push the code to a GitHub repository** (or any Git provider). 
2. Sign‑up at https://render.com and click **New → Web Service**.
3. Connect your repository and select the **Docker** environment.
4. Render automatically detects the `Dockerfile` you now have in the project root.
5. Set the **Build Command** to `docker build -t syncbeat .` (Render sets this for you) and the **Start Command** to `docker run -p $PORT:3000 syncbeat` – the platform injects the `$PORT` variable.
6. Click **Create Web Service**. Render will build the image, launch the container and give you a public `https://<service>.onrender.com` URL.
7. **HTTPS** is provided automatically, and the YouTube IFrame Player API works out‑of‑the‑box.

### 2️⃣ Deploy with **Railway** (Docker or Node)
1. Fork/push the repository to GitHub.
2. Go to https://railway.app and create a new **Project** → **Deploy from GitHub**.
3. Choose the repo and select **Dockerfile** as the deployment method. Railway will read the `Dockerfile` and build the image.
4. Ensure the **Port** variable is set to `3000` (Railway auto‑assigns a `$PORT` env var; the Dockerfile `EXPOSE 3000` is sufficient).
5. Deploy – Railway provides a public URL like `https://syncbeat.up.railway.app` with TLS.

### 3️⃣ Deploy with **Fly.io** (Docker)
```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh
fly auth login
fly launch   # in the project directory (it will detect Dockerfile)
```
During `fly launch`:
- Choose a region close to your audience.
- Accept the auto‑generated `fly.toml`. It already sets `[[services]]` to expose port `80`/`443` and forwards to the container's `PORT`.
- When the app is launched, Fly gives you a subdomain like `syncbeat.fly.dev` (HTTPS enabled).

---

## Post‑Deployment Checklist
- **Port**: The server reads `process.env.PORT` (already in `server.js`). No code changes are required.
- **WebSocket Upgrade**: All platforms above support `wss://` automatically. Ensure you open the site with `https://`; the Socket.io client will use the same origin and upgrade to `wss`.
- **YouTube IFrame Origin**: The client uses `window.location.origin` for the YouTube player, which works for any domain (including the generated HTTPS URLs).
- **CORS**: Socket.io is configured with `origin: '*'`. If you prefer tighter security, replace `'*'` with your deployed domain.
- **Persistence**: Room state is stored in `data/rooms.json`. In containerised environments this file is **ephemeral** – it will be lost on each redeploy. For a production‑grade setup you would mount a persistent volume or switch to a DB. The current implementation works fine for demo / low‑traffic use.
- **Environment Variables** (optional):
  - `NODE_ENV=production` (set automatically in the Dockerfile).
  - `PORT` – injected by the hosting platform.

---

## Frequently Asked Questions
| Question | Answer |
|---|---|
| **Why does the app need a Dockerfile?** | Platforms like Render, Railway, and Fly.io build containers from a Dockerfile, guaranteeing the exact Node version (`node:20-alpine`) and installing only production dependencies. |
| **Can I deploy without Docker?** | Yes – services like **Vercel** or **Heroku** can run the `npm start` script directly. For Vercel you would need a `vercel.json` that proxies WebSocket traffic, which is more involved. Docker is the simplest cross‑platform route. |
| **What about HTTPS and autoplay?** | Modern browsers only allow unmuted autoplay after a user gesture. The client code already starts the YouTube player muted and unmutes after the **Audio Unlock** banner click, which works on any HTTPS site. |
| **How to change the rate‑limiting settings?** | Edit `src/rateLimiter.js` – the constructor receives `maxActions` and `windowMs`. The defaults (2 actions / 15 s) are already in `server.js`. |

---

## TL;DR Deployment Commands (Docker)
```bash
# Build the container locally (optional, for testing)
docker build -t syncbeat .
# Run exposing the required port (Render/Railway/Fly will do this automatically)
docker run -p 3000:3000 syncbeat
```
Visit `http://localhost:3000` or the public URL provided by your chosen host.

---

Enjoy your synchronized music rooms! 🎧
