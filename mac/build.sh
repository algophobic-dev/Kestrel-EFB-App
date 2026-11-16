#!/bin/bash
# Builds "Kestrel EFB.app" and Kestrel-EFB.dmg from main.swift.
# Needs the Xcode command line tools. Run:  bash mac/build.sh
set -euo pipefail
cd "$(dirname "$0")"

APP="build/Kestrel EFB.app"
mkdir -p build
rm -rf "build/Kestrel EFB.app" build/dmg build/AppIcon.iconset
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" build/dmg build/AppIcon.iconset

# Compile for Apple silicon and Intel, then join them into one universal program.
for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos12.0" -framework Cocoa -framework WebKit -o "build/KestrelEFB-$arch" main.swift
done
lipo -create build/KestrelEFB-arm64 build/KestrelEFB-x86_64 -output "$APP/Contents/MacOS/KestrelEFB"
cp Info.plist "$APP/Contents/Info.plist"

# App icon from the 1024 px artwork.
for size in 16 32 128 256 512; do
  sips -z $size $size ../icons/icon-1024.png --out "build/AppIcon.iconset/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) ../icons/icon-1024.png --out "build/AppIcon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns build/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"

# Ad-hoc signature: lets the app run, but it is not notarized by Apple.
codesign --force --deep --sign - "$APP"

# Disk image with the app and a shortcut to Applications.
cp -R "$APP" build/dmg/
ln -s /Applications build/dmg/Applications
hdiutil create -volname "Kestrel EFB" -srcfolder build/dmg -ov -format UDZO Kestrel-EFB.dmg >/dev/null
echo "Built: $(pwd)/Kestrel-EFB.dmg"
