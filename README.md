# Agent Station

A small personal AI agent workspace. You give it a task from a web page (works on iPad), a Claude agent works through it using tools, and you can watch every step and see exactly what each run cost.

**Stage 1 (this version):** one agent, a job queue, four tools (web search, read a web page, save a note, read a note), a cost ledger, per-job and daily spending caps, and a stop button.

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
| `agent.js` | The agent loop, cost tracking, budget and step limits |
| `tools.js` | The tools. Add new ones here (copy an existing block) |
| `store.js` | The job ledger, saved to `data/jobs.json` |
| `config.js` | Reads settings from `.env`, model prices |
| `public/index.html` | The dashboard |
| `test/run-test.js` | End-to-end test against a fake Claude API (free, no key needed) |

No npm packages are needed, just Node 20 or newer.

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

2. Scheduled routines (for example, "every Monday, find new print trends")
3. Several agents passing work along conveyor-style workflows
4. The pixel-art station view
