#!/usr/bin/env bash
set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

echo "🏒 Starting Fantasy Hockey Draft Game Theory Co-Pilot..."

# Ensure node modules exist
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install --silent
fi

# Run test verification
npm run test:quick --silent

echo "Launching web server on http://localhost:3333..."
(sleep 1 && open "http://localhost:3333") &
node server.js
