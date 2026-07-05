// pm2 process definition for the Hetzner box.
//
// Why this file exists: the app was being started ad-hoc (fork mode, single
// instance). That means (a) only one CPU core ever served requests, and (b)
// `pm2 reload` could NOT do a zero-downtime swap — deploy.sh relies on reload
// keeping in-flight SSE chat streams alive, which only works in CLUSTER mode.
//
// Start each environment once, then deploy.sh just reloads it:
//   pm2 start ecosystem.config.js --only nyayasearch          --env production
//   pm2 start ecosystem.config.js --only nyayasearch-staging  --env staging
//   pm2 save    # persist across reboots (also run: pm2 startup)
//
// INSTANCE COUNT / MEMORY: the DB is co-located and the pgvector HNSW index
// (~6GB) needs to stay warm in the OS page cache. Every Next instance is
// ~0.4–0.8GB, so do NOT use `-i max` here — it would starve Postgres. On an
// 8GB box keep instances=2; only raise it after upsizing RAM (see docs).

const base = {
  script: "node_modules/next/dist/bin/next",
  args: "start",
  exec_mode: "cluster",
  instances: Number(process.env.PM2_INSTANCES || 2),
  // Recycle an instance that leaks past this instead of letting it push the box
  // into swap / the OOM killer (which would also take Postgres down).
  max_memory_restart: "900M",
  // Give in-flight requests (SSE streams) time to drain on reload/stop.
  kill_timeout: 10_000,
  wait_ready: false,
  time: true, // timestamp pm2 logs
};

module.exports = {
  apps: [
    {
      ...base,
      name: "nyayasearch",
      cwd: "/opt/legal-ai-product",
      env: { NODE_ENV: "production", PORT: "3000" },
    },
    {
      ...base,
      name: "nyayasearch-staging",
      cwd: "/opt/legal-ai-product-staging",
      instances: 1, // staging is low-traffic; don't spend cores/RAM on it
      env: { NODE_ENV: "production", PORT: "3001" },
    },
  ],
};
