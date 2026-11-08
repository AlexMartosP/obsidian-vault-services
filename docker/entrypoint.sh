#!/bin/sh
set -eu

# Make the mounted directories usable, then drop privileges.
#
# The vault volume is written by this service and by livesync-bridge, two
# images that run as different users. A fresh Docker volume is created
# root:root, a bind mount arrives with whatever the host gave it, and an
# existing volume keeps whatever ownership it already had. None of those are
# writable by an unprivileged container user by default, and the image cannot
# fix it on its own: Docker only seeds ownership from the image when a named
# volume is empty, which excludes bind mounts and every existing deployment.
#
# So the container starts as root, corrects ownership at runtime, and execs
# the real command as PUID:PGID. PUID must match the uid livesync-bridge runs
# as, since both write the same tree. Check it with:
#
#   docker exec <bridge-container> id
#
# If the platform refuses to start containers as root, set `user:` in compose
# and this script skips the ownership step rather than failing. It then warns
# if the vault is not writable, so the cause is visible rather than appearing
# later as EACCES on every note.

PUID="${PUID:-1993}"
PGID="${PGID:-1993}"
VAULT_DIR="${VAULT_DIR:-/vault}"
# Where the bridge config is rendered, when this container is the init step.
RENDER_DIR="${RENDER_DIR:-/render}"

log() {
    # Matches the application's structured output closely enough to read as
    # one stream in `docker logs`.
    printf '{"ts":"%s","level":"%s","msg":"%s"}\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$1" "$2"
}

own_if_needed() {
    dir="$1"
    [ -d "$dir" ] || return 0

    current_uid="$(stat -c %u "$dir" 2>/dev/null || echo unknown)"
    current_gid="$(stat -c %g "$dir" 2>/dev/null || echo unknown)"

    if [ "$current_uid" = "$PUID" ] && [ "$current_gid" = "$PGID" ]; then
        return 0
    fi

    # Recursive, because an existing deployment may hold notes owned by a
    # previous uid. Only reached when the top level is already wrong, so this
    # is a one-off migration rather than a cost on every start.
    log info "taking ownership of $dir for $PUID:$PGID (was $current_uid:$current_gid)"
    chown -R "$PUID:$PGID" "$dir"
}

if [ "$(id -u)" = "0" ]; then
    mkdir -p "$VAULT_DIR"
    own_if_needed "$VAULT_DIR"
    # The render volume is only mounted in the init step. Ownership matters
    # there for the same reason as the vault: the renderer runs unprivileged
    # and a fresh volume is root:root, so without this the bridge config is
    # never written and the bridge starts with nothing to read.
    if [ -d "$RENDER_DIR" ]; then
        own_if_needed "$RENDER_DIR"
    fi

    log info "dropping privileges to $PUID:$PGID"
    exec su-exec "$PUID:$PGID" "$@"
fi

# Already unprivileged, so ownership cannot be corrected from here. Say so
# plainly rather than letting it surface as a write failure per note.
if [ ! -w "$VAULT_DIR" ]; then
    log warn "running as $(id -u):$(id -g) and $VAULT_DIR is not writable; \
set PUID/PGID and allow this container to start as root, or chown the volume \
to the uid this container runs as"
fi

exec "$@"
