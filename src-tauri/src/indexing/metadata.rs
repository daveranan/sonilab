use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use super::formats::{probe_audio_format, AudioFormatProbe};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BasicAudioMetadata {
    pub probe: AudioFormatProbe,
    pub duration_seconds: Option<f64>,
    pub sample_rate: Option<i64>,
    pub bit_depth: Option<i64>,
    pub channels: Option<i64>,
    pub byte_size: i64,
    pub modified_at: String,
}

pub fn extract_basic_metadata(path: &Path) -> Result<BasicAudioMetadata, String> {
    let probe = probe_audio_format(path);
    if !probe.is_supported {
        return Err(probe
            .probe_error
            .clone()
            .unwrap_or_else(|| "unsupported audio format".to_string()));
    }

    let file_metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    let byte_size = i64::try_from(file_metadata.len()).unwrap_or(i64::MAX);
    let modified_at = file_metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| format!("unix:{}", duration.as_secs()))
        .unwrap_or_else(|| "unknown".to_string());

    let parsed = match probe.format.as_deref() {
        Some("wav") => parse_wav(path).map_err(|error| format!("corrupt WAV file: {error}"))?,
        Some("flac") => parse_flac(path).map_err(|error| format!("corrupt FLAC file: {error}"))?,
        Some("aiff") => parse_aiff(path).unwrap_or_default(),
        Some("mp3") => parse_mp3(path, byte_size).unwrap_or_default(),
        Some("m4a") => parse_m4a(path).unwrap_or_default(),
        _ => ParsedAudioFacts::default(),
    };

    Ok(BasicAudioMetadata {
        probe,
        duration_seconds: parsed.duration_seconds,
        sample_rate: parsed.sample_rate,
        bit_depth: parsed.bit_depth,
        channels: parsed.channels,
        byte_size,
        modified_at,
    })
}

#[derive(Default)]
struct ParsedAudioFacts {
    duration_seconds: Option<f64>,
    sample_rate: Option<i64>,
    bit_depth: Option<i64>,
    channels: Option<i64>,
}

fn parse_wav(path: &Path) -> Result<ParsedAudioFacts, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut header = [0_u8; 12];
    file.read_exact(&mut header)
        .map_err(|error| error.to_string())?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Err("not a wav file".to_string());
    }

    let mut facts = ParsedAudioFacts::default();
    let mut data_bytes = None;
    loop {
        let mut chunk = [0_u8; 8];
        if file.read_exact(&mut chunk).is_err() {
            break;
        }
        let chunk_id = &chunk[0..4];
        let chunk_size = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]) as u64;
        let chunk_start = file.stream_position().map_err(|error| error.to_string())?;

        if chunk_id == b"fmt " && chunk_size >= 16 {
            let mut fmt = vec![0_u8; usize::try_from(chunk_size).unwrap_or(0)];
            file.read_exact(&mut fmt)
                .map_err(|error| error.to_string())?;
            facts.channels = Some(u16::from_le_bytes([fmt[2], fmt[3]]) as i64);
            facts.sample_rate = Some(u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]) as i64);
            facts.bit_depth = Some(u16::from_le_bytes([fmt[14], fmt[15]]) as i64);
        } else if chunk_id == b"data" {
            data_bytes = Some(chunk_size);
        }

        let next = chunk_start + chunk_size + (chunk_size % 2);
        file.seek(SeekFrom::Start(next))
            .map_err(|error| error.to_string())?;
    }

    if let (Some(bytes), Some(rate), Some(channels), Some(bits)) = (
        data_bytes,
        facts.sample_rate,
        facts.channels,
        facts.bit_depth,
    ) {
        let bytes_per_frame = (channels * bits / 8).max(1) as f64;
        facts.duration_seconds = Some(bytes as f64 / bytes_per_frame / rate as f64);
    }
    Ok(facts)
}

fn parse_flac(path: &Path) -> Result<ParsedAudioFacts, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut header = [0_u8; 42];
    file.read_exact(&mut header)
        .map_err(|error| error.to_string())?;
    if &header[0..4] != b"fLaC" || (header[4] & 0x7f) != 0 {
        return Err("missing flac streaminfo block".to_string());
    }

    let streaminfo = &header[8..42];
    let sample_rate = ((streaminfo[10] as u32) << 12)
        | ((streaminfo[11] as u32) << 4)
        | ((streaminfo[12] as u32) >> 4);
    let channels = (((streaminfo[12] & 0x0e) >> 1) + 1) as i64;
    let bit_depth = ((((streaminfo[12] & 0x01) as u16) << 4) | ((streaminfo[13] as u16) >> 4)) + 1;
    let samples = (((streaminfo[13] & 0x0f) as u64) << 32)
        | ((streaminfo[14] as u64) << 24)
        | ((streaminfo[15] as u64) << 16)
        | ((streaminfo[16] as u64) << 8)
        | streaminfo[17] as u64;

    Ok(ParsedAudioFacts {
        duration_seconds: (sample_rate > 0).then_some(samples as f64 / sample_rate as f64),
        sample_rate: Some(sample_rate as i64),
        bit_depth: Some(bit_depth as i64),
        channels: Some(channels),
    })
}

fn parse_aiff(path: &Path) -> Result<ParsedAudioFacts, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut header = [0_u8; 12];
    file.read_exact(&mut header)
        .map_err(|error| error.to_string())?;
    if &header[0..4] != b"FORM" {
        return Err("not an aiff file".to_string());
    }

    loop {
        let mut chunk = [0_u8; 8];
        if file.read_exact(&mut chunk).is_err() {
            break;
        }
        let chunk_size = u32::from_be_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]) as u64;
        let chunk_start = file.stream_position().map_err(|error| error.to_string())?;
        if &chunk[0..4] == b"COMM" && chunk_size >= 18 {
            let mut comm = [0_u8; 18];
            file.read_exact(&mut comm)
                .map_err(|error| error.to_string())?;
            let channels = u16::from_be_bytes([comm[0], comm[1]]) as i64;
            let frames = u32::from_be_bytes([comm[2], comm[3], comm[4], comm[5]]);
            let bit_depth = u16::from_be_bytes([comm[6], comm[7]]) as i64;
            let sample_rate = extended_80_to_f64(&comm[8..18]).round() as i64;
            return Ok(ParsedAudioFacts {
                duration_seconds: (sample_rate > 0).then_some(frames as f64 / sample_rate as f64),
                sample_rate: Some(sample_rate),
                bit_depth: Some(bit_depth),
                channels: Some(channels),
            });
        }
        file.seek(SeekFrom::Start(chunk_start + chunk_size + (chunk_size % 2)))
            .map_err(|error| error.to_string())?;
    }
    Ok(ParsedAudioFacts::default())
}

fn parse_mp3(path: &Path, byte_size: i64) -> Result<ParsedAudioFacts, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = [0_u8; 4096];
    let read = file.read(&mut bytes).map_err(|error| error.to_string())?;
    let bytes = &bytes[..read];
    let frame_start = bytes
        .windows(2)
        .position(|window| window[0] == 0xff && (window[1] & 0xe0) == 0xe0)
        .ok_or_else(|| "mp3 frame header not found".to_string())?;
    let header = &bytes[frame_start..frame_start + 4.min(bytes.len() - frame_start)];
    if header.len() < 4 {
        return Err("short mp3 frame header".to_string());
    }

    let version_bits = (header[1] >> 3) & 0x03;
    let sample_bits = (header[2] >> 2) & 0x03;
    let bitrate_bits = (header[2] >> 4) & 0x0f;
    let sample_rate = mp3_sample_rate(version_bits, sample_bits);
    let bitrate = mp3_bitrate_kbps(version_bits, bitrate_bits);
    let channels = if ((header[3] >> 6) & 0x03) == 3 { 1 } else { 2 };

    Ok(ParsedAudioFacts {
        duration_seconds: bitrate.map(|kbps| byte_size as f64 * 8.0 / (kbps as f64 * 1000.0)),
        sample_rate: sample_rate.map(i64::from),
        bit_depth: None,
        channels: Some(channels),
    })
}

fn parse_m4a(path: &Path) -> Result<ParsedAudioFacts, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.take(1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;

    let mut offset = 0;
    while offset + 16 <= bytes.len() {
        let size = u32::from_be_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]) as usize;
        if size < 8 || offset + size > bytes.len() {
            break;
        }
        if &bytes[offset + 4..offset + 8] == b"mvhd" && size >= 28 {
            let version = bytes[offset + 8];
            let base = if version == 1 {
                offset + 28
            } else {
                offset + 20
            };
            if base + 8 <= bytes.len() {
                let timescale = u32::from_be_bytes([
                    bytes[base],
                    bytes[base + 1],
                    bytes[base + 2],
                    bytes[base + 3],
                ]);
                let duration = u32::from_be_bytes([
                    bytes[base + 4],
                    bytes[base + 5],
                    bytes[base + 6],
                    bytes[base + 7],
                ]);
                return Ok(ParsedAudioFacts {
                    duration_seconds: (timescale > 0).then_some(duration as f64 / timescale as f64),
                    sample_rate: None,
                    bit_depth: None,
                    channels: None,
                });
            }
        }
        offset += size;
    }
    Ok(ParsedAudioFacts::default())
}

fn mp3_sample_rate(version_bits: u8, sample_bits: u8) -> Option<u32> {
    let base = match sample_bits {
        0 => 44_100,
        1 => 48_000,
        2 => 32_000,
        _ => return None,
    };
    match version_bits {
        3 => Some(base),
        2 => Some(base / 2),
        0 => Some(base / 4),
        _ => None,
    }
}

fn mp3_bitrate_kbps(version_bits: u8, bitrate_bits: u8) -> Option<u32> {
    if bitrate_bits == 0 || bitrate_bits == 15 {
        return None;
    }
    let mpeg1_layer3 = [
        0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
    ];
    let mpeg2_layer3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    let table = if version_bits == 3 {
        mpeg1_layer3
    } else {
        mpeg2_layer3
    };
    Some(table[bitrate_bits as usize])
}

fn extended_80_to_f64(bytes: &[u8]) -> f64 {
    if bytes.len() != 10 {
        return 0.0;
    }
    let exponent = ((bytes[0] as u16 & 0x7f) << 8) | bytes[1] as u16;
    let mantissa = u64::from_be_bytes([
        bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9],
    ]);
    if exponent == 0 || mantissa == 0 {
        return 0.0;
    }
    let fraction = mantissa as f64 / (1_u64 << 63) as f64;
    fraction * 2_f64.powi(exponent as i32 - 16383)
}

#[cfg(test)]
mod tests {
    use std::fs::{remove_file, write};

    use super::*;

    #[test]
    fn extracts_wav_metadata() {
        let path = std::env::temp_dir().join("sonilabs_phase2_metadata.wav");
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&40_u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&48_000_u32.to_le_bytes());
        wav.extend_from_slice(&192_000_u32.to_le_bytes());
        wav.extend_from_slice(&4_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&4_u32.to_le_bytes());
        wav.extend_from_slice(&[0, 0, 0, 0]);
        write(&path, wav).expect("write wav");

        let metadata = extract_basic_metadata(&path).expect("extract metadata");
        assert_eq!(metadata.sample_rate, Some(48_000));
        assert_eq!(metadata.channels, Some(2));
        assert_eq!(metadata.bit_depth, Some(16));
        assert_eq!(metadata.probe.format, Some("wav".to_string()));

        let _ = remove_file(path);
    }

    #[test]
    fn rejects_corrupt_wav_metadata() {
        let path = std::env::temp_dir().join("sonilabs_corrupt_metadata.wav");
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&40_u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&[0, 1, 2]);
        write(&path, wav).expect("write corrupt wav");

        let error = extract_basic_metadata(&path).expect_err("reject corrupt wav");

        assert!(error.contains("corrupt WAV"));
        let _ = remove_file(path);
    }
}
