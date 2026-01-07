---
name: beads
description: Issue tracking with Beads (`bd` CLI). Use for creating, updating, closing issues, managing dependencies, and tracking work on development projects.
homepage: https://github.com/steveyegge/beads
metadata: {"clawdbot":{"emoji":"📿","requires":{"bins":["bd"]}}}
---

# Beads Issue Tracking

Beads is a git-native issue tracker designed for AI coding agents. Issues are stored in `.beads/` as JSONL files and tracked in git.

## Essential Commands

```bash
bd list                    # List all issues
bd list --status open      # Filter by status
bd list --status in_progress
bd ready                   # Show issues ready to work (no blockers)
bd show <id>               # Full issue details with dependencies
bd create --title="..." --type=task --priority=2
bd update <id> --status in_progress
bd close <id>              # Close an issue
bd close <id1> <id2>       # Close multiple issues
bd sync                    # Commit and push beads changes
```

## Issue Types

- `task` — A discrete piece of work
- `bug` — Something broken
- `feature` — New functionality
- `epic` — Collection of related tasks
- `question` — Needs clarification
- `docs` — Documentation work

## Priority Levels

Use numbers, not words:
- P0 = Critical
- P1 = High
- P2 = Medium (default)
- P3 = Low
- P4 = Backlog

## Dependencies

```bash
bd dep add <issue> <depends-on>   # issue depends on depends-on
bd dep rm <issue> <depends-on>    # Remove dependency
bd dep tree <issue>               # Visualize dependency tree
```

**Key concepts:**
- `bd ready` shows only issues with no open blockers
- An issue is blocked if it depends on an open issue

## Creating Issues

```bash
# Simple task
bd create --title="Fix login bug" --type=bug --priority=1

# With description
bd create --title="Add user auth" --type=feature \
  --description="Implement OAuth2 flow with Auth0"

# Epic with subtasks
bd create --title="Auth Epic" --type=epic
bd create --title="Setup Auth0" --type=task --parent=<epic-id>
bd create --title="Add login page" --type=task --parent=<epic-id>
```

## Parent vs Dependencies

- `--parent`: Structural relationship ("this task belongs to this epic")
- `bd dep add`: Execution order ("this task must wait for that task")

## Workflow Pattern

1. **Find work**: `bd ready` to see actionable issues
2. **Claim it**: `bd update <id> --status in_progress`
3. **Do the work**: Implement the fix/feature
4. **Close it**: `bd close <id>`
5. **Commit**: Reference the issue ID in your commit message
6. **Sync**: `bd sync` to commit beads changes

## Session Protocol

Before ending any coding session:

```bash
git status              # Check what changed
git add <files>         # Stage code changes
bd sync                 # Commit beads changes
git commit -m "..."     # Commit code with issue refs
bd sync                 # Commit any new beads changes
git push                # Push to remote
```

## Discovering Work During Development

When you discover bugs, tech debt, or improvements:

1. **Create an issue immediately**: `bd create --title="Found: X needs Y"`
2. **Link to relevant epic**: `bd update <id> --parent=<epic-id>`
3. **Continue current work**: Don't let discovered issues derail you
4. **Document enough context**: Someone else should understand the problem

## Viewing with bv (Beads Viewer)

For visual exploration, use `bv` (TUI) or robot mode for scripts:

```bash
bv                        # Interactive TUI (don't use in automated sessions)
bv --robot-triage         # JSON output for agents
bv --robot-next           # Single top pick
bv --robot-plan           # Parallel execution tracks
```

⚠️ **Never run bare `bv` from an agent** — it launches a TUI and blocks. Always use `--robot-*` flags.

## Best Practices

- Check `bd ready` at session start
- Update status as you work (open → in_progress → closed)
- Create issues when you discover problems
- Use descriptive titles and appropriate priority/type
- Always `bd sync` before ending a session
- Reference issue IDs in commit messages
