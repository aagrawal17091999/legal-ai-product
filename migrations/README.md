# Migrations

Applied by `scripts/migrate.sh`, which keeps a `schema_migrations` ledger and
runs each file **exactly once**. `deploy.sh` calls it on every deploy.

## Rules

1. **Additive only.** Add column → backfill → switch reads → drop in a *later*
   deploy. Code rolls back; migrations do not. A migration that drops something
   the previous release still reads turns a rollback into an outage.
2. **Never edit an applied file.** The ledger keys on filename, so an edit to an
   already-applied migration silently never runs. Write a new one.
3. **Never rename an applied file.** Same reason, worse failure: the renamed file
   looks new and gets applied a second time.

## Known quirk: two files numbered 019

```
019_translation_result.sql
019_workspace_conversations.sql
```

Both are applied and both are in the ledger, so this is harmless — the ledger
keys on the full filename, not the number. It is recorded here only so the next
person doesn't assume 019 is free, and doesn't "tidy" it with a rename (see rule
3 — a rename would re-apply it).

Next free number: **033**.
