# Agent Station

A small personal AI agent workspace. You give it a task from a web page (works on iPad), a Claude agent works through it using tools, and you can watch every step and see exactly what each run cost.

**Stage 1:** one agent, a job queue, four tools (web search, read a web page, save a note, read a note), a cost ledger, per-job and daily spending caps, and a stop button.

**Stage 2 (Studio):** a design pipeline for the Etsy print shop.

```
trends note ──► Designer (Claude) writes briefs + image prompts
                    │
                    ▼
               Image model (Google Nano Banana 2, 2K) draws each one
                    │
                    ▼
               Judge (a separate Claude, sees full view + full-res crop)
               scores quality / sellability / originality, checks text and IP risk
                    │
          pass ◄────┼────► revise: designer rewrites prompt, redraw (once)
                    │
                    ▼
               reject (weak concept or brand/character risk)
```

A design passes only if the judge says pass, quality and sellability are at least `JUDGE_MIN_SCORE` (default 7), originality is at least `JUDGE_MIN_ORIGINALITY` (default 6), there are no text problems, and IP risk is "none". Passed designs wait in the Studio tab, ready for listing (stage 3).

## How it works

```
iPad dashboard  ──►  server.js (API + job queue)  ──►  agent.js (the loop)
                                                       │  ask Claude
                                                       │  run the tools it asks for
                                                       │  send results back, repeat
                                                       ▼
                                          tools.js  ·  store.js (data/jobs.json)
```

| File | What it does |
|---|---|
| `server.js` | Serves the dashboard and the API, runs one job at a time |
| `agent.js` | The agent loop, budget and step limits; hands design jobs to the Studio |
| `claude.js` | Calls the Claude API and adds up costs |
| `studio.js` | Designer and judge prompts, the draw → judge → revise loop |
| `images.js` | Google image generation and resizing (thumbnails, judge previews) |
| `tools.js` | The agent's tools. Add new ones here (copy an existing block) |
| `store.js` | Job ledger (`data/jobs.json`) and designs (`data/designs.json`, images in `data/designs/`) |
| `config.js` | Reads settings from `.env`, model prices |
| `public/index.html` | The dashboard |
| `test/` | End-to-end tests against fake Claude and Google APIs (free, no keys needed) |

Needs Node 20 or newer and one package, `sharp` (image resizing): run `npm install` after cloning or pulling.

## Set up on the Google Cloud VM (from the iPad)

You'll need a Claude API key: go to https://platform.claude.com, add some credit (a few dollars is plenty to start), and create a key under API keys. This is billed separately from a Claude.ai subscription.

**1. Open a terminal on the VM.** In the Google Cloud console (Safari is fine), go to Compute Engine → VM instances and press **SSH** next to `gold-bot-vm`.

**2. Install Node 20 and git** (skip if `node -v` already shows v20 or newer):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

**3. Get the code:**

```bash
cd ~
git clone https://github.com/craigcam18-spec/agent-station.git
cd agent-station
npm test
```

You should see "All tests passed."

**4. Add your settings:**

```bash
cp .env.example .env
nano .env
```

Paste your API key and pick a dashboard password. Save with Ctrl+O, Enter, then exit with Ctrl+X.

**5. Run it as a service** so it starts on boot and restarts if it crashes:

```bash
sudo cp agent-station.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agent-station
systemctl status agent-station
```

**6. Reach it from your iPad with Tailscale.** This gives you a private, encrypted link to the VM without opening it up to the whole internet.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

Open the login link it prints and sign in. Then install the Tailscale app on your iPad, sign in with the same account, and open:

```
http://gold-bot-vm:8787
```

(If that name doesn't work, use the `100.x.x.x` address from `tailscale ip -4`.) In Safari, Share → Add to Home Screen makes it feel like an app.

## Turn on the Studio (Google image generation)

The Studio draws images with Google's models on Vertex AI, billed to the Google Cloud project (so the free trial credit covers it). The VM logs in to Google as itself, so there are no extra keys, but it needs two switches flipped in the Google Cloud console:

**1. Enable the API.** Search the console for **Vertex AI API** and press **Enable**.

**2. Let the VM use it.** The VM's default "access scopes" block AI APIs. Changing them needs the VM stopped for a minute, which pauses the trading bot too.
- Compute Engine → VM instances → `gold-bot-vm` → **Stop**, and wait until it shows stopped
- **Edit** → Security and access → **Access scopes** → choose **Allow full access to all Cloud APIs** → **Save**
- **Start** the VM

Agent Station and Tailscale start again by themselves. Check the trading bot came back too.

**3. Update the code** (SSH in again):

```bash
cd ~/agent-station && git pull && npm install && npm test && sudo systemctl restart agent-station
```

If a design run fails with a permissions message, add the role **Vertex AI User** to the VM's service account (IAM & Admin → IAM → the account ending `compute@developer.gserviceaccount.com` → edit → add role).

Studio settings in `.env` (all optional):

| Setting | Default | What it does |
|---|---|---|
| `IMAGE_MODEL` | `gemini-3.1-flash-image` | `gemini-nano-banana-2.1` is cheaper; `gemini-3-pro-image` is the top model |
| `IMAGE_SIZE` | `2K` | `1K`, `2K` or `4K`. 4K costs more but prints larger |
| `DESIGN_RUN_BUDGET_USD` | `2.00` | A design run stops once it has spent this |
| `MAX_DESIGNS_PER_RUN` | `6` | Most designs in one run |
| `MAX_REVISIONS` | `1` | Redraws allowed after the judge says revise |
| `JUDGE_MIN_SCORE` | `7` | Lowest print quality and sellability score that can pass |
| `JUDGE_MIN_ORIGINALITY` | `6` | Lowest originality score that can pass (trend-led designs rarely get 7+) |

Image cost per picture (Google's prices): Nano Banana 2 is about $0.07 at 1K, $0.10 at 2K and $0.15 at 4K. With Claude's designer and judge on top, a design costs roughly $0.13 to $0.26 depending on whether it needs a redraw. Image costs come out of the Google credit, Claude costs out of the Anthropic credit, and the dashboard shows both together.

## Useful commands

```bash
journalctl -u agent-station -f        # live logs
sudo systemctl restart agent-station  # restart after changing .env or pulling new code
cd ~/agent-station && git pull         # get the latest version
```

## Costs

Every job shows its real cost from the token counts the API reports. With the default `claude-sonnet-5-5`, a typical research task with a couple of searches costs roughly 5–15 cents (search results count as input tokens). Switch `MODEL` to `claude-haiku-5-5` in `.env` for simple tasks at a fraction of that.

Safety limits (change in `.env`):
- `JOB_BUDGET_USD`: a job stops once it has spent this much (default $0.50)
- `DAILY_BUDGET_USD`: no new steps run once today's total hits this (default $2.00)
- `MAX_STEPS`: most tool-use rounds per job (default 15)

## Next stages

3. Lister: titles, tags and descriptions, then publish to Etsy through Printify
4. Scheduled routines (for example, "every Monday, refresh trends and make a batch")
5. The pixel-art station view
