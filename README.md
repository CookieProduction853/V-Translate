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

## 設計比較

開啟 `designs.html` 比較四款風格，按「完整預覽」開啟可切換主題的首頁。

- `index.html?theme=classic&preview=1`：暖白珊瑚紅
- `index.html?theme=sakura&preview=1`：櫻花奶油粉
- `index.html?theme=midnight&preview=1`：午夜電光青
- `index.html?theme=matcha&preview=1`：抹茶日系書刊

正式首頁預設採用 **04 抹茶・日系書刊**（紙白、苔綠及宋體標題），只有帶 `preview=1` 的網址顯示設計切換工具。字體使用系統字體，裝置之間可能略有不同。
