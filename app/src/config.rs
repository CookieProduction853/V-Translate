//! User-selected translation backend, persisted without credentials.
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path};

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputeBackend {
    #[default]
    Cpu,
    Vulkan,
    Metal,
}
impl ComputeBackend {
    pub fn label(self) -> &'static str {
        match self {
            Self::Cpu => "CPU",
            Self::Vulkan => "Vulkan 顯卡",
            Self::Metal => "Apple Metal 顯卡",
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PerformancePreset {
    Low,
    #[default]
    Balanced,
    High,
}
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WhisperModel {
    Tiny,
    #[default]
    Base,
    Small,
}
impl WhisperModel {
    pub fn filename(self) -> &'static str {
        match self {
            Self::Tiny => "ggml-tiny.bin",
            Self::Base => "ggml-base.bin",
            Self::Small => "ggml-small.bin",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "StoredInferenceSettings")]
pub struct InferenceSettings {
    pub backend: ComputeBackend,
    pub device: Option<String>,
    pub performance: PerformancePreset,
    pub whisper_model: WhisperModel,
    /// None selects the built-in Qwen variant for the performance preset.
    pub translation_model: Option<String>,
    pub cpu_threads: u8,
    pub chunk_seconds: u8,
    pub buffer_seconds: u16,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredInferenceSettings {
    backend: ComputeBackend,
    #[serde(default)]
    device: Option<String>,
    #[serde(default)]
    performance: PerformancePreset,
    whisper_model: Option<WhisperModel>,
    #[serde(default)]
    translation_model: Option<String>,
    cpu_threads: Option<u8>,
    chunk_seconds: Option<u8>,
    buffer_seconds: Option<u16>,
}
impl From<StoredInferenceSettings> for InferenceSettings {
    fn from(saved: StoredInferenceSettings) -> Self {
        // Legacy files without a preset keep Balanced; only a fresh install uses High.
        let defaults = Self::recommended(saved.performance);
        let chunk_seconds = saved.chunk_seconds.unwrap_or(defaults.chunk_seconds);
        Self {
            backend: saved.backend,
            device: saved.device,
            performance: saved.performance,
            whisper_model: saved.whisper_model.unwrap_or(defaults.whisper_model),
            translation_model: saved.translation_model,
            cpu_threads: saved.cpu_threads.unwrap_or(defaults.cpu_threads),
            chunk_seconds,
            buffer_seconds: saved
                .buffer_seconds
                .unwrap_or_else(|| defaults.buffer_seconds.max(u16::from(chunk_seconds))),
        }
    }
}
impl Default for InferenceSettings {
    fn default() -> Self {
        Self::recommended(PerformancePreset::High)
    }
}
impl InferenceSettings {
    pub fn recommended(performance: PerformancePreset) -> Self {
        let (whisper_model, cpu_threads, chunk_seconds, buffer_seconds) = match performance {
            PerformancePreset::Low => (WhisperModel::Tiny, 2, 8, 14),
            PerformancePreset::Balanced => (WhisperModel::Base, 3, 6, 10),
            PerformancePreset::High => (WhisperModel::Small, 6, 5, 5),
        };
        Self {
            backend: ComputeBackend::Cpu,
            device: None,
            performance,
            whisper_model,
            translation_model: None,
            cpu_threads,
            chunk_seconds,
            buffer_seconds,
        }
    }
    pub fn translation_model_label(&self) -> &str {
        if let Some(filename) = &self.translation_model {
            return filename;
        }
        match self.performance {
            PerformancePreset::Low => "Qwen2.5 0.5B（低負載，譯文品質較低）",
            _ => "Qwen2.5 1.5B",
        }
    }
    pub fn validate(&self) -> Result<()> {
        if let Some(filename) = &self.translation_model {
            crate::translation_models::validate_filename(filename)?;
        }
        anyhow::ensure!((1..=8).contains(&self.cpu_threads), "CPU 執行緒需為 1–8");
        anyhow::ensure!(
            (4..=12).contains(&self.chunk_seconds),
            "音訊片段需為 4–12 秒"
        );
        anyhow::ensure!(
            (5..=120).contains(&self.buffer_seconds),
            "起始緩衝需為 5–120 秒"
        );
        anyhow::ensure!(
            self.buffer_seconds >= u16::from(self.chunk_seconds),
            "起始緩衝不能短於音訊片段"
        );
        if let Some(device) = &self.device {
            let prefix = match self.backend {
                ComputeBackend::Cpu => anyhow::bail!("CPU 模式不使用顯卡裝置"),
                ComputeBackend::Vulkan => "Vulkan",
                ComputeBackend::Metal => "MTL",
            };
            let number = device
                .strip_prefix(prefix)
                .context("顯卡裝置 ID 格式不正確")?;
            anyhow::ensure!(
                !number.is_empty()
                    && number.len() <= 5
                    && number.bytes().all(|b| b.is_ascii_digit()),
                "顯卡裝置 ID 格式不正確"
            );
        }
        Ok(())
    }
    pub fn load(root: &Path) -> Result<Self> {
        let path = root.join("settings.json");
        if !path.exists() {
            return Ok(Self::default());
        }
        let settings: Self = serde_json::from_slice(&std::fs::read(path)?)
            .context("本機 settings.json 設定損壞，請修正或移除該檔案後重試")?;
        settings.validate()?;
        Ok(settings)
    }
    pub fn save(&self, root: &Path) -> Result<()> {
        self.validate()?;
        let mut file = tempfile::NamedTempFile::new_in(root).context("無法寫入本機運算設定")?;
        file.write_all(&serde_json::to_vec_pretty(self)?)?;
        file.as_file().sync_all()?;
        file.persist(root.join("settings.json"))
            .context("無法保存本機運算設定")?;
        Ok(())
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UiTheme {
    #[default]
    #[serde(alias = "cinema")]
    Studio,
    Light,
}
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum UiLanguage {
    #[default]
    #[serde(rename = "zh-Hant")]
    TraditionalChinese,
    #[serde(rename = "en")]
    English,
}
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppearanceSettings {
    pub theme: UiTheme,
    #[serde(default)]
    pub language: UiLanguage,
    #[serde(default)]
    pub onboarding_complete: bool,
}
impl AppearanceSettings {
    pub fn load(root: &Path) -> Result<Self> {
        let path = root.join("appearance.json");
        if !path.exists() {
            return Ok(Self::default());
        }
        let mut settings: Self = serde_json::from_slice(&std::fs::read(path)?)
            .context("appearance.json 外觀設定損壞")?;
        settings.onboarding_complete = root.join("onboarding-complete").try_exists()?;
        Ok(settings)
    }
    pub fn save(&self, root: &Path) -> Result<()> {
        let mut file = tempfile::NamedTempFile::new_in(root)?;
        let appearance = serde_json::json!({"theme":self.theme,"language":self.language});
        file.write_all(&serde_json::to_vec_pretty(&appearance)?)?;
        file.as_file().sync_all()?;
        file.persist(root.join("appearance.json"))?;
        if self.onboarding_complete {
            std::fs::File::create(root.join("onboarding-complete"))?;
        }
        Ok(())
    }
}
#[cfg(test)]
mod appearance_tests {
    use super::*;
    #[test]
    fn themes_persist_independently_of_compute_settings() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            AppearanceSettings::load(dir.path()).unwrap().theme,
            UiTheme::Studio
        );
        AppearanceSettings {
            theme: UiTheme::Light,
            language: UiLanguage::English,
            onboarding_complete: true,
        }
        .save(dir.path())
        .unwrap();
        assert_eq!(
            AppearanceSettings::load(dir.path()).unwrap(),
            AppearanceSettings {
                theme: UiTheme::Light,
                language: UiLanguage::English,
                onboarding_complete: true,
            }
        );
        assert_eq!(
            InferenceSettings::load(dir.path()).unwrap().backend,
            ComputeBackend::Cpu
        );
        assert!(serde_json::from_str::<AppearanceSettings>(r#"{"theme":"external.css"}"#).is_err());
        assert!(serde_json::from_str::<AppearanceSettings>(
            r#"{"theme":"studio","language":"ja"}"#
        )
        .is_err());
    }
    #[test]
    fn legacy_appearance_migrates_and_serializes_canonical_values() {
        let dir = tempfile::tempdir().unwrap();
        for (legacy, expected) in [
            ("cinema", UiTheme::Studio),
            ("studio", UiTheme::Studio),
            ("light", UiTheme::Light),
        ] {
            std::fs::write(
                dir.path().join("appearance.json"),
                format!(r#"{{"theme":"{legacy}"}}"#),
            )
            .unwrap();
            let appearance = AppearanceSettings::load(dir.path()).unwrap();
            assert_eq!(appearance.theme, expected);
            assert_eq!(appearance.language, UiLanguage::TraditionalChinese);
            appearance.save(dir.path()).unwrap();
            assert_eq!(AppearanceSettings::load(dir.path()).unwrap(), appearance);
            let persisted: serde_json::Value =
                serde_json::from_slice(&std::fs::read(dir.path().join("appearance.json")).unwrap())
                    .unwrap();
            assert_eq!(
                persisted["theme"],
                if expected == UiTheme::Light {
                    "light"
                } else {
                    "studio"
                }
            );
            assert_eq!(persisted["language"], "zh-Hant");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_run_defaults_to_cpu_and_roundtrips_gpu_selection() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            InferenceSettings::load(dir.path()).unwrap(),
            InferenceSettings::default()
        );
        assert_eq!(
            InferenceSettings::default(),
            InferenceSettings::recommended(PerformancePreset::High)
        );
        assert_eq!(
            (
                InferenceSettings::default().whisper_model,
                InferenceSettings::default().cpu_threads,
                InferenceSettings::default().chunk_seconds,
                InferenceSettings::default().buffer_seconds
            ),
            (WhisperModel::Small, 6, 5, 5)
        );
        let gpu = InferenceSettings {
            backend: ComputeBackend::Vulkan,
            device: Some("Vulkan1".into()),
            ..InferenceSettings::default()
        };
        gpu.save(dir.path()).unwrap();
        assert_eq!(InferenceSettings::load(dir.path()).unwrap(), gpu);
        InferenceSettings::default().save(dir.path()).unwrap();
        assert_eq!(
            InferenceSettings::load(dir.path()).unwrap(),
            InferenceSettings::default()
        );
    }
    #[test]
    fn rejects_unknown_backends_and_invalid_device_ids() {
        assert!(serde_json::from_str::<InferenceSettings>(r#"{"backend":"cuda"}"#).is_err());
        for id in [
            "",
            "cpu",
            "Vulkan",
            "Vulkan0 --evil",
            "../../Vulkan0",
            "Vulkan999999",
        ] {
            assert!(InferenceSettings {
                backend: ComputeBackend::Vulkan,
                device: Some(id.into()),
                ..InferenceSettings::default()
            }
            .validate()
            .is_err());
        }
        assert!(InferenceSettings {
            backend: ComputeBackend::Cpu,
            device: Some("Vulkan0".into()),
            ..InferenceSettings::default()
        }
        .validate()
        .is_err());
    }
    #[test]
    fn metal_selection_roundtrips_and_rejects_mismatched_or_injected_ids() {
        let dir = tempfile::tempdir().unwrap();
        let metal = InferenceSettings {
            backend: ComputeBackend::Metal,
            device: Some("MTL0".into()),
            ..InferenceSettings::default()
        };
        metal.save(dir.path()).unwrap();
        assert_eq!(InferenceSettings::load(dir.path()).unwrap(), metal);
        let encoded = serde_json::to_value(&metal).unwrap();
        assert_eq!(encoded["backend"], "metal");
        for id in [
            "MTL",
            "Metal0",
            "Metal",
            "Vulkan0",
            "CPU0",
            "MTL0,CPU0",
            "MTL0 --evil",
            "../MTL0",
            "MTL999999",
        ] {
            assert!(
                InferenceSettings {
                    device: Some(id.into()),
                    ..metal.clone()
                }
                .validate()
                .is_err(),
                "{id}"
            );
        }
        assert!(InferenceSettings {
            backend: ComputeBackend::Vulkan,
            device: Some("MTL0".into()),
            ..InferenceSettings::default()
        }
        .validate()
        .is_err());
    }
    #[test]
    fn presets_have_bounded_resources_and_old_settings_migrate() {
        let old: InferenceSettings =
            serde_json::from_str(r#"{"backend":"cpu","device":null}"#).unwrap();
        assert_eq!(
            old,
            InferenceSettings::recommended(PerformancePreset::Balanced)
        );
        let balanced: InferenceSettings =
            serde_json::from_str(r#"{"backend":"cpu","performance":"balanced"}"#).unwrap();
        assert_eq!(
            balanced,
            InferenceSettings::recommended(PerformancePreset::Balanced)
        );
        let high_with_custom_chunk: InferenceSettings =
            serde_json::from_str(r#"{"backend":"cpu","performance":"high","chunk_seconds":8}"#)
                .unwrap();
        high_with_custom_chunk.validate().unwrap();
        assert_eq!(high_with_custom_chunk.chunk_seconds, 8);
        assert_eq!(high_with_custom_chunk.buffer_seconds, 8);
        let saved: InferenceSettings = serde_json::from_str(
            r#"{"backend":"cpu","device":null,"performance":"balanced","whisper_model":"base","cpu_threads":4,"chunk_seconds":7,"buffer_seconds":40}"#,
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        saved.save(dir.path()).unwrap();
        assert_eq!(InferenceSettings::load(dir.path()).unwrap(), saved);
        assert_eq!(
            (
                saved.performance,
                saved.whisper_model,
                saved.cpu_threads,
                saved.chunk_seconds,
                saved.buffer_seconds
            ),
            (PerformancePreset::Balanced, WhisperModel::Base, 4, 7, 40)
        );
        let low = InferenceSettings::recommended(PerformancePreset::Low);
        assert_eq!(
            (
                low.whisper_model,
                low.cpu_threads,
                low.chunk_seconds,
                low.buffer_seconds
            ),
            (WhisperModel::Tiny, 2, 8, 14)
        );
        for (preset, chunk_seconds, headroom) in [
            (PerformancePreset::Low, 8, 6),
            (PerformancePreset::Balanced, 6, 4),
            (PerformancePreset::High, 5, 0),
        ] {
            let settings = InferenceSettings::recommended(preset);
            settings.validate().unwrap();
            assert_eq!(settings.chunk_seconds, chunk_seconds);
            assert_eq!(settings.buffer_seconds, u16::from(chunk_seconds) + headroom);
        }
        let mut invalid = low;
        invalid.cpu_threads = 0;
        assert!(invalid.validate().is_err());
        invalid.cpu_threads = 9;
        assert!(invalid.validate().is_err());
        invalid.cpu_threads = 2;
        invalid.chunk_seconds = 20;
        assert!(invalid.validate().is_err());
        assert!(serde_json::from_str::<InferenceSettings>(
            r#"{"backend":"cpu","whisper_model":"../../evil"}"#
        )
        .is_err());
    }
    #[test]
    fn corrupt_settings_are_reported_without_overwriting_user_choice() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), "{bad json").unwrap();
        assert!(InferenceSettings::load(dir.path()).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("settings.json")).unwrap(),
            "{bad json"
        );
    }
    #[test]
    fn custom_translation_selection_roundtrips_without_changing_preset_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let custom = InferenceSettings {
            translation_model: Some("Local Chat Q4.GGUF".into()),
            ..InferenceSettings::default()
        };
        custom.save(dir.path()).unwrap();
        assert_eq!(InferenceSettings::load(dir.path()).unwrap(), custom);
        assert_eq!(custom.translation_model_label(), "Local Chat Q4.GGUF");
        let legacy: InferenceSettings = serde_json::from_str(r#"{"backend":"cpu"}"#).unwrap();
        assert_eq!(legacy.performance, PerformancePreset::Balanced);
        assert_eq!(legacy.translation_model, None);
        assert_eq!(InferenceSettings::default().translation_model, None);
        let json = serde_json::to_value(legacy).unwrap();
        assert_eq!(json["translation_model"], serde_json::Value::Null);
        let unsafe_selection: InferenceSettings =
            serde_json::from_str(r#"{"backend":"cpu","translation_model":"../outside.gguf"}"#)
                .unwrap();
        assert!(unsafe_selection.validate().is_err());
    }
}
