#!/bin/sh
cd "$(dirname "$0")" || exit 1
if [ ! -f .env ]; then
  echo 'Create .env from .env.example, then change TEACHER_PASSWORD.'
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js LTS from nodejs.org first.'
  exit 1
fi
node server.js
