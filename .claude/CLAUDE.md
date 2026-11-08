# obsidian-vault-services

## Quality Gate Commands

- **Typecheck:** `npm run typecheck` (covers `src` and `test`, via tsconfig.json + tsconfig.test.json)
- **Build:** `npm run build`
- **Test:** `npm test` (vitest, whole suite is fast, no need to scope)
- **Lint:** not applicable (no linter configured in this repo)

## Notes

- Node 22+, ESM, TypeScript strict with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. Relative imports use `.ts` extensions, which
  works via `rewriteRelativeImportExtensions`.
- `tsconfig.json` only includes `src`, so `npm run typecheck` deliberately runs
  `tsconfig.test.json` as well. Do not drop that second invocation: without it
  broken test files typecheck clean.
- The service holds the Jira token, S3 credentials and the vault access key.
  livesync-bridge holds the vault E2EE passphrase. Never commit real values;
  `config/vault-service.sample.json` and `.env.example` are the templates.
