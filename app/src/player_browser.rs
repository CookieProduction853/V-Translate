//! Open a trusted loopback player in the browser that owns the source tab.
use anyhow::{Context, Result};
use serde::Deserialize;
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Browser {
    Chrome,
    Edge,
}
fn order(preferred: Option<Browser>) -> Vec<Browser> {
    preferred.map_or_else(
        || vec![Browser::Chrome, Browser::Edge],
        |browser| vec![browser],
    )
}
pub fn open(url: &str, preferred: Option<Browser>) -> Result<()> {
    open_window(url, preferred, preferred.is_none())
}
pub fn reopen(url: &str, preferred: Option<Browser>) -> Result<()> {
    open_window(url, preferred, true)
}
fn open_window(url: &str, preferred: Option<Browser>, app_window: bool) -> Result<()> {
    anyhow::ensure!(crate::valid_player_url(url), "無效的本機播放器位址");
    #[cfg(windows)]
    {
        use std::{os::windows::process::CommandExt, path::PathBuf};
        for browser in order(preferred) {
            let relative = match browser {
                Browser::Chrome => "Google/Chrome/Application/chrome.exe",
                Browser::Edge => "Microsoft/Edge/Application/msedge.exe",
            };
            for variable in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
                let Some(base) = std::env::var_os(variable) else {
                    continue;
                };
                let executable = PathBuf::from(base).join(relative);
                if !executable.is_file() {
                    continue;
                }
                let mut command = std::process::Command::new(&executable);
                if app_window {
                    command.arg(format!("--app={url}"));
                } else {
                    command.arg("--new-window").arg(url);
                }
                let icon = app_window.then(crate::windows_app::WindowsLaunch::snapshot);
                command
                    .creation_flags(0x08000000)
                    .spawn()
                    .context("無法開啟所選瀏覽器")?;
                if let Some(icon) = icon {
                    icon.apply_to_new_window(executable, url.to_owned(), browser);
                }
                return Ok(());
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::path::PathBuf;
        let mut locations = vec![PathBuf::from("/Applications")];
        if let Some(base) = directories::BaseDirs::new() {
            locations.push(base.home_dir().join("Applications"));
        }
        for browser in order(preferred) {
            let (bundle, name) = match browser {
                Browser::Chrome => ("Google Chrome.app", "Google Chrome"),
                Browser::Edge => ("Microsoft Edge.app", "Microsoft Edge"),
            };
            for directory in &locations {
                let executable = directory.join(bundle).join("Contents/MacOS").join(name);
                if !executable.is_file() {
                    continue;
                }
                let mut command = std::process::Command::new(executable);
                if app_window {
                    command.arg(format!("--app={url}"));
                } else {
                    command.arg("--new-window").arg(url);
                }
                command
                    .stdin(std::process::Stdio::null())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .context("無法開啟所選瀏覽器")?;
                return Ok(());
            }
        }
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let _ = app_window;
        if preferred.is_none() {
            std::process::Command::new("xdg-open")
                .arg(url)
                .spawn()
                .context("無法開啟瀏覽器")?;
            return Ok(());
        }
        for browser in order(preferred) {
            let names: &[&str] = match browser {
                Browser::Chrome => &[
                    "google-chrome",
                    "google-chrome-stable",
                    "chromium",
                    "chromium-browser",
                ],
                Browser::Edge => &["microsoft-edge", "microsoft-edge-stable"],
            };
            for name in names {
                match std::process::Command::new(name)
                    .arg("--new-window")
                    .arg(url)
                    .spawn()
                {
                    Ok(_) => return Ok(()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(e).context("無法開啟所選瀏覽器"),
                }
            }
        }
    }
    anyhow::bail!("找不到所選瀏覽器，請先安裝，或複製播放器連結到直播所在的瀏覽器／Profile。")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_never_falls_back_to_a_different_browser() {
        assert_eq!(order(None), vec![Browser::Chrome, Browser::Edge]);
        assert_eq!(order(Some(Browser::Chrome)), vec![Browser::Chrome]);
        assert_eq!(order(Some(Browser::Edge)), vec![Browser::Edge]);
        assert!(serde_json::from_str::<Browser>("\"chrome --remote-debugging-port=1\"").is_err());
    }
}
