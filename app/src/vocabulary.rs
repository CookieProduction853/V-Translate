//! Shareable vocabulary hints, not executable code or trained model weights.
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::Write,
    path::{Path, PathBuf},
};

const MAX_PACK_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct VocabularyTerm {
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reading: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct VocabularyPack {
    pub format_version: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub terms: Vec<VocabularyTerm>,
}

fn valid_text(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.chars().count() <= max && !text.chars().any(char::is_control)
}
fn contains_phrase(text: &str, phrase: &str) -> bool {
    if phrase.is_ascii() && phrase.bytes().any(|c| c.is_ascii_alphanumeric()) {
        text.match_indices(phrase).any(|(start, _)| {
            let before = text[..start].chars().next_back();
            let after = text[start + phrase.len()..].chars().next();
            before.is_none_or(|c| !c.is_ascii_alphanumeric() && c != '_')
                && after.is_none_or(|c| !c.is_ascii_alphanumeric() && c != '_')
        })
    } else {
        text.contains(phrase)
    }
}
fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
impl VocabularyPack {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            self.format_version == 1,
            "不支援這個詞彙包版本，需使用 format_version: 1"
        );
        anyhow::ensure!(
            valid_text(&self.name, 80),
            "詞彙包名稱需為 1–80 字，不能含控制字元"
        );
        anyhow::ensure!(
            self.language
                .as_deref()
                .is_none_or(|l| ["ja", "en", "zh", "ko", "auto"].contains(&l)),
            "詞彙包語言需為 ja、en、zh、ko 或 auto"
        );
        anyhow::ensure!(
            (1..=128).contains(&self.terms.len()),
            "詞彙包需包含 1–128 個詞語"
        );
        let mut sources = std::collections::HashSet::new();
        for term in &self.terms {
            anyhow::ensure!(
                valid_text(&term.source, 80),
                "詞語 source 需為 1–80 字，不能含控制字元"
            );
            anyhow::ensure!(
                term.reading.as_deref().is_none_or(|s| valid_text(s, 80)),
                "reading 需為 1–80 字，或省略此欄位"
            );
            anyhow::ensure!(
                term.target.as_deref().is_none_or(|s| valid_text(s, 120)),
                "target 需為 1–120 字，或省略此欄位"
            );
            anyhow::ensure!(
                sources.insert(term.source.trim().to_lowercase()),
                "詞彙包包含重複的 source"
            );
        }
        anyhow::ensure!(
            serde_json::to_vec_pretty(self)?.len() <= MAX_PACK_BYTES,
            "詞彙包不能超過 64 KiB"
        );
        Ok(())
    }
    /// The server retains prompt parameters between requests, so callers must
    /// send an explicit empty string when no pack applies.
    pub fn whisper_prompt(&self, language: &str) -> String {
        if self
            .language
            .as_deref()
            .is_some_and(|l| l != "auto" && language != "auto" && l != language)
        {
            return String::new();
        }
        let mut prompt = String::new();
        for term in &self.terms {
            let phrase = if let Some(reading) = &term.reading {
                format!("{} ({reading})", term.source)
            } else {
                term.source.clone()
            };
            let separator = if prompt.is_empty() { "" } else { "、" };
            if prompt.chars().count() + separator.chars().count() + phrase.chars().count() > 512 {
                break;
            }
            prompt.push_str(separator);
            prompt.push_str(&phrase);
        }
        prompt
    }
    /// Include only relevant entries, with a small context budget. JSON stays
    /// data inside the fixed translation system instruction, never commands.
    pub fn translation_glossary(&self, text: &str) -> String {
        let lower = text.to_lowercase();
        let mut entries = Vec::new();
        for term in &self.terms {
            if term.target.is_none()
                || (!contains_phrase(&lower, &term.source.to_lowercase())
                    && !term
                        .reading
                        .as_ref()
                        .is_some_and(|reading| contains_phrase(&lower, &reading.to_lowercase())))
            {
                continue;
            }
            entries.push(term);
            let candidate = serde_json::to_string(&entries).unwrap_or_default();
            if candidate.chars().count() > 1200 {
                entries.pop();
                break;
            }
        }
        if entries.is_empty() {
            String::new()
        } else {
            serde_json::to_string(&entries).unwrap_or_default()
        }
    }
}

// csv deliberately tolerates an unfinished quoted field at EOF. Check the
// quoting grammar first so a truncated upload cannot silently become a term.
fn validate_delimited_quotes(content: &str, delimiter: u8) -> Result<()> {
    #[derive(Clone, Copy)]
    enum Field {
        Start,
        Unquoted,
        Quoted,
        AfterQuote,
    }
    let mut state = Field::Start;
    for byte in content.bytes() {
        state = match (state, byte) {
            (Field::Start, b'"') => Field::Quoted,
            (Field::Quoted, b'"') => Field::AfterQuote,
            (Field::Quoted, _) => Field::Quoted,
            (Field::AfterQuote, b'"') => Field::Quoted,
            (Field::Start | Field::Unquoted | Field::AfterQuote, b'\r' | b'\n') => Field::Start,
            (Field::Start | Field::Unquoted | Field::AfterQuote, b) if b == delimiter => {
                Field::Start
            }
            (Field::Start | Field::Unquoted, b) if b != b'"' => Field::Unquoted,
            _ => anyhow::bail!("CSV／TSV 引號格式無效"),
        };
    }
    anyhow::ensure!(!matches!(state, Field::Quoted), "CSV／TSV 引號未結束");
    Ok(())
}

/// Import the small, plain-text glossary formats used by common tools.
/// CSV and TSV contain source, target, and an optional reading column.
pub fn parse_text_pack(format: &str, name: &str, content: &str) -> Result<VocabularyPack> {
    anyhow::ensure!(content.len() <= MAX_PACK_BYTES, "詞彙包不能超過 64 KiB");
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut terms = Vec::new();
    match format.to_ascii_lowercase().as_str() {
        "csv" | "tsv" => {
            let delimiter = if format.eq_ignore_ascii_case("tsv") {
                b'\t'
            } else {
                b','
            };
            validate_delimited_quotes(content, delimiter)?;
            let mut reader = csv::ReaderBuilder::new()
                .delimiter(delimiter)
                .has_headers(false)
                .flexible(true)
                .from_reader(content.as_bytes());
            for (index, record) in reader.records().enumerate() {
                let record = record.context("CSV／TSV 格式無效")?;
                anyhow::ensure!(
                    (2..=3).contains(&record.len()),
                    "CSV／TSV 每列需有 source、target 兩欄，可加第三欄 reading"
                );
                let source = &record[0];
                let target = &record[1];
                if index == 0
                    && ((source.trim().eq_ignore_ascii_case("source")
                        && target.trim().eq_ignore_ascii_case("target"))
                        || (source.trim() == "原文" && target.trim() == "譯文"))
                {
                    continue;
                }
                let optional = |value: &str| (!value.trim().is_empty()).then(|| value.to_owned());
                terms.push(VocabularyTerm {
                    source: source.to_owned(),
                    target: optional(target),
                    reading: record.get(2).and_then(optional),
                });
                anyhow::ensure!(terms.len() <= 128, "詞彙包需包含 1–128 個詞語");
            }
        }
        "txt" => {
            for line in content.lines().filter(|line| !line.trim().is_empty()) {
                terms.push(VocabularyTerm {
                    source: line.to_owned(),
                    reading: None,
                    target: None,
                });
                anyhow::ensure!(terms.len() <= 128, "詞彙包需包含 1–128 個詞語");
            }
        }
        _ => anyhow::bail!("不支援此詞彙包格式，請使用 CSV、TSV 或 TXT"),
    }
    let pack = VocabularyPack {
        format_version: 1,
        name: name.to_owned(),
        language: None,
        terms,
    };
    pack.validate()?;
    Ok(pack)
}

/// CSV/TSV exports use the common two-column source/target interchange layout;
/// TXT exports contain sources only. JSON preserves readings and pack metadata.
pub fn export_text_pack(pack: &VocabularyPack, format: &str) -> Result<String> {
    pack.validate()?;
    let content = match format.to_ascii_lowercase().as_str() {
        "csv" | "tsv" => {
            let delimiter = if format.eq_ignore_ascii_case("tsv") {
                b'\t'
            } else {
                b','
            };
            let mut writer = csv::WriterBuilder::new()
                .delimiter(delimiter)
                .from_writer(Vec::new());
            for term in &pack.terms {
                writer
                    .write_record([term.source.as_str(), term.target.as_deref().unwrap_or("")])?;
            }
            String::from_utf8(writer.into_inner().context("無法匯出詞彙包")?)?
        }
        "txt" => {
            let mut content = pack
                .terms
                .iter()
                .map(|term| term.source.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            content.push('\n');
            content
        }
        _ => anyhow::bail!("不支援此詞彙包格式，請使用 CSV、TSV 或 TXT"),
    };
    anyhow::ensure!(content.len() <= MAX_PACK_BYTES, "詞彙包不能超過 64 KiB");
    Ok(content)
}

#[derive(Debug, Clone, Serialize)]
pub struct VocabularyProfile {
    pub id: String,
    pub name: String,
    pub terms_count: usize,
    pub language: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct VocabularyState {
    pub profiles: Vec<VocabularyProfile>,
    pub active_id: Option<String>,
    pub warnings: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Active {
    active_id: Option<String>,
}

pub struct VocabularyStore {
    root: PathBuf,
    packs: BTreeMap<String, VocabularyPack>,
    active: Option<String>,
    warnings: Vec<String>,
}
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("詞彙包位置無效")?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(bytes)?;
    file.as_file().sync_all()?;
    file.persist(path).context("無法保存詞彙包")?;
    Ok(())
}
impl VocabularyStore {
    pub fn load(root: &Path) -> Result<Self> {
        let root = root.join("vocabularies");
        std::fs::create_dir_all(&root)?;
        let mut packs = BTreeMap::new();
        let mut warnings = Vec::new();
        let mut entries = std::fs::read_dir(&root)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if path.extension().and_then(|s| s.to_str()) != Some("json") || !valid_id(id) {
                continue;
            }
            let result = (|| -> Result<VocabularyPack> {
                anyhow::ensure!(
                    !entry.file_type()?.is_symlink() && entry.file_type()?.is_file(),
                    "詞彙包必須為一般 JSON 檔案"
                );
                anyhow::ensure!(
                    entry.metadata()?.len() <= MAX_PACK_BYTES as u64,
                    "詞彙包檔案超過 64 KiB"
                );
                let pack: VocabularyPack =
                    serde_json::from_slice(&std::fs::read(&path)?).context("JSON 格式無效")?;
                pack.validate()?;
                Ok(pack)
            })();
            match result {
                Ok(pack) if packs.len() < 64 => {
                    packs.insert(id.to_owned(), pack);
                }
                Ok(_) => warnings.push(format!("已忽略詞彙包 {id}：最多可載入 64 個詞彙包")),
                Err(error) => warnings.push(format!(
                    "已忽略詞彙包 {id}：{error:#}。可刪除或重新匯入該檔案。"
                )),
            }
        }
        let active_path = root.join("active.json");
        let active = if active_path.exists() {
            let selected = (|| -> Result<Option<String>> {
                anyhow::ensure!(
                    std::fs::symlink_metadata(&active_path)?.is_file()
                        && std::fs::metadata(&active_path)?.len() <= 1024,
                    "詞彙包選擇檔案格式無效"
                );
                let state: Active = serde_json::from_slice(&std::fs::read(&active_path)?)?;
                if let Some(id) = &state.active_id {
                    anyhow::ensure!(valid_id(id), "詞彙包識別碼無效");
                }
                Ok(state.active_id)
            })();
            match selected {
                Ok(Some(id)) if !packs.contains_key(&id) => {
                    warnings.push("已選詞彙包已刪除或無效，目前停用詞彙提示。".into());
                    None
                }
                Ok(id) => id,
                Err(_) => {
                    warnings.push(
                        "詞彙包選擇檔案 active.json 損壞，目前停用詞彙提示；可重新選擇詞彙包。"
                            .into(),
                    );
                    None
                }
            }
        } else {
            None
        };
        Ok(Self {
            root,
            packs,
            active,
            warnings,
        })
    }
    pub fn state(&self) -> VocabularyState {
        let mut profiles: Vec<_> = self
            .packs
            .iter()
            .map(|(id, p)| VocabularyProfile {
                id: id.clone(),
                name: p.name.clone(),
                terms_count: p.terms.len(),
                language: p.language.clone(),
            })
            .collect();
        profiles.sort_by(|a, b| a.name.cmp(&b.name).then(a.id.cmp(&b.id)));
        VocabularyState {
            profiles,
            active_id: self.active.clone(),
            warnings: self.warnings.clone(),
        }
    }
    pub fn get_pack(&self, id: &str) -> Result<VocabularyPack> {
        anyhow::ensure!(valid_id(id), "找不到此詞彙包");
        self.packs.get(id).cloned().context("找不到此詞彙包")
    }
    pub fn import(&mut self, pack: VocabularyPack) -> Result<VocabularyState> {
        pack.validate()?;
        anyhow::ensure!(
            self.packs.len() < 64,
            "最多可保存 64 個詞彙包，請先移除不需要的項目"
        );
        let id = loop {
            let id = format!("{:032x}", rand::random::<u128>());
            if !self.packs.contains_key(&id) && !self.root.join(format!("{id}.json")).exists() {
                break id;
            }
        };
        write_atomic(
            &self.root.join(format!("{id}.json")),
            &serde_json::to_vec_pretty(&pack)?,
        )?;
        self.packs.insert(id, pack);
        Ok(self.state())
    }
    pub fn activate(&mut self, id: Option<String>) -> Result<VocabularyState> {
        if let Some(id) = &id {
            anyhow::ensure!(
                valid_id(id) && self.packs.contains_key(id),
                "找不到此詞彙包"
            );
        }
        write_atomic(
            &self.root.join("active.json"),
            &serde_json::to_vec(&Active {
                active_id: id.clone(),
            })?,
        )?;
        self.active = id;
        Ok(self.state())
    }
    pub fn remove(&mut self, id: &str) -> Result<VocabularyState> {
        anyhow::ensure!(
            valid_id(id) && self.packs.contains_key(id),
            "找不到此詞彙包"
        );
        // Deactivate before removing a selected pack so persisted state never
        // points at a deleted pack, even if filesystem removal fails.
        if self.active.as_deref() == Some(id) {
            self.activate(None)?;
        }
        std::fs::remove_file(self.root.join(format!("{id}.json")))?;
        self.packs.remove(id);
        Ok(self.state())
    }
    pub fn active_pack(&self) -> Option<VocabularyPack> {
        self.active
            .as_ref()
            .and_then(|id| self.packs.get(id))
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pack() -> VocabularyPack {
        VocabularyPack {
            format_version: 1,
            name: "Example VTuber".into(),
            language: Some("ja".into()),
            terms: vec![VocabularyTerm {
                source: "星のねこ".into(),
                reading: Some("ほしのねこ".into()),
                target: Some("星之貓".into()),
            }],
        }
    }
    #[test]
    fn imports_selects_reloads_and_removes_without_using_names_as_paths() {
        let root = tempfile::tempdir().unwrap();
        let mut store = VocabularyStore::load(root.path()).unwrap();
        let mut p = pack();
        p.name = "../我的 VTuber".into();
        let state = store.import(p.clone()).unwrap();
        assert_eq!(state.profiles.len(), 1);
        assert_eq!(state.active_id, None);
        let id = state.profiles[0].id.clone();
        assert!(valid_id(&id));
        let mut exported = store.get_pack(&id).unwrap();
        exported.name = "A separate clone".into();
        assert_eq!(store.get_pack(&id).unwrap(), p);
        assert!(store.get_pack("../../settings").is_err());
        assert!(store.get_pack("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").is_err());
        store.activate(Some(id.clone())).unwrap();
        let mut reloaded = VocabularyStore::load(root.path()).unwrap();
        assert_eq!(reloaded.active_pack(), Some(p));
        assert!(reloaded.activate(Some("../../settings".into())).is_err());
        assert!(reloaded.remove("../../settings").is_err());
        reloaded.remove(&id).unwrap();
        assert!(VocabularyStore::load(root.path())
            .unwrap()
            .state()
            .profiles
            .is_empty());
        assert!(reloaded.active_pack().is_none());
    }
    #[test]
    fn external_deletion_and_bad_files_are_reported_without_blocking_valid_profiles() {
        let root = tempfile::tempdir().unwrap();
        let mut store = VocabularyStore::load(root.path()).unwrap();
        let state = store.import(pack()).unwrap();
        let id = state.profiles[0].id.clone();
        store.activate(Some(id.clone())).unwrap();
        std::fs::remove_file(root.path().join("vocabularies").join(format!("{id}.json"))).unwrap();
        std::fs::write(
            root.path()
                .join("vocabularies/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json"),
            "{broken",
        )
        .unwrap();
        let mut reloaded = VocabularyStore::load(root.path()).unwrap();
        assert!(reloaded.active_pack().is_none());
        assert_eq!(reloaded.state().warnings.len(), 2);
        reloaded.import(pack()).unwrap();
        assert_eq!(reloaded.state().profiles.len(), 1);
    }
    #[test]
    fn rejects_malformed_overlarge_and_unsupported_packs() {
        assert!(serde_json::from_str::<VocabularyPack>(
            r#"{"format_version":1,"name":"bad","terms":[],"script":"run"}"#
        )
        .is_err());
        let mut p = pack();
        p.format_version = 2;
        assert!(p.validate().is_err());
        p = pack();
        p.terms.clear();
        assert!(p.validate().is_err());
        p = pack();
        p.name = "a".repeat(81);
        assert!(p.validate().is_err());
        p = pack();
        p.terms[0].reading = Some("line\nbreak".into());
        assert!(p.validate().is_err());
        p = pack();
        p.terms = vec![p.terms[0].clone(); 129];
        assert!(p.validate().is_err());
        p = pack();
        p.terms.push(p.terms[0].clone());
        assert!(p.validate().is_err());
        p = pack();
        p.terms = (0..128)
            .map(|i| VocabularyTerm {
                source: format!("{i}{}", "あ".repeat(70)),
                reading: Some("い".repeat(80)),
                target: Some("譯".repeat(120)),
            })
            .collect();
        assert!(p.validate().unwrap_err().to_string().contains("64 KiB"));
    }
    #[test]
    fn text_import_handles_quoted_commas_and_escaped_quotes() {
        let p = parse_text_pack(
            "csv",
            "Quoted names",
            "\"Hello, world\",\"A \"\"quoted\"\" name\",hello\nplain,translation\n",
        )
        .unwrap();
        assert_eq!(p.terms[0].source, "Hello, world");
        assert_eq!(p.terms[0].target.as_deref(), Some("A \"quoted\" name"));
        assert_eq!(p.terms[0].reading.as_deref(), Some("hello"));
        assert_eq!(p.terms[1].reading, None);
    }
    #[test]
    fn text_import_handles_bom_unicode_crlf_and_optional_headers() {
        let p = parse_text_pack(
            "csv",
            "名稱",
            "\u{feff}原文,譯文,讀音\r\n星のねこ,星之貓,ほしのねこ\r\n",
        )
        .unwrap();
        assert_eq!(p.terms, pack().terms);
        let p = parse_text_pack("tsv", "Names", "\u{feff}source\ttarget\r\nねこ\t貓\r\n").unwrap();
        assert_eq!(p.terms.len(), 1);
        assert_eq!(p.terms[0].source, "ねこ");
        assert_eq!(p.terms[0].target.as_deref(), Some("貓"));
        let p = parse_text_pack("txt", "Names", "\u{feff}\r\nねこ\r\n   \r\n星\r\n").unwrap();
        assert_eq!(p.terms.len(), 2);
        assert_eq!(p.terms[0].source, "ねこ");
        assert_eq!(p.terms[1].source, "星");
        assert!(p
            .terms
            .iter()
            .all(|t| t.target.is_none() && t.reading.is_none()));
    }
    #[test]
    fn text_exports_round_trip_the_documented_columns() {
        let mut p = pack();
        p.terms[0].source = "星のねこ, \"neko\"".into();
        p.terms.push(VocabularyTerm {
            source: "名前".into(),
            reading: None,
            target: None,
        });
        for format in ["csv", "tsv"] {
            let content = export_text_pack(&p, format).unwrap();
            assert!(!content.starts_with("source"));
            let imported = parse_text_pack(format, &p.name, &content).unwrap();
            let mut expected = p.clone();
            expected.language = None;
            for term in &mut expected.terms {
                term.reading = None;
            }
            assert_eq!(imported, expected);
        }
        let content = export_text_pack(&p, "txt").unwrap();
        assert_eq!(content, "星のねこ, \"neko\"\n名前\n");
        let imported = parse_text_pack("txt", &p.name, &content).unwrap();
        assert_eq!(imported.terms[0].source, p.terms[0].source);
        assert!(imported.terms[0].target.is_none());
        assert!(imported.terms[0].reading.is_none());
    }
    #[test]
    fn text_import_rejects_malformed_oversized_and_unsupported_content() {
        for content in [
            "\"unfinished,target",
            "source,\"unfinished",
            "un\"quoted,target",
            "\"closed\"junk,target",
            "only one column",
            "one,two,three,four",
            ",target",
            "source,\"line\nbreak\"",
            "same,one\nSAME,two",
        ] {
            assert!(
                parse_text_pack("csv", "Names", content).is_err(),
                "{content}"
            );
        }
        assert!(parse_text_pack("txt", "Names", "\u{0}term").is_err());
        assert!(parse_text_pack("txt", "Names", "\n \r\n").is_err());
        assert!(parse_text_pack("txt", &"a".repeat(81), "term").is_err());
        assert!(parse_text_pack("txt", "Names", &"a".repeat(81)).is_err());
        assert!(parse_text_pack("csv", "Names", &format!("source,{}", "a".repeat(121))).is_err());
        assert!(
            parse_text_pack("csv", "Names", &format!("source,target,{}", "a".repeat(81))).is_err()
        );
        let too_many = (0..129).map(|i| format!("term{i}\n")).collect::<String>();
        assert!(parse_text_pack("txt", "Names", &too_many).is_err());
        let oversized = format!("term\n{}", "\n".repeat(MAX_PACK_BYTES));
        assert!(parse_text_pack("txt", "Names", &oversized)
            .unwrap_err()
            .to_string()
            .contains("64 KiB"));
        for format in ["deepl", "tbx", "tmx", "xlsx", "unknown"] {
            assert!(parse_text_pack(format, "Names", "source,target").is_err());
            assert!(export_text_pack(&pack(), format).is_err());
        }
    }
    #[test]
    fn prompts_are_bounded_relevant_and_language_aware() {
        let p = pack();
        assert!(p.whisper_prompt("ja").contains("ほしのねこ"));
        assert!(p.whisper_prompt("en").is_empty());
        assert!(p
            .translation_glossary("今日は星のねこです")
            .contains("星之貓"));
        assert!(p.translation_glossary("ほしのねこです").contains("星之貓"));
        assert!(p.translation_glossary("こんにちは").is_empty());
        let ascii = VocabularyPack {
            format_version: 1,
            name: "Names".into(),
            language: None,
            terms: vec![VocabularyTerm {
                source: "AI".into(),
                reading: None,
                target: Some("艾愛".into()),
            }],
        };
        assert!(ascii.translation_glossary("A maid arrived").is_empty());
        assert!(ascii.translation_glossary("Hello AI!").contains("艾愛"));
        let mut p = pack();
        p.terms = (0..128)
            .map(|i| VocabularyTerm {
                source: format!("name{i}"),
                reading: Some("ひらがな".repeat(10)),
                target: Some("譯名".repeat(20)),
            })
            .collect();
        assert!(p.whisper_prompt("ja").chars().count() <= 512);
        assert!(
            p.translation_glossary(
                "name1 name2 name3 name4 name5 name6 name7 name8 name9 name10 name11 name12 name13"
            )
            .chars()
            .count()
                <= 1200
        );
    }
}
