#!/bin/bash
# Set up weekly cron job to download and process new judgments
# Runs every Sunday at 2 AM

PIPELINE_DIR="$(cd "$(dirname "$0")" && pwd)"
CURRENT_YEAR=$(date +%Y)

# Add cron job
(crontab -l 2>/dev/null; echo "0 2 * * 0 cd $PIPELINE_DIR && python3 download_sc.py --year $CURRENT_YEAR && python3 process_and_load.py --source sc --year $CURRENT_YEAR >> /var/log/nyayasearch-pipeline.log 2>&1") | crontab -

echo "Cron job installed. It will run every Sunday at 2 AM."
echo "Check logs at /var/log/nyayasearch-pipeline.log"
