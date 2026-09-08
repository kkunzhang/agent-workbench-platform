# Contributing

## Local development

1. Copy `.env.example` to `.env` and set a unique `JWT_SECRET`.
2. Start PostgreSQL with pgvector, Redis and MinIO: `npm run db:up`.
3. Apply migrations: `npm run db:migrate`.
4. Run the API: `npm run dev`.

Every schema change must be a new, forward-only SQL file in `migrations/`. Do not edit a migration that may already have been applied in another environment.

## Before opening a pull request

Run `npm run check`, `npm test` and `docker compose config`. Do not commit `.env`, model credentials, MCP environment variables, chat records or database dumps.

## Security boundary

MCP configuration can contain credentials. The server encrypts it before storage and only returns a redacted shape. Keep the decryption secret out of source control, validate tool inputs, and do not add arbitrary shell execution as an Agent tool.
