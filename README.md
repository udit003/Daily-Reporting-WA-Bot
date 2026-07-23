# Daily-Reporting-WA-Bot

WhatsApp daily-reporting bot for Narang Realty. Node.js + TypeScript single
service (Fastify + node-postgres + OpenAI + Whapi).

> This README is a stub. The full overview, architecture diagram, environment
> table, setup/run/deploy instructions, routing rules, and demo runbook are
> finalized in a later task.

## Quick start

```bash
npm install
cp .env.example .env   # fill in secrets
npm run migrate        # apply SQL migrations
npm run seed           # seed projects, teams, settings, optional CEO
npm run dev            # start dev server (tsx watch)
```

## Scripts

- `npm run dev` — start the dev server with reload (`tsx watch src/index.ts`)
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled server (`node dist/index.js`)
- `npm run migrate` — apply pending SQL migrations under an advisory lock
- `npm run seed` — idempotent seed of reference data
- `npm test` — run the vitest suite (includes real-Postgres tests)

## Environment

See `.env.example` for the full list of variables and defaults. Report/query
day semantics are fixed to `Asia/Kolkata`; only reminder schedule values are
runtime-configurable (stored in the `settings` table).
