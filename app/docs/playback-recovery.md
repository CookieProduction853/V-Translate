# AI 落後時的緩衝倒數

v0.4.3 遇到音訊積壓、過時的重試音訊或影音記憶體壓力時，先暫停播放器的畫面與聲音，顯示「本次預計緩衝多久」及剩餘秒數。直播來源分享、錄製、既有工作階段和 AI 處理都會保持運作。

| 所選效能配置 | 基礎等待時間 |
| --- | --- |
| 高效能 | 20 秒 |
| 均衡 | 35 秒 |
| 省資源 | 60 秒 |

最近三次成功的 AI 處理耗時與音訊長度之比，會用來調整下一次估算；較慢時延長，最長預計 120 秒。這是緩衝預算，不是真機效能保證，也不代表 AI 一定會在該時間內完成。顯示的總時長在本次倒數開始後固定，新音訊、重複警告及後續速度測量不會把倒數重新歸零。

倒數結束後，播放器會從仍在緩衝中的可用位置繼續，優先選擇實際已完成 AI 檢查的音訊位置。為限制記憶體，過舊的音訊及影音仍可能被略過，因此不能保證完整保留所有落後的直播內容。程式會避免退回已看過的內容，或把被略過的空段當作已完成字幕。

若 AI 當時仍未追上，會明確提示「部分內容可能暫時沒有字幕」，先恢復影音，字幕繼續追趕；實際字幕覆蓋恢復後，重新遵循「等待字幕完成再播放」的選擇。若當時沒有可播放影音，倒數會收起並改顯示等候影音緩衝，不會一直停在 0 秒。

同一次持續落後不會反覆開始倒數。只有佇列、影音延遲及實際已完成字幕覆蓋連續正常至少 30 秒後，才允許新的緩衝倒數。若手動按了「暫停」，倒數結束後仍保持手動暫停；按「結束擷取」會清除倒數，之後不會自行重新播放。

較慢的 CPU 或較大的模型若長期處理不及來源速度，增加一次性等待時間無法永久解決。可改用較小模型／較省資源的配置，或選擇合適的翻譯顯卡。

## English

An overload pauses playback and shows a fixed countdown estimate: High starts at 20 seconds, Balanced at 35 and Low at 60, adjusted using recent AI speed up to 120 seconds. Capture and inference continue. Repeated alerts do not reset the active deadline. Playback then rejoins a valid buffered position, preferring actually checked audio; old content may be skipped to keep buffers bounded. If AI still lags, playback can continue temporarily without captions, with an explicit notice. Manual pause survives expiry, and Stop capture cancels the countdown. A new overload pause is rearmed only after 30 continuous healthy seconds.
