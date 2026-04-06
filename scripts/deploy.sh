#!/bin/bash
set -e

cd /opt/nyayasearch
git pull origin main
npm install
npm run build
pm2 restart nyayasearch
echo "Deployed successfully at $(date)"
