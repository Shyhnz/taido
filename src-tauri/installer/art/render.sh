#!/bin/sh
# Renders the installer images from the HTML files next to this script (macOS, Google Chrome):
#   ../dmg-background.tiff  .dmg window background, 1x + 2x in one file (Finder picks)
#   ../nsis-sidebar.bmp     Windows installer, welcome and finish pages (2x)
#   ../nsis-header.bmp      Windows installer, header of the other pages (2x)
set -eu

here=$(cd "$(dirname "$0")" && pwd)
out=$(dirname "$here")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

shot() { # <page> <width> <height> <scale> <png>
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
    --force-device-scale-factor="$4" --window-size="$2,$3" \
    --screenshot="$5" "file://$here/$1" >/dev/null 2>&1
}

shot dmg-background.html 660 400 1 "$tmp/dmg.png"
shot dmg-background.html 660 400 2 "$tmp/dmg@2x.png"
tiffutil -cathidpicheck "$tmp/dmg.png" "$tmp/dmg@2x.png" -out "$out/dmg-background.tiff" >/dev/null

shot nsis-sidebar.html 164 314 2 "$tmp/sidebar.png"
shot nsis-header.html 150 57 2 "$tmp/header.png"
# NSIS wants plain bitmaps: 24 bits, no alpha.
python3 "$here/png2bmp.py" "$tmp/sidebar.png" "$out/nsis-sidebar.bmp"
python3 "$here/png2bmp.py" "$tmp/header.png" "$out/nsis-header.bmp"

echo "rendered into $out"
