# PostgreSQL migration

Status: planned, not active. Talisman currently uses Node's synchronous SQLite API across `server.mjs`, `telegram.mjs`, `provisioner.mjs`, scheduling, memory and account modules. Setting `DATABASE_URL` or adding a PostgreSQL container alone will not migrate this data or make multiple server replicas safe.

## Decision

Keep the current Node service for the first migration. Railway supports containerized Node services and a PostgreSQL service; its FastAPI guide is an option, not a requirement for PostgreSQL. A Python rewrite would increase the migration surface without solving account isolation, job leases or desktop provisioning on its own. See [Railway database networking](https://docs.railway.com/databases/build-a-database-service) and [Railway FastAPI guide](https://github.com/railwayapp/docs/blob/main/content/guides/fastapi.md).

## Required cutover

1. Introduce an asynchronous database interface using a PostgreSQL connection pool and parameterized queries. Refactor every caller of `DatabaseSync`, `prepare().get/all/run`, and `exec()` to await it. Convert SQLite-specific SQL and migrations explicitly.
2. Add schema migrations and foreign keys for accounts, computer assignments, job/step/approval records, memory, calendar, vault and proactive events. Keep account-scoped access checks in the application, then add row-level security where feasible.
3. Implement PostgreSQL job claiming with `FOR UPDATE SKIP LOCKED`, leases and atomic idempotency keys. Update the provisioner and Telegram bot to use the same database and avoid duplicate sends after restarts.
4. Create a one-time, read-only SQLite export with row counts and checksums; load into an empty PostgreSQL database, validate references and counts, then stop writes, transfer the final delta and switch all services together.
5. Run account isolation, interruption, approval, delivery and rollback tests against a real local PostgreSQL service before changing Railway configuration. Preserve the SQLite file as a rollback snapshot until verified.

PostgreSQL 18 binaries are present on this Windows machine, but `127.0.0.1:5432` was not accepting connections when checked. No database was created and no existing data was modified.
