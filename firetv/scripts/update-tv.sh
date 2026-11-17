#!/bin/sh
# Installs the release build over the copy on the TV *without* uninstalling it first, so the TV stays signed in.
# (`vega run-app` uninstalls first, which wipes the app's saved server and sign-in.)
# Usage: scripts/update-tv.sh [tv-ip]   (default 192.168.0.240)
set -e
cd "$(dirname "$0")/.."
export PATH=/opt/homebrew/opt/node@22/bin:$HOME/vega/bin:$PATH
TV=${1:-192.168.0.240}
export VEGA_SERIAL=$TV:5555
VDA=$(vega which vda)
$VDA connect "$TV" >/dev/null
npm run build:release >/dev/null
PKG=build/armv7-release/nuniflix_armv7.vpkg
$VDA push "$PKG" /tmp/nuniflix_armv7.vpkg >/dev/null
$VDA shell vpm install /tmp/nuniflix_armv7.vpkg --force
vega device terminate-app -a com.nunitech.nuniflix.main >/dev/null 2>&1 || true
vega device launch-app -a com.nunitech.nuniflix.main
