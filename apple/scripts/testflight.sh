#!/bin/sh
# Archive both apps and upload them to TestFlight (App Store Connect).
#   apple/scripts/testflight.sh            # uses the build number in project.yml
# Bump CURRENT_PROJECT_VERSION in project.yml before each upload: App Store Connect refuses a build number twice.
# Signs in with an App Store Connect API key when ~/.appstoreconnect/nuniflix.env exists
# (ASC_KEY_ID, ASC_ISSUER_ID; the key file at ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8),
# otherwise with the Apple ID in Xcode → Settings → Accounts.
# Archives unsigned and signs during export, so no registered test devices are needed.
set -e
cd "$(dirname "$0")/.."
AUTH=""
if [ -f "$HOME/.appstoreconnect/nuniflix.env" ]; then
  . "$HOME/.appstoreconnect/nuniflix.env"
  AUTH="-authenticationKeyPath $HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8 -authenticationKeyID $ASC_KEY_ID -authenticationKeyIssuerID $ASC_ISSUER_ID"
fi
if [ "$1" = "--upload-only" ]; then UPLOAD_ONLY=1; fi
OUT="${TMPDIR:-/tmp}/nuniflix-testflight"
if [ -z "$UPLOAD_ONLY" ]; then xcodegen -q; rm -rf "$OUT"; fi
mkdir -p "$OUT"
cat > "$OUT/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>destination</key><string>upload</string>
<key>teamID</key><string>4BFLU9C935</string>
<key>signingStyle</key><string>automatic</string>
</dict></plist>
PLIST
for pair in "NuniFlix-iOS:iOS" "NuniFlix-TV:tvOS"; do
  scheme="${pair%%:*}"; platform="${pair##*:}"
  if [ -z "$UPLOAD_ONLY" ]; then
    echo "== $scheme: archiving"
    xcodebuild -quiet -project NuniFlix.xcodeproj -scheme "$scheme" -destination "generic/platform=$platform" \
      -archivePath "$OUT/$scheme.xcarchive" CODE_SIGNING_ALLOWED=NO archive
    # An unsigned archive carries no entitlements, and export signing keeps only what's already there: stamp them on
    # (e.g. aps-environment, or iPhone notifications fail with "no valid aps-environment entitlement").
    APP="$OUT/$scheme.xcarchive/Products/Applications/$scheme.app"
    for ext in "$APP"/PlugIns/*.appex; do  # extensions first (e.g. Top Shelf), then the app around them
      [ -e "$ext" ] || continue
      name=$(basename "$ext" .appex)
      if [ -f "$name.entitlements" ]; then
        codesign --force --sign - --timestamp=none --generate-entitlement-der --entitlements "$name.entitlements" "$ext"
      fi
    done
    if [ -f "$scheme.entitlements" ]; then
      codesign --force --sign - --timestamp=none --generate-entitlement-der --entitlements "$scheme.entitlements" "$APP"
    fi
  fi
  echo "== $scheme: signing and uploading"
  rm -rf "$OUT/$scheme"
  # shellcheck disable=SC2086
  xcodebuild -exportArchive -archivePath "$OUT/$scheme.xcarchive" -exportOptionsPlist "$OUT/export.plist" \
    -exportPath "$OUT/$scheme" -allowProvisioningUpdates $AUTH 2>&1 | grep -E "error|Upload succeeded|EXPORT|required" || true
done
