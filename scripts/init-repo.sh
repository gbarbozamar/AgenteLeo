#!/bin/bash
# OpenClaw — Git init + first commit
#
# Usage:
#   chmod +x scripts/init-repo.sh
#   ./scripts/init-repo.sh
#
# Run this once from the OpenClaw project root, before the first push to Railway.

set -e

echo "🚀 OpenClaw — Git init + first commit"

# Check we're in the right directory
if [ ! -f "package.json" ]; then
  echo "❌ Must be run from OpenClaw root"
  exit 1
fi

# Check git not already initialized
if [ -d ".git" ]; then
  echo "⚠️  Git already initialized — skipping init"
else
  git init
  git branch -M main
fi

# Pre-deploy check
echo "Running pre-deploy checks..."
node scripts/pre-deploy-check.mjs

echo ""
echo "Staging files..."
git add .gitignore .env.example README.md DEPLOY-RAILWAY.md Dockerfile railway.json package.json package-lock.json src/ scripts/

echo ""
echo "Files to be committed:"
git diff --cached --name-only
echo ""

read -p "Commit? [y/N] " CONFIRM
if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "Aborted."
  exit 0
fi

git commit -m "Initial OpenClaw scaffold — MCP server wrapping WhatsApp via Baileys"

echo ""
echo "✅ Committed. Next steps:"
echo "  1. Create repo on GitHub: https://github.com/new (suggested name: openclaw)"
echo "  2. Add remote:  git remote add origin https://github.com/<user>/openclaw.git"
echo "  3. Push:        git push -u origin main"
echo "  4. Go to Railway and deploy from the GitHub repo"
echo "  5. See DEPLOY-RAILWAY.md for the full checklist"
