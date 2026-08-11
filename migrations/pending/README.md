# Held-back migrations

`scripts/migrate.sh` globs `migrations/*.sql`, which does not match this
subdirectory. Files here are written and reviewed but deliberately NOT applied
yet.

## Why anything would be here

The additive-migrations rule (see `docs/deploying-changes.md`) says a migration
must never break a rollback. A migration that DROPS something can only be applied
once the release that stopped using it is confirmed stable — otherwise rolling
back the code lands it on a schema it can't read.

## To apply one

Move it up a directory and deploy:

```bash
git mv migrations/pending/NNN_name.sql migrations/NNN_name.sql
# commit, push, then on the box:
bash scripts/deploy.sh
```

Each file states its own pre-flight check at the top. Run that first.
