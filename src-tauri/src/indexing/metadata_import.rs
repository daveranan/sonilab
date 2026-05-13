use std::collections::HashMap;
use std::path::{Path, PathBuf};

use calamine::{open_workbook_auto, Reader};
use serde_json::{json, Map, Value};

use super::scanner::normalize_for_compare;

#[derive(Debug, Clone, Default)]
pub struct ImportedMetadata {
    by_path: HashMap<String, ImportedMetadataRow>,
    by_filename: HashMap<String, ImportedMetadataRow>,
    source_file: String,
    row_count: usize,
}

#[derive(Debug, Clone, Default)]
pub struct ImportedMetadataRow {
    pub license: Option<String>,
    pub attribution: Option<String>,
    pub originator: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub raw: Map<String, Value>,
}

impl ImportedMetadata {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn source_file(&self) -> &str {
        &self.source_file
    }

    pub fn row_count(&self) -> usize {
        self.row_count
    }

    pub fn match_asset(&self, relative_path: &str, filename: &str) -> Option<&ImportedMetadataRow> {
        let normalized_path = normalize_for_compare(relative_path);
        self.by_path
            .get(&normalized_path)
            .or_else(|| filename_key(filename).and_then(|key| self.by_filename.get(&key)))
    }
}

pub fn metadata_file_from_settings(settings_json: &str) -> Option<PathBuf> {
    let settings = serde_json::from_str::<Value>(settings_json).ok()?;
    if !settings
        .get("metadataImportEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    settings
        .get("metadataFile")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

pub fn load_imported_metadata(path: &Path) -> Result<ImportedMetadata, String> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let rows = match extension.as_str() {
        "csv" => parse_delimited_text(path, ',')?,
        "tab" | "tsv" => parse_delimited_text(path, '\t')?,
        "txt" => parse_text_metadata(path)?,
        "xls" | "xlsx" | "xlsm" | "xlsb" | "ods" => parse_workbook(path)?,
        "pdf" => parse_pdf_metadata(path)?,
        _ => return Err(format!("Unsupported metadata file type: {extension}")),
    };
    Ok(index_rows(path, rows))
}

pub fn merge_imported_metadata_json(
    metadata_json: &str,
    source_file: &str,
    row: &ImportedMetadataRow,
) -> String {
    let mut root = serde_json::from_str::<Value>(metadata_json).unwrap_or_else(|_| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    let Some(object) = root.as_object_mut() else {
        return metadata_json.to_string();
    };
    object.insert(
        "importedMetadata".to_string(),
        json!({
            "sourceFile": source_file,
            "fields": row.raw,
        }),
    );
    root.to_string()
}

fn parse_workbook(path: &Path) -> Result<Vec<HashMap<String, String>>, String> {
    let mut workbook = open_workbook_auto(path).map_err(|error| error.to_string())?;
    let Some(sheet_name) = workbook.sheet_names().first().cloned() else {
        return Ok(Vec::new());
    };
    let range = workbook
        .worksheet_range(&sheet_name)
        .map_err(|error| error.to_string())?;
    let mut rows = range.rows();
    let Some(header_row) = rows.next() else {
        return Ok(Vec::new());
    };
    let headers = header_row.iter().map(cell_to_string).collect::<Vec<_>>();
    Ok(rows
        .filter_map(|row| row_from_cells(&headers, row.iter().map(cell_to_string)))
        .collect())
}

fn parse_delimited_text(
    path: &Path,
    delimiter: char,
) -> Result<Vec<HashMap<String, String>>, String> {
    let text = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    parse_delimited_content(&text, delimiter)
}

fn parse_text_metadata(path: &Path) -> Result<Vec<HashMap<String, String>>, String> {
    let text = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    parse_text_table(&text)
}

fn parse_pdf_metadata(path: &Path) -> Result<Vec<HashMap<String, String>>, String> {
    let text = pdf_extract::extract_text(path).map_err(|error| error.to_string())?;
    if text.trim().is_empty() {
        return Err(
            "PDF contains no extractable text; scanned PDFs are not supported.".to_string(),
        );
    }
    let audio_rows = parse_pdf_audio_lines(&text);
    if !audio_rows.is_empty() {
        return Ok(audio_rows);
    }
    parse_text_table(&text)
}

fn parse_text_table(text: &str) -> Result<Vec<HashMap<String, String>>, String> {
    let first_line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let delimiter = if first_line.contains('\t') { '\t' } else { ',' };
    parse_delimited_content(&text, delimiter)
}

fn parse_delimited_content(
    text: &str,
    delimiter: char,
) -> Result<Vec<HashMap<String, String>>, String> {
    let mut rows = parse_delimited_rows(text, delimiter);
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let headers = rows.remove(0);
    Ok(rows
        .into_iter()
        .filter_map(|row| row_from_cells(&headers, row.into_iter()))
        .collect())
}

fn parse_delimited_rows(text: &str, delimiter: char) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut chars = text.chars().peekable();
    let mut quoted = false;
    while let Some(ch) = chars.next() {
        if quoted {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    let _ = chars.next();
                } else {
                    quoted = false;
                }
            } else {
                field.push(ch);
            }
            continue;
        }
        if ch == '"' && field.is_empty() {
            quoted = true;
        } else if ch == delimiter {
            row.push(field.trim().to_string());
            field.clear();
        } else if ch == '\n' {
            row.push(field.trim_end_matches('\r').trim().to_string());
            field.clear();
            if row.iter().any(|value| !value.is_empty()) {
                rows.push(row);
            }
            row = Vec::new();
        } else {
            field.push(ch);
        }
    }
    row.push(field.trim().to_string());
    if row.iter().any(|value| !value.is_empty()) {
        rows.push(row);
    }
    rows
}

fn row_from_cells<I>(headers: &[String], cells: I) -> Option<HashMap<String, String>>
where
    I: IntoIterator<Item = String>,
{
    let row = headers
        .iter()
        .zip(cells)
        .filter_map(|(header, value)| {
            let key = header.trim();
            let value = value.trim();
            if key.is_empty() || value.is_empty() {
                None
            } else {
                Some((key.to_string(), value.to_string()))
            }
        })
        .collect::<HashMap<_, _>>();
    if row.is_empty() {
        None
    } else {
        Some(row)
    }
}

fn index_rows(path: &Path, rows: Vec<HashMap<String, String>>) -> ImportedMetadata {
    let source_file = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_string();
    let mut imported = ImportedMetadata {
        source_file,
        row_count: 0,
        ..ImportedMetadata::empty()
    };
    for row in rows {
        let metadata_row = metadata_row_from_map(&row);
        let path_value = first_value(&row, &["path", "relativepath", "filepath", "file path"]);
        let filename_value = first_value(&row, &["filename", "file", "name", "asset", "title"])
            .filter(|value| looks_like_audio_filename(value))
            .or_else(|| audio_filename_from_any_field(&row));
        if let Some(path) = path_value.as_deref() {
            imported.by_path.insert(
                normalize_for_compare(&path.replace('\\', "/")),
                metadata_row.clone(),
            );
        }
        if let Some(filename) = filename_value.or_else(|| {
            path_value.as_deref().and_then(|value| {
                Path::new(value)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_string)
            })
        }) {
            if let Some(key) = filename_key(&filename) {
                imported.by_filename.insert(key, metadata_row);
            }
        }
        imported.row_count += 1;
    }
    imported
}

fn metadata_row_from_map(row: &HashMap<String, String>) -> ImportedMetadataRow {
    let mut raw = Map::new();
    for (key, value) in row {
        raw.insert(key.clone(), Value::String(value.clone()));
    }
    ImportedMetadataRow {
        license: first_value(row, &["license", "licence", "rights", "usage rights"])
            .or_else(|| inferred_license(row)),
        attribution: first_value(row, &["attribution", "credit", "credits", "source"]),
        originator: first_value(
            row,
            &[
                "bworiginator",
                "originator",
                "author",
                "creator",
                "artist",
                "uploader",
                "manufacturer",
            ],
        ),
        description: first_value(
            row,
            &[
                "bwdescription",
                "description",
                "comment",
                "comments",
                "notes",
                "filename",
            ],
        ),
        tags: tag_values(row),
        raw,
    }
}

fn tag_values(row: &HashMap<String, String>) -> Vec<String> {
    let mut tags = Vec::new();
    for key in ["category", "subcategory", "tags", "keywords"] {
        if let Some(value) = first_value(row, &[key]) {
            if looks_like_audio_filename(&value) {
                continue;
            }
            tags.extend(
                value
                    .split([',', ';', '|'])
                    .map(str::trim)
                    .filter(|tag| !tag.is_empty())
                    .map(str::to_string),
            );
        }
    }
    tags.sort();
    tags.dedup();
    tags
}

fn inferred_license(row: &HashMap<String, String>) -> Option<String> {
    let text = first_value(row, &["notes", "rights", "copyright"])?;
    text.to_ascii_lowercase()
        .contains("all rights reserved")
        .then(|| "all-rights-reserved".to_string())
}

fn audio_filename_from_any_field(row: &HashMap<String, String>) -> Option<String> {
    row.values()
        .find(|value| looks_like_audio_filename(value))
        .cloned()
}

fn looks_like_audio_filename(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    [".wav", ".wave", ".aif", ".aiff", ".mp3", ".ogg", ".flac"]
        .iter()
        .any(|extension| value.ends_with(extension) || value.contains(&format!("{extension} ")))
}

fn parse_pdf_audio_lines(text: &str) -> Vec<HashMap<String, String>> {
    text.lines().filter_map(pdf_audio_row).collect()
}

fn pdf_audio_row(line: &str) -> Option<HashMap<String, String>> {
    let line = line.trim();
    let lower = line.to_ascii_lowercase();
    let extension_start = [".wav", ".wave", ".aif", ".aiff", ".mp3", ".ogg", ".flac"]
        .iter()
        .filter_map(|extension| lower.find(extension).map(|index| (index, extension.len())))
        .min_by_key(|(index, _)| *index)?;
    let filename_end = extension_start.0 + extension_start.1;
    let filename_start = line[..extension_start.0]
        .rfind("CDCK ")
        .or_else(|| line[..extension_start.0].rfind("CK "))
        .unwrap_or(0);
    let filename = line[filename_start..filename_end].trim();
    if !looks_like_audio_filename(filename) {
        return None;
    }
    let mut row = HashMap::new();
    row.insert("Filename".to_string(), filename.to_string());
    let prefix = line[..filename_start].trim();
    if !prefix.is_empty() {
        row.insert("Category".to_string(), prefix.to_string());
    }
    let description = line[filename_end..].trim();
    if !description.is_empty() {
        row.insert("BWDescription".to_string(), description.to_string());
    }
    Some(row)
}

fn first_value(row: &HashMap<String, String>, aliases: &[&str]) -> Option<String> {
    aliases.iter().find_map(|alias| {
        let alias = normalize_header(alias);
        row.iter().find_map(|(key, value)| {
            (normalize_header(key) == alias)
                .then(|| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
    })
}

fn normalize_header(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

fn filename_key(filename: &str) -> Option<String> {
    Path::new(filename)
        .file_name()
        .and_then(|name| name.to_str())
        .map(normalize_for_compare)
        .filter(|value| !value.is_empty())
}

fn cell_to_string<T: ToString>(cell: T) -> String {
    cell.to_string().trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quoted_csv_and_matches_filename() {
        let rows = parse_delimited_content(
            "filename,license,tags\n\"Hit, Big.wav\",cc0,\"impact, metal\"",
            ',',
        )
        .unwrap();
        let imported = index_rows(Path::new("metadata.csv"), rows);
        let matched = imported
            .match_asset("folder/Hit, Big.wav", "Hit, Big.wav")
            .unwrap();

        assert_eq!(matched.license.as_deref(), Some("cc0"));
        assert_eq!(matched.tags, vec!["impact", "metal"]);
    }

    #[test]
    fn parses_metadata_sample_from_env() {
        let Ok(path) = std::env::var("SONILABS_METADATA_SAMPLE") else {
            return;
        };
        let imported = load_imported_metadata(Path::new(&path)).expect("parse sample metadata");
        eprintln!(
            "sample={} rows={} path_keys={} filename_keys={}",
            imported.source_file(),
            imported.row_count(),
            imported.by_path.len(),
            imported.by_filename.len()
        );
        let first = imported
            .by_filename
            .values()
            .next()
            .or_else(|| imported.by_path.values().next());
        eprintln!("first={first:#?}");
        assert!(imported.row_count() > 0);
    }
}
