#!/bin/sh
# Starts dockerd inside the MicroVM's application container.
#
# The cgroup and mount preparation is adapted from moby's hack/dind
# (https://github.com/moby/moby/blob/master/hack/dind, Apache-2.0). The image
# is built with additionalOsCapabilities ["ALL"], which these steps need.
# Arguments are passed through to dockerd.
set -eu

export container=docker

if [ -d /sys/kernel/security ] && ! mountpoint -q /sys/kernel/security; then
	mount -t securityfs none /sys/kernel/security || echo "securityfs mount failed; continuing" >&2
fi

# cgroup v2 nesting: move every process out of the root group so controllers
# can be delegated to dockerd's children.
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
	mkdir -p /sys/fs/cgroup/init
	xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || :
	sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers \
		> /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || echo "cgroup delegation failed; continuing" >&2
fi

mount --make-rshared / 2>/dev/null || :

# overlay2 cannot stack on the container's own overlay root. Put Docker's data
# on a loop-mounted ext4 file instead, or fall back to the slow vfs driver.
DATA_ROOT=/var/lib/docker
STORAGE_ARGS=""
mkdir -p "$DATA_ROOT"
fstype=$(stat -f -c %T "$DATA_ROOT" 2>/dev/null || echo unknown)
if [ "$fstype" = "overlayfs" ] && ! mountpoint -q "$DATA_ROOT"; then
	IMAGE_FILE=/var/lib/docker.img
	if [ ! -f "$IMAGE_FILE" ]; then
		free_kb=$(df -Pk /var/lib | awk 'NR==2 {print $4}')
		size_kb=$((free_kb * 6 / 10))
		if ! { truncate -s "${size_kb}K" "$IMAGE_FILE" && mkfs.ext4 -q -F "$IMAGE_FILE"; }; then
			rm -f "$IMAGE_FILE"
		fi
	fi
	if [ -f "$IMAGE_FILE" ] && mount -o loop "$IMAGE_FILE" "$DATA_ROOT"; then
		echo "docker data root on loop-mounted ext4 ($IMAGE_FILE)"
	else
		echo "loop mount unavailable; using the vfs storage driver" >&2
		STORAGE_ARGS="--storage-driver=vfs"
	fi
fi

# shellcheck disable=SC2086 # STORAGE_ARGS is intentionally word-split.
exec dockerd --host=unix:///var/run/docker.sock --data-root="$DATA_ROOT" $STORAGE_ARGS "$@"
