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
cp .env.example .env                                        # secrets
openssl rand -hex 32                                        # ACCESS_KEY

cp config/vault-service.sample.json config/vault-service.json
# behaviour: the JQL, where notes live, schedules, bucket, CouchDB location

# the bridge needs no config file: it is rendered from the environment

docker compose up -d --build
curl -s localhost:${HOST_PORT:-8181}/health
```

### Networking

This compose file declares **no networks and no project name**, both deliberately. Services land on the compose project's default network, and the project name is left to whatever deploys it.

That matters because Docker's name resolution is per-network, not per-host: two containers can only reach each other by service name if they share a user-defined network, and the default `bridge` network offers no DNS at all. Declaring a custom network here would opt these containers *out* of the network the rest of your stack is on, so the bridge could not reach CouchDB even though both run on the same machine. Pinning the project name would do the same thing indirectly, since the default network is called `<project>_default`.

So: deploy this alongside CouchDB in the same stack and `couchdb.url` can just use the service name. Confirm what actually happened with:

```sh
sudo docker inspect <container> \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```

Run it for both CouchDB and this service. If they share no network name, they cannot talk. To test resolution from inside, the image has Node, so:

```sh
sudo docker exec <container> node -e "require('dns').lookup('couchdb',(e,a)=>console.log(e?e.code:a))"
```

`ENOTFOUND` means wrong network; an IP means you can use that hostname.

### Reaching a CouchDB in another network

CouchDB usually has to be publicly reachable anyway, because the LiveSync plugin on phones and laptops connects to it directly. That means it is normally *not* on this stack's network, and there are two shapes it can take. Find out which with:

```sh
sudo docker ps --format '{{.Names}}\t{{.Ports}}' | grep -i couch
```

**Behind a reverse proxy with a domain**, which is the normal case and what this is set up for. Use the public URL, the same one the plugin uses:

```json
"url": "https://couchdb.example.com"
```

Traffic leaves the host and comes back, which is mildly wasteful and completely robust: it does not care about Docker networks, survives the platform recreating them, gets TLS from the proxy, and is identical to what your phone already uses. Nothing is declared in compose for this to work.

**Published straight onto the host** (`0.0.0.0:5984->5984/tcp`) is the alternative. Add to each service:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

then use `http://host.docker.internal:5984`. `host-gateway` resolves to the bridge gateway, which routes to the host. Note the `0.0.0.0`: a listener bound to the host's `127.0.0.1` sits in the host's own namespace and is unreachable from a container, host-gateway or not.

### If CouchDB were not reachable from outside

Then you would join networks instead, in one of two ways.

**Join CouchDB's own network**, which is the targeted option:

```yaml
networks:
  default:
    external: true
    name: <name-from-the-inspect-above>
```

Only that one network is joined, traffic never leaves Docker, and the hostname is CouchDB's container or service name. The catch is that the name must stay stable; if the platform recreates the network under a new name, this breaks until updated.

**Or put both resources on a shared network.** On Coolify that is the per-server predefined `coolify` network, via the "Connect To Predefined Network" toggle on each resource. Simplest in the UI and survives recreates, but it flattens isolation between every resource that joins, and the hostname becomes the generated container name (`couchdb-<uuid>`) rather than a tidy service name.

A third, worse option exists for completeness: `docker network connect` after deploy. It works immediately and is lost on the next redeploy, so it is only useful for a one-off test.

### Changing config without redeploying

The service re-reads its config file on a timer (`server.configPollMs`, default 10s) and applies what it can to the running process. Edit the file on the host, wait a few seconds, done. No restart, no redeploy.

```sh
sudo vi /data/vault-service/config/vault-service.json
curl -s -H "Authorization: Bearer $ACCESS_KEY" localhost:$HOST_PORT/v1/config   # confirm
```

Impatient, or want the result immediately:

```sh
curl -s -X POST -H "Authorization: Bearer $ACCESS_KEY" localhost:$HOST_PORT/v1/config/reload
# {"applied":["jira.jql"],"ignored":[],"error":null}
```

Polling rather than `fs.watch` is deliberate: inotify events do not reliably cross a Docker bind mount, which is exactly how this file is delivered, and editors that save via temp-file-and-rename can drop a watch entirely. One `stat` every ten seconds is dull and dependable.

**A broken edit cannot take the service down.** If the new file does not parse or fails validation, it is rejected, the error is logged and surfaced on `/v1/config`, and the previously loaded config stays live. `POST /v1/config/reload` answers 422 in that case. Fix the file and the next poll recovers.

**Not everything can be hot-swapped**, and the service says so rather than pretending:

| Applies immediately | Needs a restart |
|---|---|
| `jira.jql`, `targetSubdir`, `taskContext` | `server.port`, the listener is already bound |
| `jira.statusMap`, `defaultStatus`, `baseUrl` | `vaultDir`, the store is built from it |
| `jira.reconcileCron`, `backup.cron` (rescheduled) | whether a feature exists at all, which follows credentials in the environment |
| `backup.bucket`, `prefix`, `region`, `endpoint` | anything in `.env` |

A changed restart-only value comes back in `ignored`, and the live config keeps reporting the value actually in force. An invalid new cron expression is refused and the previous schedule kept.

### Where the files live on the host

Config lives at **absolute paths outside the repo checkout**, which matters for two reasons. A platform like Coolify runs `docker compose` from a throwaway build directory, so a relative source such as `./config` resolves to a path that does not exist on the host and Docker silently creates an empty directory. And the checkout itself is replaced on every deploy, which would wipe anything you put inside it.

```sh
sudo mkdir -p /data/vault-service/config
sudo cp config/vault-service.sample.json /data/vault-service/config/vault-service.json
```

That is the only config file on the host, and it holds no secrets, so it does not need locking down.

| Host path | Env var | Mounted at | Read by |
|---|---|---|---|
| `/data/vault-service/config` | `CONFIG_DIR` | `/config` read-only | the service, as `/config/vault-service.json` |
| a tmpfs volume | | `/app/dat` read-only | the bridge, rendered at start, never on disk |
| a Docker named volume by default | `VAULT_HOST_PATH` | `/vault` and `/app/data/vault` | both, this is the vault itself |
| `.env` | | not mounted, via `env_file` | compose |

Read-only applies inside the container only; you can still edit the file on the host, which is the whole point.

### Secrets never land on disk

livesync-bridge reads its CouchDB credentials and the vault E2EE passphrase from `dat/config.json` and has no environment support of its own. Writing that file by hand would leave your passphrase in plaintext on the host, where it can be copied into a backup or committed by accident.

Instead a short-lived `bridge-config` service renders it from the environment into a Docker volume before the bridge starts, and the bridge mounts that read-only. The environment is the source of truth; the rendered file is a derived artifact, rebuilt on every start, living in Docker's volume directory where it is root-only on the host and never anywhere you would commit or back up.

Two things here were wrong first time and are worth not repeating. A tmpfs-backed volume looked ideal, keeping the secrets in RAM, but a local-driver volume with `type: tmpfs` is mounted into each container's own namespace: what the renderer writes is invisible to the bridge, and disappears when the renderer exits. And mode `600` is wrong across two different images, since they need not share a uid and the bridge then cannot read its own config. The file is `644` inside a volume that is root-only on the host, which is where the protection actually comes from.

The same variables feed the service's own CouchDB access for the encrypted backup artifact, so there is one source of truth rather than two files that can drift:

| Variable | Used by |
|---|---|
| `COUCHDB_URL`, `COUCHDB_DB` | bridge and service |
| `COUCHDB_USER`, `COUCHDB_PASSWORD` | bridge and service |
| `VAULT_E2EE_PASSPHRASE` | bridge only, and it is the secret that matters most |
| `VAULT_ID_DERIVATION_KEY` | bridge only, see below |
| `BRIDGE_BASE_DIR` | bridge, how much of the vault to sync |

A missing or blank value is refused by name rather than rendering an empty password:

```
bridge config not rendered  error=cannot render the livesync-bridge config,
these are missing or invalid: VAULT_E2EE_PASSPHRASE
```

### The document ID derivation key

Newer LiveSync derives document IDs from a key, and the bridge refuses to touch a database whose IDs it cannot reproduce:

```
[couch] Error: Direct database document IDs do not match the configured ID key.
```

That appears *after* a successful connection, so it looks like a data problem rather than a missing setting. Obsidian stores the key only as `encryptedIdDerivationKey` in the plugin's `data.json`, so it cannot be read out of the vault. Copy the **recovery code** from the LiveSync settings instead and set `VAULT_ID_DERIVATION_KEY`. Both forms are accepted:

```
VAULT_ID_DERIVATION_KEY=sls-id-v1:<64 hex chars>
VAULT_ID_DERIVATION_KEY=<64 hex chars>
```

#### Recovering the key from the vault

The error is identical whether the key is **missing** or **wrong**, because an absent key makes derivation fall back to unkeyed:

```js
// livesync-commonlib, configuredIdKey()
if (version === 0 || version === undefined) {
  if (key) throw new Error("An ID key requires a supported derivation version.");
  return false;   // derivation proceeds UNKEYED, so IDs will not match
}
```

So if the bridge still reports a mismatch after the key is set, the key itself is wrong for that vault. To settle it rather than guess, recover the authoritative key straight out of the vault:

```sh
npm run id-key -- ~/vault/.obsidian/plugins/obsidian-livesync/data.json
```

It decrypts `encryptedIdDerivationKey` locally with the same `octagonal-wheels` HKDF primitives the plugin uses, and prints the key in both accepted forms. It talks to nothing.

Note that it usually needs **no secret from you**, because that field is *not* encrypted with the vault passphrase. LiveSync protects sensitive settings with a separate configuration key selected by `configPassphraseStore`, then appends a constant salt:

| `configPassphraseStore` | Key material |
|---|---|
| `""` (the "Default" option) | the literal `"*"` |
| `LOCALSTORAGE` | a value in device storage |
| `ASK_AT_LAUNCH` | typed at launch, stored nowhere |

```
key = <that value> + SALT_OF_PASSPHRASE
```

So on the default setting the key is a constant inside a public plugin and nothing needs to be supplied. The two custom stores do involve a real secret, and the tool asks for it on stdin or `LIVESYNC_CONFIG_PASSPHRASE`, never argv, so it stays out of shell history and `ps`. It names the setting it wants, since the configuration passphrase is easily confused with the vault passphrase.

A vault that does not use ID derivation is reported as such, so you know to leave the variable unset.

> **Worth knowing, independent of this service:** with `configPassphraseStore` on the default, `encryptedPassphrase` decrypts by exactly the same route, which means anyone holding that `data.json` can read your **vault passphrase** out of it. The default obfuscates these settings rather than protecting them. `data.json` lives under `.obsidian/`, which LiveSync does not sync when `syncInternalFiles` is off, so it is not in CouchDB or in the backups this service makes, but it is on every device with the vault and in any filesystem backup of that folder. `LOCALSTORAGE` and `ASK_AT_LAUNCH` use a real secret.

The value is normalised, validated before the bridge ever sees it, and redacted in logs. It is omitted from the rendered config entirely when unset, since a vault that does not use ID derivation needs no key and an empty one is worse than none. `idDerivationVersion` is deliberately not set here: the bridge selects version 1 itself once a key is present.

`BRIDGE_BASE_DIR` is the one exception to blank-means-missing, because empty genuinely means "sync the whole vault" there. It defaults to `Work/Jira/` so a wrong config affects one folder rather than everything; both peers are kept in step automatically.

To verify what a running container actually received, rather than what you believe it received:

```sh
sudo docker inspect <container> --format '{{json .Mounts}}' | python3 -m json.tool
```

Check `Source` on each entry. Note that `com.docker.compose.project.working_dir` is **not** trustworthy under Coolify: it records the build container's path, typically `/artifacts/<id>`, which does not exist on the host.

**The vault itself is not on a host path.** `vault_data` is a named Docker volume, so the plain markdown lives under Docker's own storage, typically `/var/lib/docker/volumes/vault-stack_vault_data/_data`. If you would rather have it somewhere you choose, so you can inspect or back it up independently, replace the volume with a bind mount in both services:

```yaml
# in livesync-bridge
- /srv/vault:/app/data/vault
# in vault-service
- /srv/vault:/vault
```

Both containers write to that directory, so if you bind mount it, make sure the uid they run as can write to it.

### Start scoped, then widen

The sample bridge config deliberately syncs only `Work/Jira/`, via `baseDir` on both peers. Leave it that way until you have watched a full round trip. If the config is wrong, the damage is contained to one folder instead of your whole vault. Widen `baseDir` to `""` on both peers once you trust it.

Take a CouchDB backup before the first run regardless.

## Configuration

Two places, split on purpose:

| | Holds | Example |
|---|---|---|
| `config/vault-service.json` | Non-secret behaviour | the JQL, where notes live, schedules, bucket name, CouchDB location |
| `.env` | Secrets only | `ACCESS_KEY`, Jira token, S3 keys, CouchDB password |

Precedence is **defaults < config file < environment**. Anything in the file can still be overridden per deployment by its environment variable, listed commented-out at the bottom of `.env.example`.

The config file is mounted read-only and is optional: with no file at all, built-in defaults apply. Start `config/vault-service.sample.json` by copying it; it is validated against the real schema in CI-style tests, so it parses as shipped.

Three behaviours worth knowing:

- **Features are enabled by credentials, never by the config file.** Putting `backup.bucket` in the file does nothing until `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` exist. `/health` reports which features are live.
- **A partly filled credential group is a startup error.** Setting `S3_ACCESS_KEY_ID` but forgetting `S3_SECRET_ACCESS_KEY` fails fast with both names in the message, so a typo cannot quietly turn backups off.
- **Config file typos are errors, at every level.** The schema is strict throughout, so `jira.jqlTypo` is rejected rather than silently ignored. JSON has no comments, so any key starting with `//` is dropped before validation, which is how the sample documents itself inline.

Changing the file takes effect on restart: `docker compose restart vault-service`.

### Ports

Two separate ports, and normally you only care about the first:

| Variable | Side | Default | Change it when |
|---|---|---|---|
| `HOST_PORT` | Host | `8181` | The default is already taken on the host |
| `PORT` | Inside the container | `8080` | Rarely, nothing else runs in there |

Compose builds its mapping from both (`127.0.0.1:${HOST_PORT}:${PORT}`), so the published port and the app cannot drift apart. Published on loopback only, because authentication is a single shared key.

Under Docker, set the port in `.env` rather than `server.port` in the config file: compose reads the environment, so a file-only value would be ignored while looking authoritative. The service warns at startup if the two disagree. `server.port` is still there for running outside a container.

## Jira sync

**One direction only: Jira to the vault.** The service makes exactly one kind of Jira call, a search. It never creates, edits, transitions or comments on an issue, and holds no write credentials path to do so. Jira stays the system of record.

A note is a pointer, not a copy. The entire body is one line:

```markdown
[ABC-123: Short summary of the work item](https://your-domain.atlassian.net/browse/ABC-123)
```

Title and link, nothing else. Everything real lives in Jira.

`jira.baseUrl` has no default, since a Jira host is deployment specific and guessing one would turn a missing setting into confusing 404s instead of a clear startup error.

**The JQL is the only thing that decides what exists.** Set `jira.jql` in the config file:

```json
"jql": "assignee = currentUser() AND issuetype not in (Epic, Story) AND status in (\"In Progress\", \"In Review\") ORDER BY updated DESC"
```

- A work item the query returns gets a note.
- A work item the query stops returning has its note **deleted** on the next reconcile. Status change, reassignment, resolution, or you editing the JQL itself: all the same thing, it no longer matches, so it goes.

Nothing is archived and no tombstone is left. That is deliberate, since the note held nothing but a link.

Issue types are excluded rather than listed on purpose. A project whose subtask type has been renamed or localised still gets picked up, whereas an explicit `issuetype in (Sub-task, Task, Bug)` list would silently miss it.

Notes land in `jira.targetSubdir` (default `Work/Jira`) carrying `tags: [task]` and `contexts: [<jira.taskContext>]`, so they show up alongside your hand-written tasks in any TaskNotes view filtered on that tag and context.

### Status mapping

Jira statuses are translated to TaskNotes status ids by `jira.statusMap`, looked up case insensitively, with `jira.defaultStatus` for anything absent:

```json
"statusMap": {
  "In Progress": "in-progress",
  "In Review":   "in-progress",
  "Staging":     "in-progress",
  "Blocked":     "in-progress",
  "Done":        "done"
},
"defaultStatus": "in-progress"
```

**Several Jira statuses collapse onto `in-progress` in the shipped default, and that is a limitation of the vault, not a choice.** TaskNotes in this vault defines only `none`, `open`, `in-progress` and `done`:

```
$ jq '[.customStatuses[].value]' .obsidian/plugins/tasknotes/data.json
["none","open","in-progress","done"]
```

There is no `in-review` to map onto. Add one in TaskNotes settings, then set `"In Review": "in-review"` here, and the two group separately in the task list. The service cannot verify the ids exist, because TaskNotes config lives in `.obsidian`, which your LiveSync setup does not sync (`syncInternalFiles` is off). A typo'd status id therefore shows up in Obsidian, not at startup.

**The true Jira status is always preserved** in the note's `jiraStatus` field no matter what the mapping says, so nothing is lost:

```yaml
status: in-progress          # TaskNotes, from statusMap
jiraStatus: "In Review"      # what Jira actually says
```

A Jira status missing from the map is not an error, since that would halt the sync. It logs a warning once per status, which usually means the JQL was widened without updating the map.

Because the notes are regenerated from Jira, **edits you make to them do not survive**. Change the body of a synced note and the next reconcile overwrites it; the folder is owned by the sync. Hand-written notes in the same folder are untouched, as they lack the ownership marker.

### Guarantees

- **Only notes it owns are ever modified or deleted.** Ownership is `source: jira` inside the frontmatter. A hand-written note, even one that mentions `source: jira` in its body, is left alone.
- **A Jira failure changes nothing.** Jira is queried first and a failure propagates before any write or delete, so a network blip cannot empty the folder.
- **An empty result is never trusted on its own.** This one is not theoretical. `POST /rest/api/3/search/jql` answers **HTTP 200 with `{"issues":[]}` when the credentials are wrong, and even when there are none at all**, because `assignee = currentUser()` resolves to nobody and zero matches is a valid answer to a valid query. Verified against Jira Cloud. Taken at face value, an expired API token would read as "nothing is active any more" and delete every synced note. So each reconcile first proves identity via `/rest/api/3/myself`, which *does* return 401, and also refuses if the token belongs to a different account than the configured email. A failure there aborts before the search even runs.
- **Idempotent.** A run that finds no changes rewrites no files and does not touch mtimes, which is what stops a write/sync/write echo loop with the bridge.
- **Atomic writes.** Notes are written to a dot-prefixed temp file and renamed, so the bridge's watcher never sees a half-written note. The sample bridge config ignores those temp names.
- **Duplicate keys are handled, not assumed away.** If two notes claim one Jira key, the lexicographically first path wins and the rest are pruned with a warning. Pruning happens *before* any writes, and nothing written during a run can be deleted later in that same run. That ordering matters: an earlier version pruned against a snapshot taken before the writes, so a stale duplicate entry could name the path a rename had just written, deleting the only note of a still-active issue while reporting `removed: 0, deduped: 1`. There is a regression test for exactly that.
- **One bad issue does not stop the others.** A per-issue failure is collected into `failures` in the result and logged; the remaining issues still sync and the stale-removal pass still runs. A failed issue is never treated as stale, so its note is not deleted.
- **Summaries are sanitised, not rejected.** Control characters are stripped from filenames. Otherwise an issue whose summary contained one would fail on every single run.

### Realtime

Point a Jira webhook at `POST /jira/webhook?secret=<JIRA_WEBHOOK_SECRET>` (that one stays in `.env`, it is a secret) for `jira:issue_updated`. The payload is ignored by design: a full reconcile is one JQL call and is immune to missed, duplicated or reordered events. Bursts are debounced (`jira.webhookDebounceMs`) and runs are serialised, so overlapping events cannot race on the same files.

`jira.reconcileCron` still runs regardless, because webhooks do get dropped and a missed delete would otherwise leave a stale note forever.

## Backups

`backup.cron` produces two independent artifacts:

| Artifact | Key | Contents | Restorable without passphrase |
|---|---|---|---|
| Plaintext | `<prefix>/plaintext/vault-plaintext-<ts>.zip` | The vault as readable files | Yes |
| Encrypted | `<prefix>/encrypted/vault-encrypted-<ts>.zip` | Raw CouchDB docs as NDJSON, still encrypted | No |

In the report, `entries` is the file count for the plaintext artifact and the **document count** for the encrypted one, checked against what CouchDB claims it holds. An export that produces zero documents when CouchDB reports some is refused rather than uploaded as a good backup; a smaller difference is logged, since documents can legitimately change while the export streams.

`skipped` counts files that vanished mid-walk. Under two writers that is expected rather than exceptional: the bridge or a concurrent reconcile can remove a file between the glob matching it and the archiver stat'ing it. Such a file is skipped and counted instead of aborting the whole archive, which is what an earlier version did.

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
| GET | `/v1/config` | What is in force right now, secrets omitted, plus watcher state |
| POST | `/v1/config/reload` | Re-read the config file now; 422 if it is invalid |
| POST | `/v1/backup/run` | Back up now |
| POST | `/jira/webhook` | Jira webhook, authenticated by `?secret=` or the `x-webhook-secret` header |

Every caller-supplied path goes through two layers of containment:

1. **Textual.** Absolute paths, NUL bytes, `..` traversal and sibling-prefix tricks (`/vaultX` passing for `/vault`) are rejected.
2. **Filesystem.** Symlinks are refused, and the real path of the deepest existing ancestor must still be inside the root. Without this a symlink already sitting in the vault (Obsidian users do symlink attachment folders, and the bridge could introduce one) resolves "inside" textually while `fs.readFile` and `fs.writeFile` follow it straight out. Dangling symlinks are refused too, since a write would create the file at the outside target.

`PUT /v1/note` bodies are capped at 8 MiB, the same ceiling the MCP handler applies, and return 413 above it.

## MCP

Streamable HTTP at `POST /mcp`, same access key. Stateless: a fresh server per request, so concurrent callers cannot collide on JSON-RPC ids.

Tools: `vault_list`, `vault_read`, `vault_write`, `vault_delete`, `vault_search`, `jira_sync`, `config_reload`.

```jsonc
{
  "mcpServers": {
    "vault": {
      "type": "http",
      "url": "http://<host>:<HOST_PORT>/mcp",
      "headers": { "Authorization": "Bearer <ACCESS_KEY>" }
    }
  }
}
```

## Volume ownership

The vault is written by two containers from two different images, which run as different users:

| Image | User | uid |
|---|---|---|
| vault-service (`node:22-alpine`) | `node` | 1000 |
| livesync-bridge (`denoland/deno`) | `deno` | 1993 |

Ownership has to be reconciled, and none of the obvious places can do it:

- A **fresh named volume** is created `root:root`, so neither user can write it. This shows up as `EACCES: permission denied, mkdir '/vault/Work'`.
- An **existing volume** keeps whatever ownership it already had, forever.
- A **bind mount** arrives with the host's ownership and is never touched by Docker.
- The **image** can only help in one narrow case: Docker seeds ownership from the image directory when a named volume is *empty*. That covers neither bind mounts nor any existing deployment.

Note this is ownership, not the mount. `rw` is already the default, and a read-write mount of a directory you lack permission on still fails. Docker does not remap users by default, so the container's numeric uid is checked against the directory exactly as any host process would be.

So it is fixed at runtime. Containers start as **root**, the entrypoint takes ownership of the vault for `PUID:PGID`, then `exec`s the real command as that user via `su-exec`. Root exists only for the few milliseconds that takes.

```
PUID=1993      # must match the uid livesync-bridge runs as
PGID=1993
```

Check the uid you need with:

```sh
docker exec <bridge-container> id
```

Changing it later needs only a restart. An existing vault is re-chowned automatically, and the recursive pass only runs when the top-level owner is already wrong, so it is a one-off migration rather than a cost on every start.

### If your platform forbids root containers

Set `user:` on the services in compose. The entrypoint detects that it is already unprivileged, skips the ownership step, and warns plainly if the vault is not writable:

```
warn  running as 1000:1000 and /vault is not writable; set PUID/PGID and allow
      this container to start as root, or chown the volume to the uid this
      container runs as
```

You then own the volume yourself, once:

```sh
docker run --rm -v <project>_vault_data:/v alpine chown -R 1993:1993 /v
```

### macOS is not a valid test for this

On Docker Desktop, containers run inside a Linux VM. Named volumes live in that VM and behave like Linux. **Bind mounts of macOS paths cross a file-sharing layer that fakes ownership**, presenting files as owned by whoever asks, so permission mismatches silently work. Reproduce permission behaviour with named volumes, never with a macOS bind mount.

## Health and startup order

Three services, each gated on the one before it:

```
init             renders the config, exits 0
      ↓ service_completed_successfully, restart: true
livesync-bridge  healthy only once its config is non-empty AND /app/data/vault is writable
      ↓ service_healthy, restart: true
vault-service    polls /health on its own port
```

Every edge is `restart: true`, so a dependency being replaced restarts what sits above it rather than leaving it running against state nobody maintains. A redeploy re-runs `init`, which therefore restarts both services behind it.

The bridge's health asserts both of its preconditions, because both have failed in practice: a rendered config that exists and is non-empty, and a vault that is present *and writable by the uid the bridge runs as*. The second is what the root-owned volume broke, and it is the condition `vault-service` genuinely depends on, since it writes the same tree.

What health deliberately does **not** assert is that files have appeared in the vault. On a fresh or empty sync scope there is legitimately nothing to replicate, so gating on content would deadlock the stack instead of protecting it. The strongest honest statement is "the bridge is running, configured, and able to write", which is what it checks.

`vault-service`'s healthcheck is declared in the **Dockerfile**, not in compose, so it applies to `docker run` and to any platform as well, not only to a compose deployment. It is deliberately not duplicated in the compose file, since two definitions drift. That does mean `docker compose config` shows no healthcheck for it; `docker inspect` on the image or `docker ps` will.

Two details that came from things going wrong:

`bridge-config` shares `vault-service`'s image and therefore inherited its HTTP healthcheck, which is meaningless for a one-shot renderer with no server. It is explicitly disabled there.

The bridge exposes no HTTP surface, so its healthcheck tests the one precondition that actually failed in practice: a missing or empty rendered config. Without that check the bridge starts, finds nothing, and quietly syncs nothing, which from the outside looks exactly like working. `vault-service` waits for `service_healthy` rather than `service_started` for the same reason.

```sh
docker ps --format '{{.Names}}\t{{.Status}}'   # look for (healthy) / (unhealthy)
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
npm run id-key -- <data.json>   # recover the vault's ID derivation key
```

## Status

Verified locally: typecheck, 12 tests covering reconcile semantics and path safety, and a live smoke test of the REST API, auth, traversal rejection and the MCP handshake plus tool listing.

Not yet verified, because it needs your CouchDB and a real vault:

- The bridge round trip end to end, including whether `baseDir` behaves as the sample config assumes.
- That no write/sync/write echo loop appears in practice. Idempotency is unit tested, but not against a live watcher.
- Both backup artifacts against a real bucket, and a restore from the encrypted one.
- The container image itself has not been built. Docker Desktop was not running on the dev machine.
