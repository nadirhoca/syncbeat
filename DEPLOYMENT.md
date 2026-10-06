# Deploy SyncBeat to a Public URL

This guide walks you through publishing the **SyncBeat** application so it can be accessed from anywhere (not just `localhost`). The steps assume you have a GitHub repository containing the project.

---

## 1️⃣ Prerequisites
- **GitHub account** with a repository for the SyncBeat code.
- **Docker** installed locally (optional, for testing).
- An account on a cloud platform that supports Docker containers and WebSockets. Recommended free‑tier options:
  - **Render** – https://render.com
  - **Railway** – https://railway.app
  - **Fly.io** – https://fly.io

> **Why Docker?** All three platforms can automatically build a container from the `Dockerfile` we added. This guarantees the correct Node version (`node:20-alpine`) and a lightweight production image.

---

## 2️⃣ Push the Code to GitHub
```bash
# In your local syncbeat folder
git init
git add .
git commit -m "Initial commit – ready for public deployment"
# Replace <username>/<repo> with your own values
git remote add origin https://github.com/<username>/syncbeat.git
git push -u origin master
```
Make sure the repository includes the following files (they are already present):
- `Dockerfile` – builds the container.
- `README.md` – contains the quick‑start instructions and deployment options.
- `server.js`, `src/*`, `public/*` – core application code.

---

## 3️⃣ Deploy to Render (Docker)
1. Sign‑up / log‑in at **Render**.
2. Click **New → Web Service**.
3. Connect your GitHub repo and select the **Docker** environment.
4. Render will detect the `Dockerfile`. No additional build command is needed (Render uses `docker build`).
5. Set **Port** to `3000` (Render injects `$PORT` automatically). The service will be started with:
   ```bash
   docker run -p $PORT:3000 syncbeat
   ```
6. Click **Create Web Service**.
7. After the build finishes, Render provides a URL like `https://syncbeat.onrender.com`. It is served over HTTPS, which satisfies the YouTube IFrame autoplay requirements.

---

## 4️⃣ Deploy to Railway (Docker)
1. Log in to **Railway** and create a new **Project** → **Deploy from GitHub**.
2. Choose the SyncBeat repo and select **Dockerfile** as the build method.
3. Railway automatically assigns a `$PORT` environment variable; the Dockerfile’s `EXPOSE 3000` is sufficient.
4. Deploy – Railway will give you a public URL such as `https://syncbeat.up.railway.app` (HTTPS).

---

## 5️⃣ Deploy to Fly.io (Docker)
```bash
# Install Fly CLI (if not already installed)
curl -L https://fly.io/install.sh | sh
fly auth login
# Create the app in your desired region (e.g., iad)
fly launch
# During the wizard:
#   • Choose “Dockerfile” as the builder.
#   • Accept the generated fly.toml (it forwards port 80/443 to the container’s $PORT).
#   • When prompted, set the name (e.g., syncbeat).
# Deploy:
fly deploy
```
Fly will assign a subdomain like `https://syncbeat.fly.dev` with automatic TLS.

---

## 6️⃣ Post‑Deployment Checklist
- **Port handling** – `server.js` already uses `process.env.PORT || 3000`, so no code changes are needed.
- **WebSocket support** – All three platforms automatically upgrade the Socket.io connection to `wss://` when accessed via HTTPS.
- **YouTube IFrame `origin`** – The client uses `window.location.origin`, which works for any domain.
- **Persistence** – `data/rooms.json` lives inside the container. It will be reset on each redeploy. For production you may mount a volume or switch to a database, but the current setup is fine for demos.
- **CORS** – Socket.io is configured with `origin: '*'`. If you want tighter security, replace `'*'` in `server.js` with your deployed domain.

---

## 7️⃣ Running Locally (Optional) – Verify Docker Image
```bash
# Build the image locally
docker build -t syncbeat .
# Run exposing the platform‑provided port (default 3000)
# You can override with -e PORT=3000 if desired
docker run -p 3000:3000 syncbeat
```
Open `http://localhost:3000` to confirm everything works before pushing.

---

## 8️⃣ Quick Recap of Files Added/Modified
- **`Dockerfile`** – Container definition for cloud deployments.  
  [Dockerfile](file:///C:/Users/ender/.gemini/antigravity/scratch/syncbeat/Dockerfile)
- **`README.md`** – Contains the deployment guide you are reading now.  
  [README.md](file:///C:/Users/ender/.gemini/antigravity/scratch/syncbeat/README.md)
- No further code changes were required for production deployment; the server already respects `process.env.PORT` and the client uses relative URLs.

---

## 📣 Next Steps for You
1. Push the repository to GitHub (if not already done).
2. Choose a hosting provider (Render, Railway, or Fly.io) and follow the steps above.
3. Share the generated public URL with friends – they can now join rooms via `https://<your‑domain>/?room=<roomName>`.
4. (Optional) If you need persistent room state across restarts, consider mounting a volume (`/app/data`) or switching to a lightweight DB (e.g., SQLite or low‑cost NoSQL). You can add that later without affecting the core sync engine.

Enjoy synchronized listening! 🎧
