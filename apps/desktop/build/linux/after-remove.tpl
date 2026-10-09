#!/bin/bash
set -e

# dpkg also runs postrm for upgrades; leave the new version's launcher alone.
case "$1" in
    remove|purge)
        if type update-alternatives >/dev/null 2>&1; then
            # Purge can follow removal, when the alternative is already gone.
            update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}' || true
        elif [ -L '/usr/bin/${executable}' ] && [ "$(readlink '/usr/bin/${executable}')" = '/opt/${sanitizedProductName}/${executable}' ]; then
            rm -f '/usr/bin/${executable}'
        fi
        ;;
esac
