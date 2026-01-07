#!/bin/bash
# Self-update script for Clawdbot
# Pulls latest from main, rebuilds, outputs changelog

set -e

CLAWDBOT_DIR="/Users/phaedrus/Projects/clawdbot"
cd "$CLAWDBOT_DIR"

echo "=== Clawdbot Self-Update ==="
echo ""

# Get current commit before update
BEFORE_COMMIT=$(git rev-parse HEAD)
BEFORE_SHORT=$(git rev-parse --short HEAD)

# Stash any local changes
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "📦 Stashing local changes..."
    git stash --include-untracked -m "self-update $(date +%Y%m%d-%H%M%S)"
    STASHED=1
else
    STASHED=0
fi

# Make sure we're on main
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "main" ]; then
    echo "🔀 Switching to main branch..."
    git checkout main
fi

# Pull latest
echo "⬇️  Pulling from origin/main..."
git pull origin main --rebase 2>&1 || {
    echo "⚠️  Pull failed, trying without rebase..."
    git pull origin main
}

# Get new commit
AFTER_COMMIT=$(git rev-parse HEAD)
AFTER_SHORT=$(git rev-parse --short HEAD)

# Check if anything changed
if [ "$BEFORE_COMMIT" = "$AFTER_COMMIT" ]; then
    echo ""
    echo "✅ Already up to date ($AFTER_SHORT)"
    echo ""
    echo "COMMITS_PULLED=0"
    exit 0
fi

# Count commits pulled
COMMIT_COUNT=$(git rev-list --count $BEFORE_COMMIT..$AFTER_COMMIT 2>/dev/null || echo "?")

echo ""
echo "📋 Changes pulled ($COMMIT_COUNT commits):"
echo "---"
git log --oneline $BEFORE_COMMIT..$AFTER_COMMIT 2>/dev/null | head -20
echo "---"
echo ""

# Install dependencies
echo "📦 Installing dependencies..."
pnpm install --prefer-offline 2>&1 | tail -5

# Build
echo "🔨 Building..."
pnpm build 2>&1 | tail -3

echo ""
echo "✅ Update complete: $BEFORE_SHORT → $AFTER_SHORT ($COMMIT_COUNT commits)"
echo ""
echo "COMMITS_PULLED=$COMMIT_COUNT"
echo "BEFORE=$BEFORE_SHORT"
echo "AFTER=$AFTER_SHORT"
