# vault-service

A standalone service for an Obsidian vault held in a self-hosted LiveSync CouchDB.

Three jobs in one container:

1. **Jira sync.** Mirrors your active Jira work items into the vault as TaskNotes notes, near-realtime via webhook, with a reconcile sweep as a safety net.
2. **Backups.** Two zip artifacts to any S3 compatible bucket: a plaintext vault archive and a raw, still-encrypted CouchDB export.
3. **API and MCP.** A REST API and an MCP server over the vault, behind a single access key.

## How it avoids touching the encryption

The vault is end to end encrypted with obfuscated paths. Rather than reimplement that, the stack runs [`vrtmrz/livesync-bridge`](https://github.com/vrtmrz/livesync-bridge) alongside this service. The bridge owns all crypto, chunking, conflict resolution and path obfuscation, and projects the vault into a plain directory on a shared volume. This service only ever reads and writes ordinary markdown files there.

That boundary is the whole design. This service contains no cryptography and cannot corrupt an encrypted document.

```
CouchDB  <--->  livesync-bridge  <--->  /vault (shared volume)  <--->  vault-service
 (E2EE)          owns all crypto            plain markdown            Jira, backups, API, MCP
```

## Deploy

```sh
git clone <this repo> && cd vault-service
cp .env.example .env            # fill it in, see the comments in the file
openssl rand -hex 32            # use this for ACCESS_KEY

cp livesync-bridge/dat/config.sample.json livesync-bridge/dat/config.json
# fill in CouchDB url, database, credentials, and your E2EE passphrase

docker compose up -d --build
curl -s localhost:8080/health
```

Your CouchDB already runs on this host. Either attach it to the `vault` network that compose creates, or point the `networks` block in `docker-compose.yml` at the network CouchDB is already on.

### Start scoped, then widen

The sample bridge config deliberately syncs only `Work/Jira/`, via `baseDir` on both peers. Leave it that way until you have watched a full round trip. If the config is wrong, the damage is contained to one folder instead of your whole vault. Widen `baseDir` to `""` on both peers once you trust it.

Take a CouchDB backup before the first run regardless.

## Configuration

Every setting is an environment variable, documented in `.env.example`. Two behaviours worth knowing:

- **Features are enabled by presence.** No `JIRA_EMAIL`/`JIRA_API_TOKEN` means Jira sync is off; no `S3_BUCKET` means backups are off. `/health` reports which are live.
- **A partly filled group is a startup error, not a silent disable.** Setting `S3_BUCKET` but forgetting `S3_SECRET_ACCESS_KEY` fails fast with both names in the message, so a typo can never quietly turn backups off.

## Jira sync

Default query, overridable with `JIRA_JQL`:

```
assignee = currentUser()
AND issuetype not in (Epic, Story)
AND status in ("In Progress", "In Review")
```

Issue types are excluded rather than listed on purpose. The WEB project uses the Swedish subtask type `Deluppgift`, which an explicit `issuetype in (Sub-task, Task, Bug)` list would silently miss.

Notes land in `JIRA_TARGET_SUBDIR` (default `Work/Jira`) as TaskNotes notes carrying `tags: [task]` and `contexts: [Work]`, so they appear in the existing `Work tasks` base next to hand-written tasks. The body is just the title and a link.

### Guarantees

- **Only notes it owns are ever modified or deleted.** Ownership is `source: jira` inside the frontmatter. A hand-written note, even one that mentions `source: jira` in its body, is left alone.
- **A Jira failure changes nothing.** Jira is queried first and a failure propagates before any write or delete, so a network blip cannot empty the folder.
- **Idempotent.** A run that finds no changes rewrites no files and does not touch mtimes, which is what stops a write/sync/write echo loop with the bridge.
- **Atomic writes.** Notes are written to a dot-prefixed temp file and renamed, so the bridge's watcher never sees a half-written note. The sample bridge config ignores those temp names.
- **Duplicate keys are handled, not assumed away.** If two notes claim one Jira key, the lexicographically first path wins and the rest are pruned with a warning.

### Realtime

Point a Jira webhook at `POST /jira/webhook?secret=<JIRA_WEBHOOK_SECRET>` for `jira:issue_updated`. The payload is ignored by design: a full reconcile is one JQL call and is immune to missed, duplicated or reordered events. Bursts are debounced (`JIRA_WEBHOOK_DEBOUNCE_MS`) and runs are serialised, so overlapping events cannot race on the same files.

`JIRA_RECONCILE_CRON` still runs regardless, because webhooks do get dropped and a missed delete would otherwise leave a stale note forever.

## Backups

`BACKUP_CRON` produces two independent artifacts:

| Artifact | Key | Contents | Restorable without passphrase |
|---|---|---|---|
| Plaintext | `<prefix>/plaintext/vault-plaintext-<ts>.zip` | The vault as readable files | Yes |
| Encrypted | `<prefix>/encrypted/vault-encrypted-<ts>.zip` | Raw CouchDB docs as NDJSON, still encrypted | No |

The two are independent on purpose: a CouchDB outage must not cost you the plaintext backup. A partial success is reported as HTTP 207 with the failure listed, rather than looking like a clean run.

**The plaintext artifact is your entire vault in the clear.** It defeats E2EE for anything that can read the bucket. Use a private bucket, and consider server-side encryption and a short retention.

The encrypted artifact is only as good as your passphrase, and is untested until you actually restore it. Do a restore drill.

## API

All `/v1` routes need `Authorization: Bearer $ACCESS_KEY` (or `X-Access-Key`). `/health` is open.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness, and which features are enabled |
| GET | `/v1/notes?subdir=&ext=` | List notes, `ext=all` for every file |
| GET | `/v1/note?path=` | Read one note |
| PUT | `/v1/note` | Write one note, body `{path, content}` |
| DELETE | `/v1/note?path=` | Delete one note |
| GET | `/v1/search?q=&subdir=` | Substring search with line numbers |
| GET | `/v1/jira/status` | Last run, last error, whether a run is in flight |
| POST | `/v1/jira/sync` | Reconcile now |
| POST | `/v1/backup/run` | Back up now |
| POST | `/jira/webhook` | Jira webhook, authenticated by its own secret |

Every caller-supplied path is resolved against the vault root and rejected if it escapes, including `..` traversal, absolute paths and sibling-prefix tricks.

## MCP

Streamable HTTP at `POST /mcp`, same access key. Stateless: a fresh server per request, so concurrent callers cannot collide on JSON-RPC ids.

Tools: `vault_list`, `vault_read`, `vault_write`, `vault_delete`, `vault_search`, `jira_sync`.

```jsonc
{
  "mcpServers": {
    "vault": {
      "type": "http",
      "url": "http://<host>:8080/mcp",
      "headers": { "Authorization": "Bearer <ACCESS_KEY>" }
    }
  }
}
```

## Security posture

Authentication is one shared access key, so **do not expose this publicly**. Compose binds it to `127.0.0.1` for that reason. Reach it from another container on the same network, or over a tunnel. Put TLS in front if it must leave the host.

The container also holds your Jira token and S3 credentials, and the bridge container holds your vault E2EE passphrase.

## Development

```sh
npm install
npm run typecheck
npm test
VAULT_DIR=/tmp/vault ACCESS_KEY=dev npm run dev

npm run sync:once      # one reconcile, then exit
npm run backup:once    # one backup, then exit
```

## Status

Verified locally: typecheck, 12 tests covering reconcile semantics and path safety, and a live smoke test of the REST API, auth, traversal rejection and the MCP handshake plus tool listing.

Not yet verified, because it needs your CouchDB and a real vault:

- The bridge round trip end to end, including whether `baseDir` behaves as the sample config assumes.
- That no write/sync/write echo loop appears in practice. Idempotency is unit tested, but not against a live watcher.
- Both backup artifacts against a real bucket, and a restore from the encrypted one.
- The container image itself has not been built. Docker Desktop was not running on the dev machine.
