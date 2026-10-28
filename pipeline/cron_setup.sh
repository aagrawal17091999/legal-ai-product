#!/bin/bash
# RETIRED. This used to install a weekly crontab entry running
# download_sc.py + process_and_load.py for the current year. It never picked up
# anything new: download_sc.py skips a year whose files are already on disk, and
# upstream rewrites those same files in place. It also stopped before extraction
# and embedding, so even a loaded row never became searchable.
#
# The replacement is the nyayasearch-sync-sc systemd timer (pipeline/sync_sc.py
# via scripts/sync-sc.sh). See pipeline/PIPELINE.md, "Cron / Automation".
#
# If you installed the old entry, remove it: crontab -e, delete the download_sc line.

echo "pipeline/cron_setup.sh is retired; install deploy/systemd/nyayasearch-sync-sc.* instead." >&2
echo "See pipeline/PIPELINE.md, 'Cron / Automation'." >&2
exit 1
