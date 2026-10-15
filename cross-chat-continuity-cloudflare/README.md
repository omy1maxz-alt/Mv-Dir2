# Cross-Chat Context Continuity — Cloudflare deployment

This directory is a deployment blueprint for a Cloudflare-native continuity backend.

## Architecture

- Cloudflare Worker: HTTPS API and MCP Streamable HTTP transport.
- Cloudflare D1: projects, memory records, checkpoint versions, decisions, attempts, tasks, audit events.
- D1 FTS5: keyword/full-text retrieval for task-specific context.
- Worker secrets: bearer token / signing secret; never commit credentials.
- Optional later: Durable Objects for per-project serialization and Vectorize for semantic search.

## Security requirements

- Authenticate every non-health request.
- Scope every query to the authenticated user; never trust owner/project IDs supplied without authorization.
- Use prepared D1 statements.
- Redact credential-shaped values before storing checkpoint content.
- Add idempotency keys and optimistic checkpoint versions.
- Do not claim access to other ChatGPT conversations unless supplied by the user or returned by an authorized connector.

## Deployment plan

1. Create a Cloudflare Worker project with TypeScript and the current supported MCP SDK/transport.
2. Create a D1 database and apply `schema.sql`.
3. Configure `DB` D1 binding in `wrangler.toml`.
4. Configure a random `CONTINUITY_API_TOKEN` using `wrangler secret put CONTINUITY_API_TOKEN`.
5. Deploy with `npx wrangler deploy`.
6. Test `/health`, authenticated MCP initialize, tools/list, and project create/save/search/restore/export flows.
7. Connect the deployed endpoint to the private ChatGPT plugin only through a supported MCP configuration mechanism. Worker deployment by itself does not connect the plugin.

## Status

Blueprint only. Do not treat this directory as a deployed or verified service until the deployment and integration tests actually pass.
