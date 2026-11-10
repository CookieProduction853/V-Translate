//! Browser page lifecycle; native dialogs work even after Chromium closes its window.
use crate::player_browser::{self, Browser};
use axum::{extract::State, Json};
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct Players {
    pages: HashMap<String, Instant>,
    revision: u64,
}
impl Players {
    fn update(&mut self, id: String, closed: bool, now: Instant) -> Option<u64> {
        self.pages
            .retain(|_, seen| now.saturating_duration_since(*seen) < Duration::from_secs(120));
        self.revision = self.revision.wrapping_add(1);
        if closed {
            self.pages.remove(&id);
        } else {
            self.pages.insert(id, now);
        }
        (closed && self.pages.is_empty()).then_some(self.revision)
    }
    fn still_closed(&self, revision: u64) -> bool {
        self.pages.is_empty() && self.revision == revision
    }
}
pub type Registry = Mutex<Players>;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Presence {
    id: String,
    closed: bool,
    english: bool,
    browser: Option<Browser>,
}
pub async fn presence(
    State(app): State<crate::Shared>,
    Json(p): Json<Presence>,
) -> crate::ApiResult<serde_json::Value> {
    if p.id.is_empty()
        || p.id.len() > 64
        || !p.id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(crate::error(
            axum::http::StatusCode::BAD_REQUEST,
            "Invalid player ID",
        ));
    }
    let revision = app
        .players
        .lock()
        .unwrap()
        .update(p.id, p.closed, Instant::now());
    #[cfg(windows)]
    if crate::windows_close::recently_handled() {
        return Ok(Json(serde_json::json!({"ok":true})));
    }
    if let Some(revision) = revision {
        tokio::spawn(async move {
            // Reloads and Profile transfers register their replacement page first.
            tokio::time::sleep(Duration::from_secs(3)).await;
            if !app.players.lock().unwrap().still_closed(revision) || *app.cancel.borrow() {
                return;
            }
            // A native dialog must not hold Tokio shutdown open if another player quits.
            let (send, receive) = tokio::sync::oneshot::channel();
            std::thread::spawn(move || {
                let _ = send.send(confirm_close(p.english));
            });
            let choice = receive.await.unwrap_or(CloseChoice::Cancel);
            respond_if_closed(&app, revision, choice, || {
                let url = format!("{}/#token={}", app.origin, app.token);
                player_browser::reopen(&url, p.browser)
            });
        });
    }
    Ok(Json(serde_json::json!({"ok":true})))
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CloseChoice {
    Shutdown,
    Reopen,
    Cancel,
}

fn respond_if_closed(
    app: &crate::Shared,
    revision: u64,
    choice: CloseChoice,
    reopen: impl FnOnce() -> anyhow::Result<()>,
) {
    let players = app.players.lock().unwrap();
    if !players.still_closed(revision) || *app.cancel.borrow() {
        return;
    }
    match choice {
        CloseChoice::Shutdown => {
            app.cancel.send_replace(true);
            app.quit.notify_one();
        }
        CloseChoice::Reopen => {
            // This was the last player. Drop a stale capture even if its unload request was lost.
            *app.session.lock().unwrap() = None;
            if let Err(error) = reopen() {
                eprintln!("Unable to reopen the player: {error:#}");
            }
        }
        CloseChoice::Cancel => {}
    }
}

pub(crate) fn confirm_close(english: bool) -> CloseChoice {
    #[cfg(any(windows, target_os = "macos"))]
    let question = if english {
        "Shut down background Whisper? Choose No to keep it running and reopen the player."
    } else {
        "要關閉背景 Whisper 嗎？選「否」會保留背景服務並重開播放器。"
    };
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, IDNO, IDYES, MB_DEFBUTTON2, MB_ICONQUESTION, MB_SETFOREGROUND, MB_YESNO,
        };
        let text: Vec<u16> = question.encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "油字幕 / V-Translate"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        match MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_YESNO | MB_ICONQUESTION | MB_SETFOREGROUND | MB_DEFBUTTON2,
        ) {
            IDYES => CloseChoice::Shutdown,
            IDNO => CloseChoice::Reopen,
            _ => CloseChoice::Cancel,
        }
    }
    #[cfg(target_os = "macos")]
    {
        let (no, yes) = if english {
            ("No", "Yes")
        } else {
            ("否", "是")
        };
        let script = format!("set answer to display dialog \"{question}\" with title \"油字幕 / V-Translate\" buttons {{\"{no}\", \"{yes}\"}} default button \"{no}\" giving up after 120\nif gave up of answer then return \"cancel\"\nreturn button returned of answer");
        let output = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output();
        match output {
            Ok(answer) if answer.status.success() => {
                let answer = String::from_utf8_lossy(&answer.stdout);
                match answer.trim() {
                    choice if choice == yes => CloseChoice::Shutdown,
                    choice if choice == no => CloseChoice::Reopen,
                    _ => CloseChoice::Cancel,
                }
            }
            _ => CloseChoice::Cancel,
        }
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let question = if english {
            "The player is closed. Shut down background Whisper and release AI resources?"
        } else {
            "播放器已關閉。是否同時關閉背景 Whisper 並釋放 AI 資源？"
        };
        if std::process::Command::new("zenity")
            .args([
                "--question",
                "--title=V-Translate",
                "--text",
                question,
                "--timeout=120",
            ])
            .status()
            .is_ok_and(|s| s.success())
        {
            CloseChoice::Shutdown
        } else {
            CloseChoice::Cancel
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_last_closed_page_prompts_and_reload_or_reopen_cancels_shutdown() {
        let mut pages = Players::default();
        let now = Instant::now();
        assert_eq!(pages.update("a".into(), false, now), None);
        assert_eq!(pages.update("b".into(), false, now), None);
        assert_eq!(pages.update("a".into(), true, now), None);
        let closed = pages.update("b".into(), true, now).unwrap();
        assert!(pages.still_closed(closed));
        pages.update("reload".into(), false, now);
        assert!(!pages.still_closed(closed));
        let next = pages.update("reload".into(), true, now).unwrap();
        assert!(pages.still_closed(next));
        assert!(!pages.still_closed(closed));
    }

    #[test]
    fn no_reopens_the_last_player_and_preserves_background_service() {
        let dir = tempfile::tempdir().unwrap();
        let app = std::sync::Arc::new(crate::App {
            token: "test-secret".into(),
            origin: "http://127.0.0.1:1234".into(),
            status: Mutex::new(crate::Status {
                ready: true,
                ..Default::default()
            }),
            settings: Mutex::new(Default::default()),
            appearance: Mutex::new(Default::default()),
            operation: Mutex::new(()),
            vocabulary: Mutex::new(crate::VocabularyStore::load(dir.path()).unwrap()),
            engine: tokio::sync::Mutex::new(None),
            session: Mutex::new(Some(crate::Session {
                id: "old-capture".into(),
                next_start: 0.,
                vocabulary: None,
            })),
            assets: crate::assets::AssetManager::new(dir.path().to_owned()),
            ads: crate::ads::AdsManager::new(dir.path().to_owned(), crate::BUNDLED_ADS),
            quit: tokio::sync::Notify::new(),
            cancel: tokio::sync::watch::channel(false).0,
            last_capture: Mutex::new(Instant::now()),
            players: Default::default(),
        });
        let now = Instant::now();
        let revision = app
            .players
            .lock()
            .unwrap()
            .update("old".into(), true, now)
            .unwrap();
        let mut opened = false;
        respond_if_closed(&app, revision, CloseChoice::Reopen, || {
            assert!(app.session.lock().unwrap().is_none());
            opened = true;
            Ok(())
        });
        assert!(opened);
        assert!(app.status.lock().unwrap().ready);
        assert!(!*app.cancel.borrow());

        app.players.lock().unwrap().update("new".into(), false, now);
        respond_if_closed(&app, revision, CloseChoice::Reopen, || {
            panic!("player already reopened")
        });
        let revision = app
            .players
            .lock()
            .unwrap()
            .update("new".into(), true, now)
            .unwrap();
        respond_if_closed(&app, revision, CloseChoice::Cancel, || {
            panic!("Cancel must not reopen")
        });
        assert!(!*app.cancel.borrow());
        respond_if_closed(&app, revision, CloseChoice::Shutdown, || {
            panic!("Yes must not reopen")
        });
        assert!(*app.cancel.borrow());
    }
}
