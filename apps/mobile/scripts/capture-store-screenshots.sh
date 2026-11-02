#!/bin/bash
set -euo pipefail
mkdir -p store-screenshots
app_path="$(find ios/build/Build/Products -type d -name '*.app' -path '*simulator*' -maxdepth 3 -print -quit)"
if [[ -z "$app_path" ]]; then
  printf '%s\n' 'No built simulator app found.' >&2
  exit 1
fi
xcrun simctl list devices available --json > store-screenshots/devices.json
for family in 'iPad Pro 13-inch' 'iPhone Duo'; do
  device_id="$(DEVICE_FAMILY="$family" node - <<'JS'
const fs = require('node:fs');
const catalog = JSON.parse(fs.readFileSync('store-screenshots/devices.json', 'utf8'));
const runtimes = Object.entries(catalog.devices).sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }));
for (const [runtime, devices] of runtimes) {
  if (!runtime.includes('iOS-27')) continue;
  const device = devices.find(device => device.isAvailable && device.name.startsWith(process.env.DEVICE_FAMILY));
  if (device) { console.log(device.udid); process.exit(0); }
}
console.error(`No iOS 27 simulator for ${process.env.DEVICE_FAMILY}`);
process.exit(1);
JS
)"
  xcrun simctl boot "$device_id"
  xcrun simctl bootstatus "$device_id" -b
  xcrun simctl status_bar "$device_id" override --time '9:41' --dataNetwork wifi --wifiMode active --wifiBars 3 --batteryState charged --batteryLevel 100
  xcrun simctl install "$device_id" "$app_path"
  name="ipad"
  [[ "$family" == 'iPhone Duo' ]] && name="iphone-duo"
  maestro --device "$device_id" test test/store/launch.yml
  xcrun simctl io "$device_id" screenshot "store-screenshots/${name}-onboarding.png"
  xcrun simctl shutdown "$device_id"
done
