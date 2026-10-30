# 油字幕 · V-Translate

響應式產品介紹網站，使用 HTML、CSS、JavaScript，無套件相依。

## Windows 下載

[下載 V-Translate v0.4.4 Windows x64 ZIP](https://github.com/CookieProduction853/V-Translate/raw/refs/heads/main/downloads/V-Translate-v0.4.4-Windows-x64.zip)

先關閉舊背景程式，解壓後開啟 `V-Translate.exe`，不需要 Python。Windows 10／11 64 位元，使用 Chrome／Edge。模型與使用說明見 ZIP 內文件。

[套件說明](downloads/README.md) · [SHA256 校驗碼](downloads/SHA256SUMS.txt)

此公開儲存庫提供產品網站、Windows 下載包及 `assets/ad` 廣告素材。應用程式開發原始碼另存於私人儲存庫。

## 本地開發

```sh
cd /workspace/V-Translate
python3 -m http.server 3000 --bind 0.0.0.0
```

## 自訂內容

- YouTube Demo：`index.html` 直接嵌入 `https://www.youtube-nocookie.com/embed/S1w9Pws00CE`，無須 JavaScript。
- 品牌圖片：`assets/TASK BAR ICON.png` 用作左上頁首圖示，`assets/app-icon.png` 用作頁尾及分頁圖示。
- 三個下載按鈕均直接下載本公開儲存庫內的 v0.4.4 Windows ZIP。
- Hero 保留原本的直播示意視窗，並疊加更新後的 `assets/webUI.png` 人物及對話圖片，中文字幕放在右下方。這是效果示意，並非軟件實際截圖。

## 部署

將此目錄部署至任何靜態網站服務，例如 GitHub Pages。無須建置步驟。已加入 YouTube Demo 影片。

## 主頁設計

`index.html` 是油字幕正式主頁，採用YouTube 風格的白底、黑字、紅色點綴與宋體標題，支援手機排版。已移除風格比較頁及主題切換功能。字體使用系統字體，裝置之間可能略有不同。

## 聯絡資訊

頁尾包含 `vtranslate853@gmail.com` 電郵連結、用戶要求邀請、製作人「曲奇 @Cookie Production」及 Instagram `@cookie_production`。

## 廣告素材與 Pages

圖片與同名 `.url` 放入 `assets/ad`，支援 PNG／JPG／WebP。現有 `AD 1.png` 會與 `AD1.url` 配對，新增時請使用完全相同的檔名主體。

`scripts/build-public-site.cjs` 保留產品主頁、CSS、圖片及下載，並把廣告清單與圖片放到網站的 `ads/`，供 v0.4.4 開機檢查。

使用 GitHub Actions 部署時，在 Settings → Pages → Source 選 GitHub Actions，再執行 Actions → Publish public website and advertisement assets。此公開儲存庫可使用免費的 GitHub Pages；不會將私人應用程式原始碼發佈至網站。
