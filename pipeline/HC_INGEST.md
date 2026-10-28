# High Court ingestion runbook

`pipeline/ingest_hc.py` loads High Court judgments from the public
[`s3://indian-high-court-judgments`](https://github.com/vanga/indian-high-court-judgments)
dataset (eCourts judgment portal, CC-BY-4.0, synced daily upstream) into
`high_court_cases`, in batches whose cost is recorded before the next one runs.

It replaces the HC path of `download_hc.py` + `process_and_load.py --source hc`,
which took only the first bench of each court, only `data.tar` (recent data is
in `part-*.tar`), used a wrong court-code table, and could not tell a garbled
text layer from a real one.

## What a batch does

1. **Select** the N newest documents not yet loaded, from the manifest — a
   SQLite list of every upstream PDF at `data/high-courts/manifest.sqlite`
   (~19M rows, ~2.4 GB, built once, refreshed incrementally).
2. **Text**, decided per page (`hc_text.py`):
   - clean text layer → used as is (96% of documents);
   - garbled layer (broken font encoding, `!"#$%`), broken-Unicode Hindi, or
     image scan → **free** Tesseract OCR at 300 dpi, in English; a page that
     reads weakly is retried with the court's regional language (Kannada for
     Karnataka, Tamil for Madras, …) and that reading kept only if the page
     really is in that script;
   - a scan with a hidden upstream OCR layer → re-OCR'd, better text kept.
   Pages the free OCR reads poorly (word confidence < 70, or English that
   doesn't read like English) are recorded in `poor_pages` and the document is
   flagged `needs_second_pass`.
3. **Load** one `high_court_cases` row per PDF, with `text_source`,
   `text_class`, `ocr_confidence`, `page_count`. `pdf_url` is the public
   upstream URL (no R2 copy of 1.5 TB).
4. **Fields**: from upstream metadata for every row (case number, parties,
   judges, outcome — free); Claude Haiku for documents of ≥ `HC_LLM_MIN_PAGES`
   (5) pages.
5. **Embed** voyage-law-2 chunks for every document with ≥ `HC_EMBED_MIN_CHARS`
   (500) characters of text — short orders included, since a one-page bail or
   quashing order carries reasoning. Only ~2.4% of documents fall below 500
   characters ("list after two weeks").

   Connected matters decided together share one judgment, and upstream stores a
   copy under each case number (15-18% of recent documents). Each copy gets its
   own row, but only the first is embedded and read by Haiku; the others carry
   `duplicate_of` and share its content fields.
6. **Record** counts, OCR quality and exact API cost in `hc_ingest_batches`,
   and print a report.

`second-pass` re-reads only the flagged pages with Claude vision (page images,
never the garbled layer), under a dollar cap, then re-extracts and re-embeds.

**Every Claude call goes through the Message Batches API** (half price;
results in 2-3 minutes in testing, up to 24 h allowed). A failed request is
retried once in a follow-up batch, never as a full-price call. Embeddings stay
on Voyage's standard endpoint: voyage-law-2 is not offered on Voyage's batch
API, and the HC chunks must share the SC corpus's model.

Nothing is visible to users until `HC_SEARCH_ENABLED=on` (see below).

## First-time setup on the box

```bash
# as root
apt-get install -y tesseract-ocr tesseract-ocr-eng tesseract-ocr-hin tesseract-ocr-kan tesseract-ocr-tam tesseract-ocr-tel tesseract-ocr-mal tesseract-ocr-ben tesseract-ocr-guj tesseract-ocr-mar tesseract-ocr-ori tesseract-ocr-pan tesseract-ocr-urd tesseract-ocr-asm tesseract-ocr-nep
cd /opt/legal-ai-product      # after scripts/deploy.sh has shipped migration 037
# User= in the shipped units is rewritten to root, the box's run user (there is
# no deploy user), exactly as bootstrap-box.sh does for every other unit.
for f in nyayasearch-hc-batch@.service nyayasearch-sync-hc.service; do
  sed "s#^User=.*#User=root#" deploy/systemd/$f > /etc/systemd/system/$f
done
cp deploy/systemd/nyayasearch-sync-hc.timer /etc/systemd/system/
systemctl daemon-reload

# build the manifest once (28 min on a laptop before the bulk-load
# speedups; expect 15-40 min on the box; ~2.4 GB on disk)
cd /opt/legal-ai-product && ENV_FILE=.env.production.local bash scripts/hc-ingest.sh manifest
# optional: measure free-OCR accuracy on this box (~5 min, writes nothing)
ENV_FILE=.env.production.local bash scripts/hc-ingest.sh calibrate --n 40
```

## Running batches

```bash
sudo systemctl start nyayasearch-hc-batch@1000            # next 1,000 newest; detached
journalctl -u nyayasearch-hc-batch@1000 -f                # watch
journalctl -u nyayasearch-hc-batch@1000 | grep -A10 '=== HC batch'   # its cost report

# overall picture: loaded, flagged, spent, projection for the whole corpus
cd /opt/legal-ai-product && ENV_FILE=.env.production.local bash scripts/hc-ingest.sh status
# a batch's report plus 5 random OCR'd excerpts to eyeball
ENV_FILE=.env.production.local bash scripts/hc-ingest.sh report --samples 5
```

The unit name carries the size: `@500`, `@5000` work too. One run at a time:
a second start (or the weekly sync) exits with "lock held".

Other selections, run by hand from `/opt/legal-ai-product` with `ENV_FILE=.env.production.local`:

```bash
bash scripts/hc-ingest.sh batch --size 200 --court 29_3       # Karnataka only
bash scripts/hc-ingest.sh batch --size 1000 --since 2025-01-01
bash scripts/hc-ingest.sh batch --size 1000 --no-llm          # skip Haiku fields
bash scripts/hc-ingest.sh batch --size 1000 --dry-run         # what would be picked
```

## Second pass (paid OCR)

```bash
bash scripts/hc-ingest.sh second-pass --limit 200 --max-cost-usd 5
```

Model: `HC_PAID_OCR_MODEL` (default `claude-haiku-4-5-20251001`), one Message
Batch per run. Pages are planned until the estimated cost reaches the cap; the
rest stay flagged for the next run, as does any document whose request failed.

## Weekly sync

Enable once a few batches look right:

```bash
sudo systemctl enable --now nyayasearch-sync-hc.timer      # Sundays 05:00
```

It refreshes the manifest (only the upstream folders that changed) and loads
documents decided in the last 120 days that aren't loaded, newest first, at
most 40,000 per run. Newest-first is also the backfill order, so the two never
conflict: until the backfill reaches the present, sync is just "the next batch".

## Making it visible

`HC_SEARCH_ENABLED=on` in `.env.production.local`, then
`pm2 reload nyayasearch --update-env`. Until then High Court rows stay out of
search, chat retrieval and the filter dropdowns. Change the "Supreme Court
only" copy (`ChatInput.tsx`, `ChatArea.tsx`, `FAQ.tsx`) in the same deploy.

## Court keys

The `court=` folders upstream are eCourts `state_court` codes (not the
`32_N` table older docs used):

| key | court | key | court |
|---|---|---|---|
| `9_13` | Allahabad | `29_3` | Karnataka |
| `28_2` | Andhra Pradesh | `32_4` | Kerala |
| `27_1` | Bombay | `23_23` | Madhya Pradesh |
| `19_16` | Calcutta | `33_10` | Madras |
| `22_18` | Chhattisgarh | `14_25` | Manipur |
| `7_26` | Delhi | `17_21` | Meghalaya |
| `18_6` | Gauhati | `21_11` | Orissa |
| `24_17` | Gujarat | `10_8` | Patna |
| `2_5` | Himachal Pradesh | `3_22` | Punjab & Haryana |
| `1_12` | Jammu & Kashmir and Ladakh | `8_9` | Rajasthan |
| `20_7` | Jharkhand | `11_24` | Sikkim |
| `36_29` | Telangana | `16_20` | Tripura |
| `5_15` | Uttarakhand | | |

## Redoing a bad batch

Every row carries `ingest_batch_id`. To drop batch 7 and let it be reloaded:

```sql
DELETE FROM case_chunks k USING high_court_cases c
 WHERE k.source_table = 'high_court_cases' AND k.source_id = c.id AND c.ingest_batch_id = 7;
DELETE FROM reembed_progress p USING high_court_cases c
 WHERE p.source_table = 'high_court_cases' AND p.source_id = c.id AND c.ingest_batch_id = 7;
DELETE FROM high_court_cases WHERE ingest_batch_id = 7;
```

Then reset those files in the manifest so selection picks them up again:
`sqlite3 data/high-courts/manifest.sqlite "UPDATE files SET status='todo' WHERE status='done'"`
— selection re-checks the DB, so files still loaded are skipped and re-marked done.

## Measured in testing (2026-10-28, 12 runs, 554 documents)

| | |
|---|---|
| Cost, newest 300 (untargeted, 3+ pages embedded) | $1.49 per 1,000 documents — $1.09 Haiku fields (half price), $0.40 embeddings, $0 OCR |
| Cost, newest 100 (all docs >= 500 chars embedded) | $0.94 per 1,000 |
| Cost, Karnataka 2010-16 (garbled era) | $4.85 per 1,000 (longer documents; OCR still free) |
| Free OCR accuracy (`calibrate`, 25 pages vs real text layers) | median character error 0.6%, ~0.65 s/page |
| Free OCR on garbled Karnataka / J&K pages | median word confidence 94-95% |
| Flagged for the paid pass | 0-13% of documents, mostly real scans and Kannada passages |
| Paid pass | ~$0.0019 per page (Haiku vision, batch) |
| Copies of an already-loaded judgment | 15-18% of recent documents (90% in one Rajasthan batch) |
| Throughput | ~2,000 documents/hour, laptop, 2 workers |
| Postgres growth | ~90 MB per 1,000 documents |

The newest documents run longer than the corpus average (9.7 vs 4.1 pages),
so the newest-first rate overstates the corpus-wide one. `status` reports the
running rate from untargeted runs only.

## Capacity

Each 1,000 loaded documents adds ~90 MB to Postgres (mostly chunks). Every run
refuses to start below `HC_MIN_FREE_GB` (15) free on `/`. 100k documents is
~9 GB; the whole corpus does not fit the current box, so plan a bigger disk
before going past a few hundred thousand documents.
