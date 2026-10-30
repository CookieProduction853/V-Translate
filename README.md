# 油字幕 · V-Translate

響應式產品介紹網站，使用 HTML、CSS、JavaScript，無套件相依。

## 本地開發

```sh
cd /workspace/V-Translate
python3 -m http.server 3000 --bind 0.0.0.0
```

## 自訂內容

- YouTube Demo：在 `script.js` 的 `YOUTUBE_DEMO_ID` 填入 11 字元影片 ID；未設定時顯示「敬請期待」，不載入外部影片。
- 品牌圖片：原始上傳圖片未掛載到工作區，目前使用文字標誌與 SVG favicon。取得原檔後放入 `assets/`，並替換首頁 `.brand-icon` 及 favicon。
- 所有下載按鈕均連到指定 GitHub 專案。
- Hero 是字幕效果示意，並非軟件實際截圖。

## 部署

將此目錄部署至任何靜態網站服務，例如 GitHub Pages。無須建置步驟。請在發布前補上正式品牌圖片及 Demo 影片。

## 主頁設計

`index.html` 是油字幕正式主頁，採用紙白底、藍色配色與宋體標題，支援手機排版。已移除風格比較頁及主題切換功能。字體使用系統字體，裝置之間可能略有不同。
