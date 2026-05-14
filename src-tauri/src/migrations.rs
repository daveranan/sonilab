use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Manager};

struct Migration {
    version: i64,
    name: &'static str,
    up_sql: &'static str,
    down_sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "core_data_layer",
        up_sql: include_str!("../migrations/001_core_data_layer.up.sql"),
        down_sql: include_str!("../migrations/001_core_data_layer.down.sql"),
    },
    Migration {
        version: 2,
        name: "search_index",
        up_sql: include_str!("../migrations/002_search_index.up.sql"),
        down_sql: include_str!("../migrations/002_search_index.down.sql"),
    },
    Migration {
        version: 3,
        name: "analysis_cache_columns",
        up_sql: include_str!("../migrations/003_analysis_cache_columns.up.sql"),
        down_sql: include_str!("../migrations/003_analysis_cache_columns.down.sql"),
    },
    Migration {
        version: 4,
        name: "waveform_peak_files",
        up_sql: include_str!("../migrations/004_waveform_peak_files.up.sql"),
        down_sql: include_str!("../migrations/004_waveform_peak_files.down.sql"),
    },
    Migration {
        version: 5,
        name: "user_annotations",
        up_sql: include_str!("../migrations/005_user_annotations.up.sql"),
        down_sql: include_str!("../migrations/005_user_annotations.down.sql"),
    },
];

#[derive(Serialize)]
pub struct MigrationInfo {
    version: i64,
    name: &'static str,
    applied: bool,
    up_bytes: usize,
    down_bytes: usize,
}

#[derive(Serialize)]
pub struct MigrationReport {
    database_path: String,
    migrations: Vec<MigrationInfo>,
    applied_versions: Vec<i64>,
}

pub fn app_database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join("sonilabs.sqlite3"))
}

pub fn migration_status(app: &AppHandle) -> Result<MigrationReport, String> {
    let path = app_database_path(app)?;
    let connection = Connection::open(&path).map_err(|error| error.to_string())?;
    ensure_migration_table(&connection)?;
    report_for_connection(path, &connection)
}

pub fn run_migrations(app: &AppHandle) -> Result<MigrationReport, String> {
    let path = app_database_path(app)?;
    let mut connection = Connection::open(&path).map_err(|error| error.to_string())?;
    connection
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|error| error.to_string())?;
    ensure_migration_table(&connection)?;

    let applied = applied_versions(&connection)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    for migration in MIGRATIONS {
        if applied.contains(&migration.version) {
            continue;
        }

        transaction
            .execute_batch(migration.up_sql)
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO schema_migrations (version, name) VALUES (?1, ?2)",
                params![migration.version, migration.name],
            )
            .map_err(|error| error.to_string())?;
    }

    transaction.commit().map_err(|error| error.to_string())?;
    report_for_connection(path, &connection)
}

fn ensure_migration_table(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );",
        )
        .map_err(|error| error.to_string())
}

fn applied_versions(connection: &Connection) -> Result<HashSet<i64>, String> {
    let mut statement = connection
        .prepare("SELECT version FROM schema_migrations")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, i64>(0))
        .map_err(|error| error.to_string())?;

    let mut versions = HashSet::new();
    for row in rows {
        versions.insert(row.map_err(|error| error.to_string())?);
    }

    Ok(versions)
}

fn report_for_connection(
    path: PathBuf,
    connection: &Connection,
) -> Result<MigrationReport, String> {
    let applied = applied_versions(connection)?;
    let migrations = MIGRATIONS
        .iter()
        .map(|migration| MigrationInfo {
            version: migration.version,
            name: migration.name,
            applied: applied.contains(&migration.version),
            up_bytes: migration.up_sql.len(),
            down_bytes: migration.down_sql.len(),
        })
        .collect();

    Ok(MigrationReport {
        database_path: path.display().to_string(),
        migrations,
        applied_versions: applied.into_iter().collect(),
    })
}
