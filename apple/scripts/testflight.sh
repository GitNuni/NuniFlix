#!/bin/sh
# Archive both apps and upload them to TestFlight (App Store Connect).
#   apple/scripts/testflight.sh            # uses the build number in project.yml
# Bump CURRENT_PROJECT_VERSION in project.yml before each upload: App Store Connect refuses a build number twice.
# Needs Xcode signed in to the team's Apple ID (Xcode → Settings → Accounts).
# Archives unsigned and signs during export, so no registered test devices are needed.
set -e
cd "$(dirname "$0")/.."
xcodegen -q
OUT="${TMPDIR:-/tmp}/nuniflix-testflight"
rm -rf "$OUT" && mkdir -p "$OUT"
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
  echo "== $scheme: archiving"
  xcodebuild -quiet -project NuniFlix.xcodeproj -scheme "$scheme" -destination "generic/platform=$platform" \
    -archivePath "$OUT/$scheme.xcarchive" CODE_SIGNING_ALLOWED=NO archive
  echo "== $scheme: signing and uploading"
  xcodebuild -exportArchive -archivePath "$OUT/$scheme.xcarchive" -exportOptionsPlist "$OUT/export.plist" \
    -exportPath "$OUT/$scheme" -allowProvisioningUpdates 2>&1 | grep -E "error|Upload succeeded|EXPORT" || true
done
