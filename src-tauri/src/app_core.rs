use serde::Serialize;

#[derive(Serialize)]
pub struct AppStatus {
    status: &'static str,
    indexing_ready: bool,
    audio_ready: bool,
    export_ready: bool,
}

impl AppStatus {
    pub fn ready() -> Self {
        Self {
            status: "ready",
            indexing_ready: true,
            audio_ready: true,
            export_ready: true,
        }
    }
}
