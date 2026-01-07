---
name: self-update
description: Update Clawdbot from git, rebuild, and restart. Use when user says /update or asks to update Clawdbot.
homepage: https://github.com/clawdbot/clawdbot
metadata: {"clawdbot":{"emoji":"🔄","os":["darwin","linux"]}}
---

# Self-Update

Update Clawdbot to the latest version from git.

## Trigger

Use when the user says:
- `/update`
- "update yourself"
- "pull latest"
- "upgrade clawdbot"

## Process

Run the update script:

```bash
/Users/phaedrus/Projects/clawdbot/skills/self-update/scripts/update.sh
```

The script will:
1. Stash any local changes
2. Pull latest from origin/main
3. Run `pnpm install` and `pnpm build`
4. Output a summary of changes (commits pulled)

After the script completes successfully, **restart the gateway**:

```javascript
gateway({ action: "restart", reason: "Self-update completed", delayMs: 2000 })
```

## Output

Report to the user:
- Number of commits pulled
- Summary of changes (from git log)
- Confirmation that gateway restarted

## Manual Update

If the script fails, manual steps:

```bash
cd /Users/phaedrus/Projects/clawdbot
git stash
git checkout main
git pull origin main
pnpm install
pnpm build
```

Then use the gateway tool to restart.
