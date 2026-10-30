# 油字幕 · V-Translate

響應式產品介紹網站，使用 HTML、CSS、JavaScript，無套件相依。

## 本地開發

```sh
cd /workspace/V-Translate
python3 -m http.server 3000 --bind 0.0.0.0
```

## 自訂內容

- YouTube Demo：`index.html` 直接嵌入 `https://www.youtube-nocookie.com/embed/S1w9Pws00CE`，無須 JavaScript。
- 品牌圖片：`assets/app-icon.png` 用作頁首、頁尾及分頁圖示。
- 所有下載按鈕均連到指定 GitHub 專案。
- Hero 保留原本的直播示意視窗，並疊加 `assets/webUI.png` 人物、對話及字幕圖片。這是效果示意，並非軟件實際截圖。

## 部署

將此目錄部署至任何靜態網站服務，例如 GitHub Pages。無須建置步驟。已加入 YouTube Demo 影片。

## 主頁設計

`index.html` 是油字幕正式主頁，採用YouTube 風格的白底、黑字、紅色點綴與宋體標題，支援手機排版。已移除風格比較頁及主題切換功能。字體使用系統字體，裝置之間可能略有不同。

## 聯絡資訊

頁尾包含 `vtranslate853@gmail.com` 電郵連結、用戶要求邀請、製作人「曲奇 @Cookie Production」及 Instagram `@cookie_production`。
