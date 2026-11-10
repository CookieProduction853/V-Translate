#!/usr/bin/env bash
# Package a native Apple Silicon .app. End users need neither Python nor Homebrew.
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"
test "$(uname -s)" = Darwin && test "$(uname -m)" = arm64 || exit 1
version="$(node -e 'const fs=require("fs");console.log(fs.readFileSync("Cargo.toml","utf8").match(/^version = "([^"]+)"/m)[1])')"
package_root="$project_root/dist/V-Translate-macOS-arm64"
app="$package_root/V-Translate.app"
runtime="$app/Contents/Resources/runtime"
rm -rf "$package_root"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$package_root"
cp "$project_root/target/aarch64-apple-darwin/release/livesub" "$app/Contents/MacOS/V-Translate"
chmod 755 "$app/Contents/MacOS/V-Translate"
cp -R "$project_root/dist/macos-runtime" "$runtime"
cp "$project_root/dist/macos-runtime-manifest.json" "$app/Contents/Resources/runtime-manifest.json"
cp -R "$project_root/dist/macos-runtime-licenses" "$app/Contents/Resources/licenses"
for name in README.md LICENSE THIRD_PARTY_NOTICES.md THIRD_PARTY_LICENSES.txt; do cp "$project_root/$name" "$package_root/$name"; done
cp "$project_root/scripts/stop-tools/Stop-Whisper.command" "$package_root/Stop-Whisper.command"
chmod 755 "$package_root/Stop-Whisper.command"
cp -R "$project_root/docs" "$project_root/examples" "$package_root/"

iconset="$project_root/dist/VTranslate.iconset"
rm -rf "$iconset"
mkdir -p "$iconset"
art="$project_root/assets/TASK BAR ICON.png"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$art" --out "$iconset/icon_${size}x${size}.png" > /dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$art" --out "$iconset/icon_${size}x${size}@2x.png" > /dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/VTranslate.icns"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.cookieproduction.vtranslate</string>
<key>CFBundleName</key><string>V-Translate</string>
<key>CFBundleDisplayName</key><string>V-Translate</string>
<key>CFBundleExecutable</key><string>V-Translate</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$version</string>
<key>CFBundleVersion</key><string>$version</string>
<key>CFBundleIconFile</key><string>VTranslate</string>
<key>LSMinimumSystemVersion</key><string>13.5</string>
<key>LSApplicationCategoryType</key><string>public.app-category.entertainment</string>
<key>NSHighResolutionCapable</key><true/>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST
plutil -lint "$app/Contents/Info.plist"
codesign --force --sign - --timestamp=none "$app"
codesign --verify --deep --strict --verbose=2 "$app"

# Outer bundle signing must not alter runtime bytes pinned in the Rust executable.
node - "$runtime" "$project_root/dist/macos-runtime-manifest.json" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [root,file]=process.argv.slice(2);for(const entry of JSON.parse(fs.readFileSync(file,'utf8')).files) {
 const bytes=fs.readFileSync(path.join(root,entry.path));
 if(bytes.length!==entry.size_bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw Error(`Runtime changed after signing: ${entry.path}`);
}
NODE
# Keep archive entry names ASCII for consistent extraction and checksum verification.
cat > "$package_root/Start Here.txt" <<'TEXT'
油字幕 / V-Translate — macOS Apple Silicon preview

適用 Apple M 系列、macOS 13.5 或更新。不支援 Intel Mac。
解壓後把 V-Translate.app 移到「應用程式」，再開啟。不用 Python、Homebrew 或 Rosetta。
本測試版使用 ad-hoc 簽署，尚未取得 Apple Developer ID 簽署或公證。
若 macOS 阻擋開啟，先嘗試開啟一次，再到系統設定 → 隱私權與安全性 → 仍要開啟，確認來源後開啟。
以 Chrome／Edge 開啟直播並登入，分享直播「分頁」及「分頁音訊」。不支援 Safari／Firefox 的分頁音訊。
macOS 要求錄製權限時，請在系統設定 → 隱私權與安全性，允許所使用瀏覽器的螢幕／系統音訊錄製，再重新開啟瀏覽器。
可選 CPU 或 Apple Metal 執行 Whisper 聽寫和文字翻譯。首次使用需要網路下載模型。
效能選單有高效能、均衡和入門。高效能的起始緩衝是 5 秒，滑桿最低可手動調到 3 秒。
所有人可選高／中／低配置、模型大小、語言和畫質。結束觀看時停止擷取，再關閉背景聽寫程式。

For Apple Silicon Macs running macOS 13.5 or later; not Intel Macs.
Move V-Translate.app to Applications and open it. Python, Homebrew and Rosetta are not required.
This preview is ad-hoc signed, without Apple Developer ID signing or notarization. If macOS blocks it, attempt to open it, then use System Settings → Privacy & Security → Open Anyway after confirming the source.
Use Chrome or Edge and share the live-stream tab with tab audio. Safari and Firefox tab-audio capture is unsupported.
Grant the browser Screen / System Audio Recording permission if prompted, then restart the browser.
CPU and Apple Metal are selectable for Whisper transcription and text translation. Model downloads require Internet access.
Choose High, Balanced or Low. High starts with a 5-second buffer, and the player slider goes down to 3 seconds.

The local service runs in the background; its player opens in Chrome/Edge. Use the player's quit button to stop it.
See docs/macos.md for verification limits, permissions, data and model locations.
TEXT
node - "$package_root" "$version" <<'NODE'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [root,version]=process.argv.slice(2);fs.writeFileSync(path.join(root,'VERSION.txt'),`V-Translate ${version}\nmacOS arm64 / Apple Silicon\n`);
function visit(folder){return fs.readdirSync(folder).sort().flatMap(name=>{const file=path.join(folder,name),s=fs.lstatSync(file);if(s.isSymbolicLink())throw Error(`Unexpected symlink ${file}`);return s.isDirectory()?visit(file):[file];});}
fs.writeFileSync(path.join(root,'SHA256SUMS.txt'),visit(root).map(file=>`${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${path.relative(root,file).split(path.sep).join('/')}`).join('\n')+'\n');
NODE
zip="$project_root/dist/V-Translate-v$version-macOS-arm64.zip"
ditto -c -k --sequesterRsrc --keepParent "$package_root" "$zip"
cp "$zip" "$project_root/dist/V-Translate-macOS-arm64.zip"
shasum -a 256 "$zip" "$project_root/dist/V-Translate-macOS-arm64.zip" | sed "s|$project_root/dist/||g" > "$project_root/dist/SHA256SUMS-macOS-arm64.txt"
unzip -t "$zip" > /dev/null
echo "Packaged $zip"
