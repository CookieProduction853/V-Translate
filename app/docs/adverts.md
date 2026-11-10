# 廣告圖片與贊助輪播

v0.4.5 Windows 測試版 可在廣告／贊助版位顯示專案提供的靜態廣告圖片，與原有合作邀請卡片輪播。這是直接贊助的圖片展示功能，沒有接入即時廣告網絡，也不會自動產生廣告收入。合作與一般用戶要求可來信 [vtranslate853@gmail.com](mailto:vtranslate853@gmail.com)。

## 播放器中的顯示方式

輪播每 10 秒切換一次，包含合作邀請卡片及已成功載入的廣告；播放完全部圖片後會回到卡片，持續重複。版位約 250 px 高，手機會按版面稍作調整；圖片會等比例填滿並裁切邊緣，請把重要文字與標誌留在中央安全範圍。

按廣告圖片會在新分頁開啟其連結，不會自動開啟網站。圖片下方的 **Fans AD Contact: vtranslate853@gmail.com** 始終顯示，按電郵地址可洽談合作；它位於輪播之外，不會被圖片遮蓋。可使用版位的暫停按鈕停止輪播；滑鼠停留、鍵盤焦點位於版位內或分頁隱藏時，也會暫停計時。

## 準備廣告圖片與連結

廣告來源放在公開的 [CookieProduction853/V-Translate](https://github.com/CookieProduction853/V-Translate) 儲存庫的 `assets/ad` 或現有的 `ads`。它與私人的 `AI-Vtuber-Translate-Codex2` 程式儲存庫分開；廣告維護及公開網站部署使用前者。兩個資料夾會合併，同名項目以 `ads` 的內容優先，避免重複輪播。新增時，請將圖片與連結文字檔使用相同檔名主體，例如：

```text
assets/ad/AD2.jpg
assets/ad/AD2.url
```

`.url` 是純文字檔，內容填入一個完整的 HTTPS 網址，例如 `https://example.com/sponsor`；也接受 Windows Internet Shortcut 的 `[InternetShortcut]` 與 `URL=https://…` 格式。只允許 HTTPS 網站連結，不接受含帳號密碼的網址或 `javascript:`、`data:`、`file:` 等連結。現有 PNG 圖片亦可使用；缺少配對、連結不合格或圖片損壞的項目會略過。

清單最多接受 32 張合格圖片，單張不超過 5 MiB、總計不超過 30 MiB；10 張圖片只要符合這些限制，即可與合作邀請卡片一起循環輪播。

維護者可執行 `node scripts/build-ad-feed.cjs` 產生廣告清單與套件內圖片資料。只修改本機檔案不會更新別人的播放器；隨程式附帶的圖片需要更新套件，遠端圖片則需完成以下 Pages 發佈。

## 發佈公開廣告來源

程式預設檢查的清單網址為：

```text
https://cookieproduction853.github.io/V-Translate/ads/manifest.json
```

公開 `V-Translate` 儲存庫內的 [pages.yml 工作流程](https://github.com/CookieProduction853/V-Translate/blob/main/.github/workflows/pages.yml) 使用 [build-public-site.cjs](https://github.com/CookieProduction853/V-Translate/blob/main/scripts/build-public-site.cjs) 建立公開網站，保留原有網站內容並加入廣告清單與圖片。它不會把私人應用程式原始碼或模型發佈到 Pages。

1. 在公開 `V-Translate` 儲存庫的 **Settings → Pages → Source** 使用 **GitHub Actions**。此公開網站方案不需要私人程式儲存庫的 Pages 權限或 GitHub Pro。
2. 將配對圖片與 `.url` 放入公開儲存庫的 `assets/ad` 或 `ads`，更新到 `main`；使用該儲存庫的 `pages.yml` 部署。需要手動執行時，到 **Actions** 開啟對應工作流程並選 **Run workflow**。
3. 工作流程成功後，確認上述清單及其中圖片不需登入即可讀取。播放器在下次啟動時檢查更新。

在公開網站儲存庫的本機副本，可執行 `node scripts/build-public-site.cjs` 檢查產生結果。私人程式儲存庫可以保持私有；供播放器使用的 Pages 廣告檔案必須公開可讀。

## 更新、快取與失敗處理

程式啟動後會在背景檢查上述 GitHub Pages 廣告清單，驗證圖片後存入資料目錄的 `ads` 快取，播放器從本機程式讀取圖片。遠端來源啟用後，更新廣告不需要重新下載整個 Windows 套件。

廣告更新是否已部署，應以公開清單及圖片實際可讀取為準；本文不把工作流程或文件的變更視為已完成部署。現有隨附圖片仍可離線輪播。

網路離線或更新失敗時，會繼續使用已驗證的快取或套件內圖片。無法使用的圖片與連結會略過；沒有可用廣告時，只顯示合作邀請卡片。空清單不會產生空白或損壞的廣告連結。

這個功能沒有曝光／點擊統計、追蹤腳本或廣告成效回報，也不會上傳使用者的觀看內容、字幕或個人資料。按廣告後開啟的外部網站，由該網站自行提供服務。
