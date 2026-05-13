use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AudioFormatProbe {
    pub format: Option<String>,
    pub extension: String,
    pub container: Option<String>,
    pub codec: Option<String>,
    pub is_supported: bool,
    pub probe_error: Option<String>,
}

pub fn is_supported_audio_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "wav" | "mp3" | "ogg" | "flac" | "aac" | "m4a" | "aiff" | "aif"
            )
        })
        .unwrap_or(false)
}

pub fn probe_audio_format(path: &Path) -> AudioFormatProbe {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if !is_supported_audio_extension(path) {
        return AudioFormatProbe {
            format: None,
            extension,
            container: None,
            codec: None,
            is_supported: false,
            probe_error: Some("unsupported extension".to_string()),
        };
    }

    let mut header = [0_u8; 32];
    let read = match File::open(path).and_then(|mut file| file.read(&mut header)) {
        Ok(read) => read,
        Err(error) => {
            return AudioFormatProbe {
                format: None,
                extension,
                container: None,
                codec: None,
                is_supported: false,
                probe_error: Some(error.to_string()),
            };
        }
    };
    let header = &header[..read];

    let sniffed = sniff_header(header);
    match sniffed {
        Some(format) => {
            let (container, codec) = container_codec(&format);
            AudioFormatProbe {
                format: Some(format),
                extension,
                container,
                codec,
                is_supported: true,
                probe_error: None,
            }
        }
        None => AudioFormatProbe {
            format: None,
            extension,
            container: None,
            codec: None,
            is_supported: false,
            probe_error: Some("unsupported or unknown audio header".to_string()),
        },
    }
}

fn sniff_header(header: &[u8]) -> Option<String> {
    if header.len() >= 12 && &header[0..4] == b"RIFF" && &header[8..12] == b"WAVE" {
        return Some("wav".to_string());
    }
    if header.starts_with(b"ID3") || looks_like_mp3_frame(header) {
        return Some("mp3".to_string());
    }
    if header.starts_with(b"OggS") {
        return Some("ogg".to_string());
    }
    if header.starts_with(b"fLaC") {
        return Some("flac".to_string());
    }
    if header.len() >= 12 && &header[4..8] == b"ftyp" {
        let brand = &header[8..12];
        if matches!(brand, b"M4A " | b"mp42" | b"isom" | b"MSNV" | b"mp41") {
            return Some("m4a".to_string());
        }
    }
    if looks_like_adts_aac(header) {
        return Some("aac".to_string());
    }
    if header.len() >= 12
        && &header[0..4] == b"FORM"
        && (&header[8..12] == b"AIFF" || &header[8..12] == b"AIFC")
    {
        return Some("aiff".to_string());
    }
    None
}

fn looks_like_mp3_frame(header: &[u8]) -> bool {
    header.len() >= 2 && header[0] == 0xff && (header[1] & 0xe0) == 0xe0
}

fn looks_like_adts_aac(header: &[u8]) -> bool {
    header.len() >= 2 && header[0] == 0xff && (header[1] & 0xf0) == 0xf0
}

fn container_codec(format: &str) -> (Option<String>, Option<String>) {
    match format {
        "wav" => (Some("riff".to_string()), Some("pcm_or_wave".to_string())),
        "mp3" => (Some("mpeg".to_string()), Some("mp3".to_string())),
        "ogg" => (Some("ogg".to_string()), None),
        "flac" => (Some("flac".to_string()), Some("flac".to_string())),
        "aac" => (Some("adts".to_string()), Some("aac".to_string())),
        "m4a" => (Some("mp4".to_string()), Some("aac_or_alac".to_string())),
        "aiff" => (Some("aiff".to_string()), Some("pcm_or_aifc".to_string())),
        _ => (None, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probes_supported_headers() {
        assert_eq!(
            sniff_header(b"RIFF\x00\x00\x00\x00WAVEfmt "),
            Some("wav".to_string())
        );
        assert_eq!(sniff_header(b"OggS\0\0\0"), Some("ogg".to_string()));
        assert_eq!(sniff_header(b"fLaC\0\0\0"), Some("flac".to_string()));
        assert_eq!(sniff_header(b"ID3\x04\0\0"), Some("mp3".to_string()));
        assert_eq!(
            sniff_header(b"FORM\x00\x00\x00\x00AIFF"),
            Some("aiff".to_string())
        );
    }

    #[test]
    fn sniffed_supported_format_wins_over_extension() {
        let path = std::env::temp_dir().join("sonilabs_phase2_mislabeled.mp3");
        std::fs::write(&path, b"RIFF\x00\x00\x00\x00WAVEfmt ").expect("write probe file");

        let probe = probe_audio_format(&path);
        assert!(probe.is_supported);
        assert_eq!(probe.extension, "mp3");
        assert_eq!(probe.format, Some("wav".to_string()));

        let _ = std::fs::remove_file(path);
    }
}
