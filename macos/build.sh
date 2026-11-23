#!/bin/sh
# Builds macos/build/Schmear.app from the SwiftPM executable, signed with SCHMEAR_SIGN_IDENTITY (default: the keychain's
# first Developer ID Application identity, else ad hoc). SCHMEAR_NOTARY_PROFILE (a `notarytool store-credentials` profile)
# also notarizes and staples it, and zips it to build/Schmear.zip.
set -eu
cd "$(dirname "$0")"

swift build -c release
bin=$(swift build -c release --show-bin-path)
version=$(plutil -extract version raw ../package.json)

app=build/Schmear.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$bin/SchmearBar" "$app/Contents/MacOS/SchmearBar"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key><string>io.github.kevin1chun.schmear</string>
	<key>CFBundleName</key><string>Schmear</string>
	<key>CFBundleExecutable</key><string>SchmearBar</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>$version</string>
	<key>CFBundleVersion</key><string>$version</string>
	<key>LSMinimumSystemVersion</key><string>14.0</string>
	<key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

identity=${SCHMEAR_SIGN_IDENTITY:-$(security find-identity -v -p codesigning |
  sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -n 1)}
if [ -z "$identity" ] || [ "$identity" = - ]; then
  codesign --force --sign - "$app"
else
  codesign --force --options runtime --timestamp --sign "$identity" "$app"
fi

if [ -n "${SCHMEAR_NOTARY_PROFILE:-}" ]; then
  rm -f build/Schmear.zip
  ditto -c -k --keepParent "$app" build/Schmear.zip
  xcrun notarytool submit build/Schmear.zip --keychain-profile "$SCHMEAR_NOTARY_PROFILE" --wait
  xcrun stapler staple "$app"
  rm build/Schmear.zip
  ditto -c -k --keepParent "$app" build/Schmear.zip
fi
echo "$PWD/$app"
