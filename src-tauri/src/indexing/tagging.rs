use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};

pub const TAG_ENRICHMENT_VERSION: i64 = 2;
const MAX_KEYWORD_TAGS_PER_ASSET: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagEnrichment {
    pub tags: Vec<String>,
    pub derived_tags: Vec<String>,
    pub categorized_tags: BTreeMap<String, Vec<String>>,
}

pub fn enrich_asset_tags(
    imported_tags: &[String],
    name: &str,
    relative_path: &str,
    description: Option<&str>,
) -> TagEnrichment {
    let evidence = searchable_text(name, relative_path, description);
    let keywords = keyword_source_text(name, relative_path, description);
    let mut all_tags = BTreeSet::new();
    let mut derived_tags = BTreeSet::new();
    let mut categorized = BTreeMap::<String, BTreeSet<String>>::new();

    for tag in imported_tags {
        if let Some(normalized) = canonicalize_tag(tag) {
            categorized
                .entry("metadata".to_string())
                .or_default()
                .insert(normalized.clone());
            all_tags.insert(normalized);
        }
    }

    for rule in TAG_RULES {
        if rule.matches(&evidence) {
            let tag = rule.tag.to_string();
            categorized
                .entry(rule.category.to_string())
                .or_default()
                .insert(tag.clone());
            derived_tags.insert(tag.clone());
            all_tags.insert(tag);
        }
    }

    for keyword in keyword_tags(&keywords) {
        categorized
            .entry("keyword".to_string())
            .or_default()
            .insert(keyword.clone());
        derived_tags.insert(keyword.clone());
        all_tags.insert(keyword);
    }

    TagEnrichment {
        tags: all_tags.into_iter().collect(),
        derived_tags: derived_tags.into_iter().collect(),
        categorized_tags: categorized
            .into_iter()
            .map(|(category, tags)| (category, tags.into_iter().collect()))
            .collect(),
    }
}

pub fn merge_tag_enrichment_metadata_json(
    metadata_json: &str,
    enrichment: &TagEnrichment,
) -> String {
    let mut root = serde_json::from_str::<Value>(metadata_json).unwrap_or_else(|_| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    let Some(object) = root.as_object_mut() else {
        return metadata_json.to_string();
    };
    object.insert(
        "tagEnrichment".to_string(),
        json!({
            "version": TAG_ENRICHMENT_VERSION,
            "derivedTags": enrichment.derived_tags,
            "categorizedTags": enrichment.categorized_tags,
        }),
    );
    root.to_string()
}

struct TagRule {
    category: &'static str,
    tag: &'static str,
    terms: &'static [&'static str],
}

impl TagRule {
    fn matches(&self, evidence: &str) -> bool {
        self.terms
            .iter()
            .any(|term| evidence.contains(&format!(" {term} ")))
    }
}

const TAG_RULES: &[TagRule] = &[
    TagRule {
        category: "content",
        tag: "ambience",
        terms: &[
            "ambience",
            "ambiences",
            "ambiance",
            "ambient",
            "atmo",
            "amb",
        ],
    },
    TagRule {
        category: "content",
        tag: "electric",
        terms: &[
            "electric",
            "electrical",
            "electricity",
            "electronic",
            "electromagnetic",
            "elecarc",
            "elecemf",
            "energy",
            "spark",
            "zap",
            "zaps",
            "zapper",
        ],
    },
    TagRule {
        category: "content",
        tag: "foley",
        terms: &["foley", "movement", "handling", "foleyfeet", "patting"],
    },
    TagRule {
        category: "content",
        tag: "ui",
        terms: &[
            "ui",
            "button",
            "buttons",
            "click",
            "cmptkey",
            "uiclick",
            "uialert",
            "uimvmt",
            "interface",
            "menu",
            "confirm",
            "select",
            "hover",
            "notification",
            "user",
        ],
    },
    TagRule {
        category: "content",
        tag: "bass drop",
        terms: &["bass drop", "bassdrop", "drop"],
    },
    TagRule {
        category: "content",
        tag: "blast",
        terms: &["blast", "explosion", "boom"],
    },
    TagRule {
        category: "content",
        tag: "drone",
        terms: &["drone", "drones"],
    },
    TagRule {
        category: "content",
        tag: "glitch",
        terms: &["glitch", "glitched", "digital", "decoded"],
    },
    TagRule {
        category: "content",
        tag: "impact",
        terms: &[
            "impact", "impacts", "hit", "hits", "physics", "crash", "slam",
        ],
    },
    TagRule {
        category: "content",
        tag: "riser",
        terms: &["riser", "risers", "dsgnrise", "rise", "build"],
    },
    TagRule {
        category: "content",
        tag: "whoosh",
        terms: &[
            "whoosh", "woosh", "whsh", "swish", "swoosh", "sweep", "sweeper",
        ],
    },
    TagRule {
        category: "form",
        tag: "loop",
        terms: &["loop", "loops", "looping"],
    },
    TagRule {
        category: "form",
        tag: "one shot",
        terms: &["oneshot", "one shot", "single"],
    },
    TagRule {
        category: "form",
        tag: "mono",
        terms: &["mono"],
    },
    TagRule {
        category: "form",
        tag: "stereo",
        terms: &["stereo"],
    },
    TagRule {
        category: "object",
        tag: "chain",
        terms: &["chain", "chains"],
    },
    TagRule {
        category: "object",
        tag: "box",
        terms: &["box", "boxes", "bin", "canister"],
    },
    TagRule {
        category: "object",
        tag: "door",
        terms: &["door", "doors", "doorwood", "doormetl", "doorslid", "gate"],
    },
    TagRule {
        category: "object",
        tag: "tableware",
        terms: &[
            "tableware",
            "table",
            "foodtware",
            "plate",
            "plates",
            "cup",
            "cups",
            "glassware",
            "cutlery",
            "bottle",
        ],
    },
    TagRule {
        category: "object",
        tag: "tools",
        terms: &["tool", "tools", "saw", "screwdriver"],
    },
    TagRule {
        category: "object",
        tag: "furniture",
        terms: &[
            "furniture",
            "objfurn",
            "chair",
            "cabinet",
            "drawer",
            "drawers",
            "rack",
        ],
    },
    TagRule {
        category: "object",
        tag: "hardware",
        terms: &[
            "key", "keyboard", "latch", "lid", "lock", "switch", "springs",
        ],
    },
    TagRule {
        category: "object",
        tag: "zapper",
        terms: &["zapper"],
    },
    TagRule {
        category: "environment",
        tag: "city",
        terms: &["city", "urban", "street", "streets", "traffic", "road"],
    },
    TagRule {
        category: "environment",
        tag: "interior",
        terms: &[
            "interior", "int", "room", "house", "office", "indoor", "inside", "bathroom", "church",
            "prison", "stairs",
        ],
    },
    TagRule {
        category: "environment",
        tag: "nature",
        terms: &[
            "nature", "forest", "jungle", "outdoor", "outside", "exterior", "ext", "forest",
            "canals", "marine",
        ],
    },
    TagRule {
        category: "environment",
        tag: "weather",
        terms: &["weather", "rain", "wind", "thunder"],
    },
    TagRule {
        category: "environment",
        tag: "space",
        terms: &["space"],
    },
    TagRule {
        category: "creature",
        tag: "animal",
        terms: &[
            "animal",
            "animals",
            "creature",
            "creatures",
            "bird",
            "birds",
            "cat",
            "dog",
        ],
    },
    TagRule {
        category: "creature",
        tag: "monster",
        terms: &[
            "monster", "monsters", "beast", "alien", "antlion", "headcrab",
        ],
    },
    TagRule {
        category: "subject",
        tag: "npc",
        terms: &["npc", "player"],
    },
    TagRule {
        category: "subject",
        tag: "zombie",
        terms: &["zombie", "zombies"],
    },
    TagRule {
        category: "subject",
        tag: "combine soldier",
        terms: &["combine soldier", "combine", "soldier"],
    },
    TagRule {
        category: "subject",
        tag: "metropolice",
        terms: &["metropolice", "metro police"],
    },
    TagRule {
        category: "subject",
        tag: "overwatch",
        terms: &["overwatch"],
    },
    TagRule {
        category: "voice",
        tag: "vo",
        terms: &[
            "vo",
            "voice",
            "voiceover",
            "voice-over",
            "vocal",
            "male",
            "female",
            "call",
        ],
    },
    TagRule {
        category: "voice",
        tag: "dialogue",
        terms: &["dialog", "dialogue", "speech", "spoken"],
    },
    TagRule {
        category: "voice",
        tag: "radio",
        terms: &["radio", "radiovoice", "radio voice"],
    },
    TagRule {
        category: "action",
        tag: "alert",
        terms: &["alert", "alerts", "warn", "warning", "uialert"],
    },
    TagRule {
        category: "action",
        tag: "attack",
        terms: &["attack", "attacks", "battle", "action"],
    },
    TagRule {
        category: "action",
        tag: "death",
        terms: &["die", "dies", "death"],
    },
    TagRule {
        category: "action",
        tag: "open",
        terms: &["open", "opening", "exit"],
    },
    TagRule {
        category: "action",
        tag: "close",
        terms: &["close", "closing", "shut"],
    },
    TagRule {
        category: "action",
        tag: "pickup",
        terms: &["pickup", "pick-up", "pick", "collect"],
    },
    TagRule {
        category: "action",
        tag: "start",
        terms: &["start", "starts"],
    },
    TagRule {
        category: "action",
        tag: "stop",
        terms: &["stop", "stops"],
    },
    TagRule {
        category: "action",
        tag: "idle",
        terms: &["idle"],
    },
    TagRule {
        category: "action",
        tag: "turn",
        terms: &["turn", "turns"],
    },
    TagRule {
        category: "action",
        tag: "slide",
        terms: &["slide", "slides", "sliding"],
    },
    TagRule {
        category: "action",
        tag: "pull",
        terms: &["pull", "push", "press"],
    },
    TagRule {
        category: "action",
        tag: "rattle",
        terms: &["rattle"],
    },
    TagRule {
        category: "weapon",
        tag: "gun",
        terms: &[
            "gun", "guns", "firearm", "rifle", "pistol", "bullet", "weapon", "weapons",
        ],
    },
    TagRule {
        category: "weapon",
        tag: "submachine gun",
        terms: &[
            "submachine gun",
            "sub machine gun",
            "machine gun",
            "smg",
            "mp5",
            "mac 10",
            "mac10",
            "thompson",
            "m3",
        ],
    },
    TagRule {
        category: "weapon",
        tag: "mp5",
        terms: &["mp5"],
    },
    TagRule {
        category: "weapon",
        tag: "mac 10",
        terms: &["mac 10", "mac10"],
    },
    TagRule {
        category: "weapon",
        tag: "thompson",
        terms: &["thompson"],
    },
    TagRule {
        category: "weapon",
        tag: "rifle",
        terms: &["rifle", "winchester", "hk53"],
    },
    TagRule {
        category: "weapon",
        tag: "hk53",
        terms: &["hk53"],
    },
    TagRule {
        category: "weapon",
        tag: "shotgun",
        terms: &["shotgun", "shot gun", "12 gauge", "gauge"],
    },
    TagRule {
        category: "weapon",
        tag: "handgun",
        terms: &["handgun", "hand gun", "pistol", "glock", "colt", "magnum"],
    },
    TagRule {
        category: "weapon",
        tag: "glock",
        terms: &["glock"],
    },
    TagRule {
        category: "weapon",
        tag: "colt",
        terms: &["colt"],
    },
    TagRule {
        category: "weapon",
        tag: "melee",
        terms: &["melee", "blade", "sword", "knife"],
    },
    TagRule {
        category: "vehicle",
        tag: "vehicle",
        terms: &[
            "vehicle",
            "vehicles",
            "auto",
            "car",
            "cars",
            "truck",
            "engine",
            "exhaust",
            "honda",
            "ford",
            "race",
            "lincoln",
            "accord",
            "civic",
            "civicex",
            "cutlass",
            "oldsmobile",
            "suv",
            "tank",
            "motor",
            "motorcycle",
            "ford-f",
        ],
    },
    TagRule {
        category: "vehicle",
        tag: "aircraft",
        terms: &["aircraft", "airplane", "plane", "jet", "helicopter"],
    },
    TagRule {
        category: "vehicle",
        tag: "boat",
        terms: &["boat", "ship"],
    },
    TagRule {
        category: "vehicle",
        tag: "train",
        terms: &["train"],
    },
    TagRule {
        category: "music",
        tag: "music",
        terms: &[
            "music",
            "musical",
            "song",
            "score",
            "themes",
            "intro",
            "introthemes",
        ],
    },
    TagRule {
        category: "music",
        tag: "stinger",
        terms: &["stinger", "sting", "jingle", "dsgnstngr"],
    },
    TagRule {
        category: "music",
        tag: "genre",
        terms: &[
            "techno",
            "trance",
            "pop",
            "lofi",
            "trap",
            "cyberpunk",
            "houseedm",
            "levelthemes",
            "edm",
            "dnb",
            "synthwave",
            "synth",
        ],
    },
    TagRule {
        category: "music",
        tag: "piano",
        terms: &["piano", "modernpiano", "breathofthewildpiano"],
    },
    TagRule {
        category: "material",
        tag: "air",
        terms: &["air", "airy", "airborne", "wind"],
    },
    TagRule {
        category: "material",
        tag: "cloth",
        terms: &["cloth", "fabric", "carpet", "leather"],
    },
    TagRule {
        category: "material",
        tag: "glass",
        terms: &["glass", "glassware"],
    },
    TagRule {
        category: "material",
        tag: "metal",
        terms: &[
            "metal", "metallic", "clank", "clanking", "clang", "clanging",
        ],
    },
    TagRule {
        category: "material",
        tag: "sand",
        terms: &["sand", "dirt", "gravel", "mud"],
    },
    TagRule {
        category: "material",
        tag: "stone",
        terms: &[
            "stone",
            "rock",
            "rocks",
            "concrete",
            "cleanconcrete",
            "tile",
            "bricks",
        ],
    },
    TagRule {
        category: "material",
        tag: "water",
        terms: &["water", "liquid", "splash", "waves", "wet", "flow", "spray"],
    },
    TagRule {
        category: "material",
        tag: "wood",
        terms: &["wood", "wooden", "solidwood"],
    },
    TagRule {
        category: "material",
        tag: "plastic",
        terms: &["plastic"],
    },
    TagRule {
        category: "material",
        tag: "paper",
        terms: &["paper", "cardboard"],
    },
    TagRule {
        category: "material",
        tag: "debris",
        terms: &["debris", "materials"],
    },
    TagRule {
        category: "motion",
        tag: "passby",
        terms: &["passby", "pass-by", "flyby", "fly-by", "pass", "fly"],
    },
    TagRule {
        category: "motion",
        tag: "scrape",
        terms: &[
            "scrape", "scraping", "scratch", "scuffs", "rubbing", "metlfric",
        ],
    },
    TagRule {
        category: "motion",
        tag: "swipe",
        terms: &["swipe", "swish", "sweep"],
    },
    TagRule {
        category: "motion",
        tag: "footstep",
        terms: &[
            "footstep",
            "footsteps",
            "foleyfeet",
            "boots",
            "sneakers",
            "shoes",
            "walk",
            "run",
            "running",
            "step",
            "barefoot",
        ],
    },
    TagRule {
        category: "motion",
        tag: "speed",
        terms: &["slow", "medium", "mid", "fast", "quick", "speed"],
    },
    TagRule {
        category: "tone",
        tag: "aggressive",
        terms: &["aggressive", "violent"],
    },
    TagRule {
        category: "tone",
        tag: "atonal",
        terms: &["atonal"],
    },
    TagRule {
        category: "tone",
        tag: "cinematic",
        terms: &["cinematic", "trailer", "trailers", "dramatic"],
    },
    TagRule {
        category: "tone",
        tag: "designed",
        terms: &["designed", "design", "production", "sfx"],
    },
    TagRule {
        category: "tone",
        tag: "dark",
        terms: &["dark", "darkness"],
    },
    TagRule {
        category: "tone",
        tag: "deep",
        terms: &["deep", "low"],
    },
    TagRule {
        category: "tone",
        tag: "size",
        terms: &["small", "large", "big", "short", "long"],
    },
    TagRule {
        category: "tone",
        tag: "weight",
        terms: &["light", "heavy", "soft", "hard", "solid", "full"],
    },
    TagRule {
        category: "tone",
        tag: "distance",
        terms: &["distant", "away"],
    },
    TagRule {
        category: "tone",
        tag: "retro",
        terms: &["retro", "old", "clean"],
    },
    TagRule {
        category: "tone",
        tag: "futuristic",
        terms: &["futuristic", "future", "sci-fi", "scifi"],
    },
    TagRule {
        category: "tone",
        tag: "harsh",
        terms: &["harsh", "piercing"],
    },
    TagRule {
        category: "tone",
        tag: "high",
        terms: &["high"],
    },
    TagRule {
        category: "tone",
        tag: "scary",
        terms: &["scary", "horror", "fear", "tense", "eerie"],
    },
    TagRule {
        category: "tone",
        tag: "tonal",
        terms: &["tonal", "tone"],
    },
    TagRule {
        category: "destruction",
        tag: "explosion",
        terms: &[
            "blast",
            "boom",
            "break",
            "broken",
            "burst",
            "explo",
            "explosion",
            "explosions",
            "fire",
            "rumble",
        ],
    },
];

fn searchable_text(name: &str, relative_path: &str, description: Option<&str>) -> String {
    let combined = format!(
        " {} {} {} ",
        name,
        relative_path,
        description.unwrap_or_default()
    )
    .to_ascii_lowercase()
    .replace(['_', '.', '/', '\\'], " ");
    format!(
        " {} ",
        combined
            .split_whitespace()
            .filter_map(clean_evidence_token)
            .collect::<Vec<_>>()
            .join(" ")
    )
}

fn clean_evidence_token(token: &str) -> Option<String> {
    if token.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    if ALPHANUMERIC_KEYWORD_ALLOWLIST.contains(&token) {
        return Some(token.to_string());
    }
    let cleaned = token.trim_end_matches(|ch: char| ch.is_ascii_digit());
    (!cleaned.is_empty()).then(|| cleaned.to_string())
}

fn keyword_source_text(name: &str, relative_path: &str, description: Option<&str>) -> String {
    let file_stem = name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name);
    let useful_path = relative_path
        .replace('\\', "/")
        .split('/')
        .rev()
        .skip(1)
        .take(2)
        .map(strip_vendor_folder_prefix)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" ");
    let file_text = searchable_text(file_stem, "", description);
    let folder_text = searchable_text("", &useful_path, None);
    let folder_keywords = folder_text
        .split_whitespace()
        .filter(|token| !FOLDER_KEYWORD_STOP_WORDS.contains(token))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{file_text} {folder_keywords}")
}

fn strip_vendor_folder_prefix(segment: &str) -> &str {
    let Some((prefix, rest)) = segment.split_once(" - ") else {
        return segment;
    };
    if is_likely_vendor_prefix(prefix) {
        rest.trim()
    } else {
        segment
    }
}

fn is_likely_vendor_prefix(prefix: &str) -> bool {
    let trimmed = prefix.trim();
    let lower = trimmed.to_ascii_lowercase();
    if trimmed.len() < 3 || trimmed.len() > 36 {
        return false;
    }
    if lower.contains("pack")
        || lower.contains("bundle")
        || lower.contains("library")
        || lower.contains("sound")
        || lower.contains("sfx")
        || lower.contains("effect")
    {
        return false;
    }
    let word_count = lower
        .split_whitespace()
        .filter(|word| !word.is_empty())
        .count();
    word_count <= 4
}

pub fn canonicalize_tag(tag: &str) -> Option<String> {
    let normalized = tag
        .trim()
        .to_ascii_lowercase()
        .replace('_', " ")
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' {
                ch
            } else if ch.is_whitespace() {
                ' '
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches('-')
        .to_string();
    (!normalized.is_empty()).then_some(normalized)
}

fn keyword_tags(evidence: &str) -> BTreeSet<String> {
    let mut tags = BTreeSet::new();
    for keyword in evidence.split_whitespace().filter_map(clean_keyword_token) {
        tags.insert(keyword);
        if tags.len() >= MAX_KEYWORD_TAGS_PER_ASSET {
            break;
        }
    }
    tags
}

fn clean_keyword_token(token: &str) -> Option<String> {
    let cleaned = canonicalize_tag(token)?;
    if cleaned.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    if ALPHANUMERIC_KEYWORD_ALLOWLIST.contains(&cleaned.as_str()) {
        return Some(cleaned);
    }
    let cleaned = if cleaned.chars().any(|ch| ch.is_ascii_digit()) {
        cleaned
            .trim_end_matches(|ch: char| ch.is_ascii_digit())
            .to_string()
    } else {
        cleaned
    };
    if cleaned.len() < 3 || KEYWORD_STOP_WORDS.contains(&cleaned.as_str()) {
        return None;
    }
    Some(cleaned)
}

const ALPHANUMERIC_KEYWORD_ALLOWLIST: &[&str] = &["hk53", "m3", "mac10", "mg34", "mp5"];

const KEYWORD_STOP_WORDS: &[&str] = &[
    "aif",
    "aiff",
    "and",
    "audio",
    "bundle",
    "file",
    "flac",
    "for",
    "fundamentals",
    "kit",
    "library",
    "looping",
    "mp3",
    "ogg",
    "pack",
    "sample",
    "sound",
    "sounds",
    "the",
    "vendor",
    "wav",
    "wave",
];

const FOLDER_KEYWORD_STOP_WORDS: &[&str] = &["update", "updated", "updates"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_imported_and_derived_tags() {
        let enrichment = enrich_asset_tags(
            &["Cinematic Trailers".to_string()],
            "CDCK Drone High 07.wav",
            "cinematic_darkness/CDCK Drone High 07.wav",
            Some("DRONE HIGH AIRY ATONAL SCARY PIERCING"),
        );

        assert!(enrichment.tags.contains(&"cinematic trailers".to_string()));
        assert!(enrichment.tags.contains(&"drone".to_string()));
        assert!(enrichment.tags.contains(&"air".to_string()));
        assert_eq!(
            enrichment.categorized_tags.get("metadata"),
            Some(&vec!["cinematic trailers".to_string()])
        );
    }

    #[test]
    fn tags_halflife_style_ambient_energy_assets() {
        let enrichment = enrich_asset_tags(
            &[],
            "zapper_ambient_loop1.wav",
            "sound/ambient/levels/citadel/zapper_ambient_loop1.wav",
            None,
        );

        for tag in ["ambience", "electric", "loop", "zapper"] {
            assert!(enrichment.tags.contains(&tag.to_string()), "missing {tag}");
        }
    }

    #[test]
    fn tags_halflife_style_npc_voice_assets() {
        let enrichment = enrich_asset_tags(
            &[],
            "zombie_die1.wav",
            "sound/npc/zombie/zombie_die1.wav",
            None,
        );

        for tag in ["npc", "zombie", "death"] {
            assert!(enrichment.tags.contains(&tag.to_string()), "missing {tag}");
        }
    }

    #[test]
    fn extracts_unknown_words_as_keyword_tags() {
        let enrichment = enrich_asset_tags(
            &[],
            "xylophone_widget_morph12.wav",
            "vendor/weird_pack/xylophone_widget_morph12.wav",
            None,
        );

        for tag in ["weird", "xylophone", "widget", "morph"] {
            assert!(enrichment.tags.contains(&tag.to_string()), "missing {tag}");
        }
        assert_eq!(
            enrichment.categorized_tags.get("keyword"),
            Some(&vec![
                "morph".to_string(),
                "weird".to_string(),
                "widget".to_string(),
                "xylophone".to_string(),
            ])
        );
    }

    #[test]
    fn canonicalizes_tags_without_splitting_hyphenated_words() {
        assert_eq!(canonicalize_tag(" chain, "), Some("chain".to_string()));
        assert_eq!(canonicalize_tag("clink,, "), Some("clink".to_string()));
        assert_eq!(canonicalize_tag("sci-fi"), Some("sci-fi".to_string()));
        assert_eq!(
            canonicalize_tag("food, drink"),
            Some("food drink".to_string())
        );
    }

    #[test]
    fn keyword_tags_use_canonical_tokens() {
        let enrichment = enrich_asset_tags(
            &[],
            "sci-fi_door_open01.wav",
            "source/folder/sci-fi_door_open01.wav",
            Some("Food, electricity, place, down. Celebrate,, clink,,"),
        );

        for tag in [
            "sci-fi",
            "door",
            "open",
            "food",
            "electricity",
            "place",
            "down",
            "celebrate",
            "clink",
        ] {
            assert!(enrichment.tags.contains(&tag.to_string()), "missing {tag}");
        }
        for noisy in ["sci", "fi", "food,", "celebrate,", "clink,"] {
            assert!(
                !enrichment.tags.contains(&noisy.to_string()),
                "kept noisy tag {noisy}"
            );
        }
    }

    #[test]
    fn ignores_pack_update_folder_noise() {
        let enrichment = enrich_asset_tags(
            &[],
            "Zesty Battle.wav",
            "Techno_Trance_Update_2/Zesty Battle.wav",
            None,
        );

        assert!(enrichment.tags.contains(&"techno".to_string()));
        assert!(enrichment.tags.contains(&"trance".to_string()));
        assert!(
            !enrichment.tags.contains(&"update".to_string()),
            "folder maintenance word leaked into tags"
        );
    }

    #[test]
    fn keeps_update_when_it_is_in_the_file_name() {
        let enrichment = enrich_asset_tags(
            &[],
            "software update beep.wav",
            "Techno_Trance_Update_2/software update beep.wav",
            None,
        );

        assert!(enrichment.tags.contains(&"update".to_string()));
    }

    #[test]
    fn tags_specific_gun_models_and_types() {
        let enrichment = enrich_asset_tags(
            &[],
            "14 - gun. machine gun mp5 suppressed - short burst. silencer.wav",
            "6025/14 - gun. machine gun mp5 suppressed - short burst. silencer.wav",
            None,
        );

        for tag in ["gun", "submachine gun", "mp5", "burst"] {
            assert!(enrichment.tags.contains(&tag.to_string()), "missing {tag}");
        }
    }

    #[test]
    fn strips_repeated_vendor_prefixes_from_folder_keywords() {
        let enrichment = enrich_asset_tags(
            &[],
            "bird close.wav",
            "Ivo Vicic - European mountain forest animal/bird close.wav",
            None,
        );

        for noisy in ["ivo", "vicic"] {
            assert!(
                !enrichment.tags.contains(&noisy.to_string()),
                "kept vendor keyword {noisy}"
            );
        }
        for useful in ["european", "mountain", "forest", "animal"] {
            assert!(
                enrichment.tags.contains(&useful.to_string()),
                "missing useful folder keyword {useful}"
            );
        }
    }
}
