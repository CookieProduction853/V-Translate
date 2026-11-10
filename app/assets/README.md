# Application artwork

v0.4.1 includes the supplied application artwork at `assets/app-icon.png`
(1254 × 1254 RGBA). The original PNG is unchanged. `assets/app-icon.ico` is its
Windows multi-size conversion (16, 24, 32, 48, 64, 128 and 256 pixels), preserving
the artwork and transparency.

Developers can regenerate the ICO with `bash scripts/prepare-icons.sh` after
installing ImageMagick. This command only converts formats and leaves the source
PNG unchanged; users running the distributed app do not need ImageMagick.

`build.rs` embeds the files into the executable and compiles `windows.rc` on
Windows targets. The player serves the original PNG and ICO, with a web app
manifest. Windows integration applies the icon and taskbar identity only to the
new Chromium app window opened by this executable.

Windows desktop appearance has not been verified. If an old icon
persists, close the old background process and open the new executable; for a
pinned taskbar icon, unpin and pin the new app again to refresh the cached icon.
