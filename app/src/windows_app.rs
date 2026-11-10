//! Apply the launcher artwork to the Chromium app window we just opened.
//!
//! Chromium may hand the launch request to an existing browser process, so a
//! child PID cannot reliably identify that window. Restrict the search to new
//! top-level windows, the selected browser executable, and our exact page title.

use std::{
    collections::HashSet,
    ffi::c_void,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    sync::OnceLock,
    thread,
    time::{Duration, Instant},
};
use windows_sys::{
    core::{GUID, HRESULT},
    Win32::{
        Foundation::{CloseHandle, BOOL, HWND, LPARAM},
        System::{
            Com::{
                CoInitializeEx, CoUninitialize, StructuredStorage::PROPVARIANT,
                COINIT_APARTMENTTHREADED,
            },
            LibraryLoader::GetModuleHandleW,
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
            },
            Variant::VT_LPWSTR,
        },
        UI::{
            Shell::PropertiesSystem::{SHGetPropertyStoreForWindow, PROPERTYKEY},
            WindowsAndMessaging::{
                DestroyIcon, EnumWindows, GetClassNameW, GetSystemMetrics, GetWindowTextW,
                GetWindowThreadProcessId, IsWindowVisible, LoadImageW, SendMessageTimeoutW,
                ICON_BIG, ICON_SMALL, IMAGE_ICON, SMTO_ABORTIFHUNG, SM_CXICON, SM_CXSMICON,
                SM_CYICON, SM_CYSMICON, WM_SETICON,
            },
        },
    },
};

const ICON_RESOURCE: usize = 1;
const APP_PROPERTIES: GUID = GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3);
const PROPERTY_STORE_IID: GUID = GUID::from_u128(0x886d8eeb_8cf2_4446_8d02_cdba1dbdcf99);

pub struct WindowsLaunch {
    existing: Option<HashSet<usize>>,
}

impl WindowsLaunch {
    pub fn snapshot() -> Self {
        Self {
            existing: window_handles().map(|windows| windows.into_iter().collect()),
        }
    }

    pub fn apply_to_new_window(
        self,
        browser: PathBuf,
        url: String,
        kind: crate::player_browser::Browser,
    ) {
        let Some(existing) = self.existing else {
            return;
        };
        let runtime = tokio::runtime::Handle::current();
        thread::spawn(move || unsafe {
            let icons = app_icons();
            let browser = browser.canonicalize().unwrap_or(browser);
            let initialized = CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32) >= 0;
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut selected = None;
            while Instant::now() < deadline {
                if let Some(windows) = window_handles() {
                    for window in windows {
                        let hwnd = window as HWND;
                        if !existing.contains(&window) && is_app_window(hwnd, &browser) {
                            set_taskbar_identity(hwnd);
                            if let Some((big, small)) = icons {
                                set_icon(hwnd, ICON_BIG, big as isize);
                                set_icon(hwnd, ICON_SMALL, small as isize);
                            }
                            selected = Some(hwnd);
                            break;
                        }
                    }
                }
                if selected.is_some() {
                    break;
                }
                thread::sleep(Duration::from_millis(200));
            }
            if let Some(window) = selected {
                crate::windows_close::watch(window, url, runtime, kind);
            }
            if initialized {
                CoUninitialize();
            }
        });
    }
}

fn app_icons() -> Option<(usize, usize)> {
    // Keep one independently sized pair alive for the process lifetime: the
    // browser window can continue using these icons after the worker returns.
    // LR_SHARED can reuse the first cached size for both LoadImageW calls.
    static ICONS: OnceLock<Option<(usize, usize)>> = OnceLock::new();
    *ICONS.get_or_init(|| unsafe {
        let module = GetModuleHandleW(null());
        let big = LoadImageW(
            module,
            ICON_RESOURCE as *const u16,
            IMAGE_ICON,
            GetSystemMetrics(SM_CXICON),
            GetSystemMetrics(SM_CYICON),
            0,
        );
        let small = LoadImageW(
            module,
            ICON_RESOURCE as *const u16,
            IMAGE_ICON,
            GetSystemMetrics(SM_CXSMICON),
            GetSystemMetrics(SM_CYSMICON),
            0,
        );
        if big.is_null() || small.is_null() {
            if !big.is_null() {
                DestroyIcon(big);
            }
            if !small.is_null() {
                DestroyIcon(small);
            }
            None
        } else {
            Some((big as usize, small as usize))
        }
    })
}

fn window_handles() -> Option<Vec<usize>> {
    unsafe extern "system" fn collect(window: HWND, context: LPARAM) -> BOOL {
        let windows = &mut *(context as *mut Vec<usize>);
        windows.push(window as usize);
        1
    }
    let mut windows = Vec::new();
    let succeeded = unsafe { EnumWindows(Some(collect), &mut windows as *mut _ as LPARAM) };
    (succeeded != 0).then_some(windows)
}

unsafe fn is_app_window(window: HWND, browser: &Path) -> bool {
    if IsWindowVisible(window) == 0 {
        return false;
    }
    let mut class = [0u16; 64];
    let class_length = GetClassNameW(window, class.as_mut_ptr(), class.len() as i32);
    if class_length <= 0
        || String::from_utf16_lossy(&class[..class_length as usize]) != "Chrome_WidgetWin_1"
    {
        return false;
    }
    let mut title = [0u16; 512];
    let title_length = GetWindowTextW(window, title.as_mut_ptr(), title.len() as i32);
    if title_length <= 0
        || !is_app_title(&String::from_utf16_lossy(&title[..title_length as usize]))
    {
        return false;
    }
    let mut process_id = 0;
    GetWindowThreadProcessId(window, &mut process_id);
    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
    if process.is_null() {
        return false;
    }
    let mut executable = vec![0u16; 32768];
    let mut length = executable.len() as u32;
    let succeeded = QueryFullProcessImageNameW(process, 0, executable.as_mut_ptr(), &mut length);
    CloseHandle(process);
    if succeeded == 0 {
        return false;
    }
    let executable = PathBuf::from(String::from_utf16_lossy(&executable[..length as usize]));
    let executable = executable.canonicalize().unwrap_or(executable);
    executable
        .as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&browser.as_os_str().to_string_lossy())
}

fn is_app_title(title: &str) -> bool {
    title
        == format!(
            "油字幕 v{} · 本地 AI Vtuber 即時字幕",
            env!("CARGO_PKG_VERSION")
        )
        || title
            == format!(
                "V-Translate v{} · Real time local AI translator for Vtuber viewers.",
                env!("CARGO_PKG_VERSION")
            )
}

unsafe fn set_icon(window: HWND, size: u32, icon: isize) {
    SendMessageTimeoutW(
        window,
        WM_SETICON,
        size as usize,
        icon,
        SMTO_ABORTIFHUNG,
        250,
        null_mut(),
    );
}

// windows-sys exposes the shell function but not COM interface methods. Keep
// this minimal IPropertyStore ABI declaration local to the window integration.
#[repr(C)]
struct PropertyStore {
    vtable: *const PropertyStoreVtable,
}

#[repr(C)]
struct PropertyStoreVtable {
    query_interface:
        unsafe extern "system" fn(*mut PropertyStore, *const GUID, *mut *mut c_void) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut PropertyStore) -> u32,
    release: unsafe extern "system" fn(*mut PropertyStore) -> u32,
    get_count: unsafe extern "system" fn(*mut PropertyStore, *mut u32) -> HRESULT,
    get_at: unsafe extern "system" fn(*mut PropertyStore, u32, *mut PROPERTYKEY) -> HRESULT,
    get_value: unsafe extern "system" fn(
        *mut PropertyStore,
        *const PROPERTYKEY,
        *mut PROPVARIANT,
    ) -> HRESULT,
    set_value: unsafe extern "system" fn(
        *mut PropertyStore,
        *const PROPERTYKEY,
        *const PROPVARIANT,
    ) -> HRESULT,
    commit: unsafe extern "system" fn(*mut PropertyStore) -> HRESULT,
}

unsafe fn set_taskbar_identity(window: HWND) {
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    let mut store = null_mut();
    if SHGetPropertyStoreForWindow(window, &PROPERTY_STORE_IID, &mut store) < 0 || store.is_null() {
        return;
    }
    let store = store as *mut PropertyStore;
    let path = executable.to_string_lossy();
    // Set relaunch metadata before the AppUserModelID, as required by the shell.
    set_property(store, 2, &format!("\"{path}\""));
    set_property(store, 3, &format!("{path},-1"));
    set_property(store, 4, &format!("@{path},-101"));
    set_property(store, 5, "V-Translate.LocalPlayer");
    ((*(*store).vtable).commit)(store);
    ((*(*store).vtable).release)(store);
}

unsafe fn set_property(store: *mut PropertyStore, id: u32, value: &str) {
    let key = PROPERTYKEY {
        fmtid: APP_PROPERTIES,
        pid: id,
    };
    let mut string: Vec<u16> = std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let mut variant: PROPVARIANT = std::mem::zeroed();
    variant.Anonymous.Anonymous.vt = VT_LPWSTR;
    variant.Anonymous.Anonymous.Anonymous.pwszVal = string.as_mut_ptr();
    ((*(*store).vtable).set_value)(store, &key, &variant);
    // The store copies the string. The variant only borrows `string`, so it
    // must not be passed to PropVariantClear (which would free Rust memory).
}
