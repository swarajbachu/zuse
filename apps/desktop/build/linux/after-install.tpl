#!/bin/bash
set -e

# Recovery actions must not require package files or change launcher state.
if [ "${1:-}" != "configure" ]; then
    exit 0
fi

# Installation runs as root, so probing unshare here does not tell us whether
# desktop users can create namespaces under Ubuntu's AppArmor restrictions.
# Keep the SUID fallback available without disabling Chromium's sandbox.
chown root:root '/opt/${sanitizedProductName}/chrome-sandbox'
chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox'

if type update-alternatives >/dev/null 2>&1; then
    # Retire the old path on upgrade so an equal-priority alternative cannot
    # leave the CLI pointing at the removed package files.
    # A fresh install or repeat configuration has no legacy alternative.
    update-alternatives --remove '${executable}' '/opt/Zuse (Beta)/${executable}' || true
    if [ -L '/usr/bin/${executable}' ] && [ "$(readlink '/usr/bin/${executable}')" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

if type update-mime-database >/dev/null 2>&1; then
    update-mime-database /usr/share/mime || true
fi
if type update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications || true
fi
