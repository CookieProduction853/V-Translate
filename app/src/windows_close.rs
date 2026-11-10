//! Intercept only the launcher's own Chromium caption X, before it reaches Chromium.
use crate::{player_browser, player_lifecycle::CloseChoice};
use std::{
    cell::Cell,
    ptr::{null, null_mut},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
    UI::WindowsAndMessaging::*,
};
thread_local! {
    static TARGET: Cell<HWND> = const { Cell::new(null_mut()) };
    static PENDING: Cell<bool> = const { Cell::new(false) };
}
const ASK: u32 = WM_APP + 55;
static WATCHERS: AtomicUsize = AtomicUsize::new(0);
static HANDLED: Mutex<Option<Instant>> = Mutex::new(None);
pub fn recently_handled() -> bool {
    WATCHERS.load(Ordering::Relaxed) > 0
        || HANDLED
            .lock()
            .unwrap()
            .is_some_and(|time| time.elapsed() < Duration::from_secs(10))
}
unsafe extern "system" fn mouse(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
    if code >= 0 && matches!(message as u32, WM_LBUTTONDOWN | WM_LBUTTONUP) {
        let point = (*(data as *const MSLLHOOKSTRUCT)).pt;
        let target = TARGET.get();
        if !target.is_null() && GetAncestor(WindowFromPoint(point), GA_ROOT) == target {
            let packed = ((point.y as u32 & 0xffff) << 16 | (point.x as u32 & 0xffff)) as LPARAM;
            let mut hit = 0;
            if SendMessageTimeoutW(
                target,
                WM_NCHITTEST,
                0,
                packed,
                SMTO_ABORTIFHUNG,
                100,
                &mut hit,
            ) != 0
                && hit == HTCLOSE as usize
            {
                if message as u32 == WM_LBUTTONDOWN && !PENDING.replace(true) {
                    PostThreadMessageW(GetCurrentThreadId(), ASK, 0, 0);
                }
                return 1;
            }
        }
    }
    CallNextHookEx(null_mut(), code, message, data)
}
async fn stop(url: &str) -> anyhow::Result<()> {
    anyhow::ensure!(crate::valid_player_url(url), "Invalid player URL");
    let (origin, token) = url.split_once("/#token=").unwrap();
    reqwest::Client::new()
        .post(format!("{origin}/api/quit"))
        .bearer_auth(token)
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}
/// Own a message pump for the low-level hook; never block inside its callback.
pub unsafe fn watch(
    window: HWND,
    url: String,
    runtime: tokio::runtime::Handle,
    browser: player_browser::Browser,
) {
    watch_inner(window, &url, &runtime, ask, || {
        let _runtime = runtime.enter();
        player_browser::reopen(&url, Some(browser))
    });
}
unsafe fn ask(window: HWND) -> i32 {
    let text: Vec<u16> = "是否同時關閉背景 Whisper／本機服務？\n\n是 / Yes：關閉播放器及 Whisper，釋放 AI 資源\n否 / No：保留 Whisper 並重開播放器\n取消 / Cancel：返回目前播放器".encode_utf16().chain(Some(0)).collect();
    let title: Vec<u16> = "油字幕 / V-Translate"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    MessageBoxW(
        window,
        text.as_ptr(),
        title.as_ptr(),
        MB_YESNOCANCEL | MB_ICONQUESTION | MB_SETFOREGROUND | MB_DEFBUTTON3,
    )
}
unsafe fn watch_inner(
    window: HWND,
    url: &str,
    runtime: &tokio::runtime::Handle,
    prompt: unsafe fn(HWND) -> i32,
    reopen: impl FnOnce() -> anyhow::Result<()>,
) {
    TARGET.set(window);
    let hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse), GetModuleHandleW(null()), 0);
    if hook.is_null() {
        return;
    }
    WATCHERS.fetch_add(1, Ordering::Relaxed);
    let timer = SetTimer(null_mut(), 0, 500, None);
    let mut message = std::mem::zeroed();
    let mut choice = CloseChoice::Cancel;
    while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
        if IsWindow(window) == 0 {
            break;
        }
        if message.message == ASK {
            let answer = prompt(window);
            let title: Vec<u16> = "油字幕 / V-Translate"
                .encode_utf16()
                .chain(Some(0))
                .collect();
            if answer == IDYES || answer == IDNO {
                *HANDLED.lock().unwrap() = Some(Instant::now());
                choice = if answer == IDYES {
                    CloseChoice::Shutdown
                } else {
                    CloseChoice::Reopen
                };
                // Queue window closure before the server can exit this launcher process.
                PostMessageW(window, WM_CLOSE, 0, 0);
                if answer == IDYES && runtime.block_on(stop(url)).is_err() {
                    let error: Vec<u16> = "無法連接背景服務，請使用資料夾內 Stop-Whisper.cmd。 / Unable to stop the server. Use Stop-Whisper.cmd.".encode_utf16().chain(Some(0)).collect();
                    MessageBoxW(
                        null_mut(),
                        error.as_ptr(),
                        title.as_ptr(),
                        MB_OK | MB_ICONERROR,
                    );
                }
            }
            PENDING.set(false);
        }
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    KillTimer(null_mut(), timer);
    UnhookWindowsHookEx(hook);
    TARGET.set(null_mut());
    // Covers keyboard/system-menu/browser exits even when no unload HTTP request survives.
    if IsWindow(window) == 0 {
        if choice == CloseChoice::Cancel {
            choice = crate::player_lifecycle::confirm_close(false);
            if choice == CloseChoice::Shutdown {
                let _ = runtime.block_on(stop(url));
            }
        }
        if choice == CloseChoice::Reopen {
            *HANDLED.lock().unwrap() = Some(Instant::now());
            if reopen().is_err() {
                let error: Vec<u16> = "無法重開播放器。Whisper 仍在背景執行，請重新開啟油字幕。 / Unable to reopen the player. Whisper is still running. Launch V-Translate again.".encode_utf16().chain(Some(0)).collect();
                MessageBoxW(null_mut(), error.as_ptr(), null(), MB_OK | MB_ICONERROR);
            }
        }
    }
    WATCHERS.fetch_sub(1, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::{
        Foundation::RECT,
        UI::Input::KeyboardAndMouse::{mouse_event, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP},
    };
    static CHOICES: AtomicUsize = AtomicUsize::new(0);
    unsafe fn choose(window: HWND) -> i32 {
        assert_ne!(
            IsWindow(window),
            0,
            "confirmation must precede window destruction"
        );
        if CHOICES.fetch_add(1, Ordering::SeqCst) == 0 {
            IDCANCEL
        } else {
            IDNO
        }
    }
    #[test]
    fn real_native_caption_click_can_cancel_then_close_without_http_unload() {
        unsafe {
            let class: Vec<u16> = "VTranslateCloseTest"
                .encode_utf16()
                .chain(Some(0))
                .collect();
            let mut window_class: WNDCLASSW = std::mem::zeroed();
            window_class.lpfnWndProc = Some(DefWindowProcW);
            window_class.hInstance = GetModuleHandleW(null());
            window_class.lpszClassName = class.as_ptr();
            assert_ne!(RegisterClassW(&window_class), 0);
            let window = CreateWindowExW(
                0,
                class.as_ptr(),
                class.as_ptr(),
                WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                100,
                100,
                600,
                400,
                null_mut(),
                null_mut(),
                GetModuleHandleW(null()),
                null(),
            );
            assert!(!window.is_null());
            SetForegroundWindow(window);
            let window_id = window as usize;
            let thread_id = GetCurrentThreadId();
            let worker = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(700));
                let window = window_id as HWND;
                let mut rect: RECT = std::mem::zeroed();
                GetWindowRect(window, &mut rect);
                let mut point = None;
                'search: for y in rect.top..rect.top + 50 {
                    for x in (rect.right - 60)..rect.right {
                        let packed = (((y as u32 & 0xffff) << 16) | (x as u32 & 0xffff)) as LPARAM;
                        let mut hit = 0;
                        if SendMessageTimeoutW(
                            window,
                            WM_NCHITTEST,
                            0,
                            packed,
                            SMTO_ABORTIFHUNG,
                            500,
                            &mut hit,
                        ) != 0
                            && hit == HTCLOSE as usize
                        {
                            point = Some((x, y));
                            break 'search;
                        }
                    }
                }
                if let Some((x, y)) = point {
                    for expected in 1..=2 {
                        SetCursorPos(x, y);
                        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
                        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
                        for _ in 0..40 {
                            if CHOICES.load(Ordering::SeqCst) >= expected {
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(50));
                        }
                        if expected == 1 && IsWindow(window) == 0 {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(300));
                    }
                }
                std::thread::sleep(Duration::from_millis(500));
                PostThreadMessageW(thread_id, WM_QUIT, 0, 0);
            });
            let runtime = tokio::runtime::Runtime::new().unwrap();
            let mut reopened = false;
            watch_inner(window, "", runtime.handle(), choose, || {
                assert_eq!(
                    IsWindow(window),
                    0,
                    "reopen must follow the old window's closure"
                );
                reopened = true;
                Ok(())
            });
            worker.join().unwrap();
            let destroyed = IsWindow(window) == 0;
            if !destroyed {
                DestroyWindow(window);
            }
            assert_eq!(
                CHOICES.load(Ordering::SeqCst),
                2,
                "both real caption clicks must be intercepted"
            );
            assert!(destroyed, "No closes the old player after confirmation");
            assert!(reopened, "No reopens the player");
        }
    }
}
