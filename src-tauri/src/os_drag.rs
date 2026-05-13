use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartNativeFileDragRequest {
    pub file_path: String,
    pub file_paths: Option<Vec<String>>,
    pub icon_path: Option<String>,
    pub display_name: Option<String>,
    pub allowed_effect: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartNativeFileDragResponse {
    pub ok: bool,
    pub effect: String,
    pub error: Option<String>,
    pub diagnostics: Vec<String>,
}

pub fn start_native_file_drag(request: StartNativeFileDragRequest) -> StartNativeFileDragResponse {
    let mut diagnostics = Vec::new();
    if request.allowed_effect != "copy" {
        return failure("allowedEffect must be copy", diagnostics);
    }
    if request.icon_path.is_some() {
        diagnostics.push("custom drag icons are not implemented for native file drag".to_string());
    }
    if request.display_name.is_some() {
        diagnostics.push(
            "displayName is accepted for API compatibility but CF_HDROP uses the file name"
                .to_string(),
        );
    }

    let paths = match validate_request_file_paths(&request) {
        Ok(paths) => paths,
        Err(error) => return failure(&error, diagnostics),
    };

    start_native_file_drag_for_paths(paths, diagnostics)
}

#[cfg(target_os = "windows")]
pub fn start_native_file_drag_on_window_thread(
    request: StartNativeFileDragRequest,
) -> StartNativeFileDragResponse {
    start_native_file_drag(request)
}

#[cfg(not(target_os = "windows"))]
pub fn start_native_file_drag_on_window_thread(
    request: StartNativeFileDragRequest,
) -> StartNativeFileDragResponse {
    start_native_file_drag(request)
}

pub fn validate_file_path(file_path: &str) -> Result<PathBuf, String> {
    if file_path.trim().is_empty() {
        return Err("filePath is required".to_string());
    }
    let path = PathBuf::from(file_path);
    let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.is_dir() {
        return Err("filePath must point to a file, not a directory".to_string());
    }
    if !metadata.is_file() {
        return Err("filePath must point to a regular file".to_string());
    }
    std::fs::canonicalize(path)
        .map(normalize_shell_path)
        .map_err(|error| error.to_string())
}

pub fn diagnose_native_file_drag_payload(
    request: StartNativeFileDragRequest,
) -> StartNativeFileDragResponse {
    let mut diagnostics = Vec::new();
    if request.allowed_effect != "copy" {
        return failure("allowedEffect must be copy", diagnostics);
    }
    let paths = match validate_request_file_paths(&request) {
        Ok(paths) => paths,
        Err(error) => return failure(&error, diagnostics),
    };

    match validate_native_file_drag_payload(&paths) {
        Ok(mut payload_diagnostics) => {
            diagnostics.append(&mut payload_diagnostics);
            StartNativeFileDragResponse {
                ok: true,
                effect: "copy".to_string(),
                error: None,
                diagnostics,
            }
        }
        Err(error) => failure(&error, diagnostics),
    }
}

fn validate_request_file_paths(
    request: &StartNativeFileDragRequest,
) -> Result<Vec<PathBuf>, String> {
    let requested = request
        .file_paths
        .as_ref()
        .filter(|paths| !paths.is_empty())
        .cloned()
        .unwrap_or_else(|| vec![request.file_path.clone()]);
    if requested.is_empty() {
        return Err("filePath or filePaths is required".to_string());
    }
    requested
        .iter()
        .map(|path| validate_file_path(path))
        .collect()
}

#[cfg(target_os = "windows")]
fn normalize_shell_path(path: PathBuf) -> PathBuf {
    let path_text = path.to_string_lossy();
    if let Some(stripped) = path_text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{stripped}"));
    }
    if let Some(stripped) = path_text.strip_prefix(r"\\?\") {
        return PathBuf::from(stripped);
    }
    path
}

#[cfg(not(target_os = "windows"))]
fn normalize_shell_path(path: PathBuf) -> PathBuf {
    path
}

fn failure(error: &str, diagnostics: Vec<String>) -> StartNativeFileDragResponse {
    StartNativeFileDragResponse {
        ok: false,
        effect: "none".to_string(),
        error: Some(error.to_string()),
        diagnostics,
    }
}

#[cfg(target_os = "windows")]
fn start_native_file_drag_for_paths(
    paths: Vec<PathBuf>,
    mut diagnostics: Vec<String>,
) -> StartNativeFileDragResponse {
    match validate_native_file_drag_payload(&paths) {
        Ok(mut payload_diagnostics) => diagnostics.append(&mut payload_diagnostics),
        Err(error) => return failure(&error, diagnostics),
    }

    match drag_files_from_current_sta(paths) {
        Ok(effect) => {
            diagnostics.push("Windows DoDragDrop completed on Tauri window thread".to_string());
            StartNativeFileDragResponse {
                ok: true,
                effect,
                error: None,
                diagnostics,
            }
        }
        Err(error) => failure(&error, diagnostics),
    }
}

#[cfg(not(target_os = "windows"))]
fn start_native_file_drag_for_paths(
    _paths: Vec<PathBuf>,
    diagnostics: Vec<String>,
) -> StartNativeFileDragResponse {
    failure(
        "native file drag is only implemented on Windows",
        diagnostics,
    )
}

#[cfg(target_os = "windows")]
fn validate_native_file_drag_payload(paths: &[PathBuf]) -> Result<Vec<String>, String> {
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::UI::Shell::{DragFinish, DragQueryFileW, HDROP};

    unsafe {
        let hglobal = hdrop_for_paths(paths).map_err(|error| error.message().to_string())?;
        let hdrop = HDROP(hglobal.0 as _);
        let count = DragQueryFileW(hdrop, u32::MAX, None);
        if count != paths.len() as u32 {
            DragFinish(hdrop);
            return Err(format!(
                "CF_HDROP exposed {count} files instead of {}",
                paths.len()
            ));
        }

        let mut decoded_paths = Vec::new();
        for index in 0..count {
            let character_count = DragQueryFileW(hdrop, index, None);
            if character_count == 0 {
                DragFinish(hdrop);
                return Err("CF_HDROP file path could not be queried".to_string());
            }

            let mut buffer = vec![0u16; character_count as usize + 1];
            let copied = DragQueryFileW(hdrop, index, Some(&mut buffer));
            if copied == 0 {
                DragFinish(hdrop);
                return Err("CF_HDROP file path copy failed".to_string());
            }
            buffer.truncate(copied as usize);
            decoded_paths.push(PathBuf::from(std::ffi::OsString::from_wide(&buffer)));
        }
        DragFinish(hdrop);
        if decoded_paths != paths {
            return Err(format!(
                "CF_HDROP path mismatch: expected {} files, got {}",
                paths.len(),
                decoded_paths.len()
            ));
        }

        Ok(vec![
            format!(
                "Windows CF_HDROP payload was created for {} file(s)",
                paths.len()
            ),
            format!(
                "Shell readback path: {}",
                decoded_paths
                    .first()
                    .map(|path| path.display().to_string())
                    .unwrap_or_default()
            ),
        ])
    }
}

#[cfg(not(target_os = "windows"))]
fn validate_native_file_drag_payload(_paths: &[PathBuf]) -> Result<Vec<String>, String> {
    Err("native file drag diagnostics are only implemented on Windows".to_string())
}

#[cfg(target_os = "windows")]
fn drag_files_from_current_sta(paths: Vec<PathBuf>) -> Result<String, String> {
    use windows::core::implement;
    use windows::Win32::Foundation::{
        DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, DV_E_FORMATETC,
        E_NOTIMPL, OLE_E_ADVISENOTSUPPORTED, S_FALSE, S_OK,
    };
    use windows::Win32::System::Com::{
        IAdviseSink, IDataObject, IDataObject_Impl, IEnumFORMATETC, IEnumSTATDATA, DATADIR_GET,
        FORMATETC, STGMEDIUM, STGMEDIUM_0, TYMED_HGLOBAL,
    };
    use windows::Win32::System::Ole::{
        DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize, DROPEFFECT,
        DROPEFFECT_COPY, DROPEFFECT_NONE,
    };
    use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
    use windows::Win32::UI::Shell::SHCreateStdEnumFmtEtc;

    if paths.is_empty() || paths.iter().any(|path| !path.is_file()) {
        return Err("drag file was not created".to_string());
    }

    #[implement(IDataObject)]
    struct FileDataObject {
        paths: Vec<PathBuf>,
    }

    #[implement(IDropSource)]
    struct FileDropSource;

    impl IDropSource_Impl for FileDropSource_Impl {
        fn QueryContinueDrag(
            &self,
            escape_pressed: windows_core::BOOL,
            key_state: MODIFIERKEYS_FLAGS,
        ) -> windows_core::HRESULT {
            if escape_pressed.as_bool() {
                return DRAGDROP_S_CANCEL;
            }
            if !key_state.contains(MK_LBUTTON) {
                return DRAGDROP_S_DROP;
            }
            S_OK
        }

        fn GiveFeedback(&self, _effect: DROPEFFECT) -> windows_core::HRESULT {
            DRAGDROP_S_USEDEFAULTCURSORS
        }
    }

    impl IDataObject_Impl for FileDataObject_Impl {
        fn GetData(&self, format: *const FORMATETC) -> windows_core::Result<STGMEDIUM> {
            unsafe {
                if query_format(format) != S_OK {
                    return Err(windows_core::Error::from_hresult(DV_E_FORMATETC));
                }
                let hglobal = hdrop_for_paths(&self.paths)?;
                Ok(STGMEDIUM {
                    tymed: TYMED_HGLOBAL.0 as u32,
                    u: STGMEDIUM_0 { hGlobal: hglobal },
                    pUnkForRelease: std::mem::ManuallyDrop::new(None),
                })
            }
        }

        fn GetDataHere(
            &self,
            _format: *const FORMATETC,
            _medium: *mut STGMEDIUM,
        ) -> windows_core::Result<()> {
            Err(windows_core::Error::from_hresult(E_NOTIMPL))
        }

        fn QueryGetData(&self, format: *const FORMATETC) -> windows_core::HRESULT {
            unsafe { query_format(format) }
        }

        fn GetCanonicalFormatEtc(
            &self,
            _input: *const FORMATETC,
            output: *mut FORMATETC,
        ) -> windows_core::HRESULT {
            unsafe {
                if !output.is_null() {
                    (*output).ptd = std::ptr::null_mut();
                }
            }
            E_NOTIMPL
        }

        fn SetData(
            &self,
            _format: *const FORMATETC,
            _medium: *const STGMEDIUM,
            _release: windows_core::BOOL,
        ) -> windows_core::Result<()> {
            Err(windows_core::Error::from_hresult(E_NOTIMPL))
        }

        fn EnumFormatEtc(&self, direction: u32) -> windows_core::Result<IEnumFORMATETC> {
            if direction != DATADIR_GET.0 as u32 {
                return Err(windows_core::Error::from_hresult(E_NOTIMPL));
            }
            unsafe { SHCreateStdEnumFmtEtc(&[hdrop_format()]) }
        }

        fn DAdvise(
            &self,
            _format: *const FORMATETC,
            _advf: u32,
            _sink: windows_core::Ref<'_, IAdviseSink>,
        ) -> windows_core::Result<u32> {
            Err(windows_core::Error::from_hresult(OLE_E_ADVISENOTSUPPORTED))
        }

        fn DUnadvise(&self, _connection: u32) -> windows_core::Result<()> {
            Err(windows_core::Error::from_hresult(OLE_E_ADVISENOTSUPPORTED))
        }

        fn EnumDAdvise(&self) -> windows_core::Result<IEnumSTATDATA> {
            Err(windows_core::Error::from_hresult(OLE_E_ADVISENOTSUPPORTED))
        }
    }

    unsafe {
        let ole_init = OleInitialize(None);
        let should_uninitialize = match ole_init {
            Ok(()) => true,
            Err(error) if error.code() == S_FALSE => false,
            Err(error) => return Err(format!("OleInitialize failed: {}", error.message())),
        };
        let data_object: IDataObject = FileDataObject { paths }.into();
        let drop_source: IDropSource = FileDropSource.into();
        let mut effect = DROPEFFECT_NONE;
        let result = DoDragDrop(&data_object, &drop_source, DROPEFFECT_COPY, &mut effect)
            .map(|| {
                if effect == DROPEFFECT_COPY {
                    "copy".to_string()
                } else {
                    "none".to_string()
                }
            })
            .map_err(|error| error.message().to_string());
        if should_uninitialize {
            OleUninitialize();
        }
        result
    }
}

#[cfg(target_os = "windows")]
fn hdrop_format() -> windows::Win32::System::Com::FORMATETC {
    use windows::Win32::System::Com::{DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
    use windows::Win32::System::Ole::CF_HDROP;

    FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    }
}

#[cfg(target_os = "windows")]
unsafe fn query_format(
    format: *const windows::Win32::System::Com::FORMATETC,
) -> windows_core::HRESULT {
    use windows::Win32::Foundation::{DV_E_FORMATETC, DV_E_TYMED, S_OK};
    use windows::Win32::System::Com::{DVASPECT_CONTENT, TYMED_HGLOBAL};
    use windows::Win32::System::Ole::CF_HDROP;

    if format.is_null() {
        return DV_E_FORMATETC;
    }
    let format = &*format;
    if format.cfFormat != CF_HDROP.0 || format.dwAspect != DVASPECT_CONTENT.0 {
        return DV_E_FORMATETC;
    }
    if format.tymed & TYMED_HGLOBAL.0 as u32 == 0 {
        return DV_E_TYMED;
    }
    S_OK
}

#[cfg(target_os = "windows")]
unsafe fn hdrop_for_paths(
    paths: &[PathBuf],
) -> windows_core::Result<windows::Win32::Foundation::HGLOBAL> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::UI::Shell::DROPFILES;

    let mut wide_paths = Vec::<u16>::new();
    for path in paths {
        wide_paths.extend(path.as_os_str().encode_wide());
        wide_paths.push(0);
    }
    wide_paths.push(0);

    let header_size = std::mem::size_of::<DROPFILES>();
    let bytes_size = wide_paths.len() * std::mem::size_of::<u16>();
    let total_size = header_size + bytes_size;
    let hglobal = GlobalAlloc(GMEM_MOVEABLE, total_size)?;
    let locked = GlobalLock(hglobal);
    if locked.is_null() {
        return Err(windows_core::Error::from_win32());
    }

    let dropfiles = DROPFILES {
        pFiles: header_size as u32,
        pt: POINT { x: 0, y: 0 },
        fNC: windows_core::BOOL(0),
        fWide: windows_core::BOOL(1),
    };
    std::ptr::copy_nonoverlapping(
        &dropfiles as *const DROPFILES as *const u8,
        locked as *mut u8,
        header_size,
    );
    std::ptr::copy_nonoverlapping(
        wide_paths.as_ptr() as *const u8,
        (locked as *mut u8).add(header_size),
        bytes_size,
    );
    let _ = GlobalUnlock(hglobal);
    Ok(hglobal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn validation_rejects_missing_file() {
        let missing = std::env::temp_dir().join("sonilabs_missing_native_drag_file.wav");
        let error = validate_file_path(&missing.to_string_lossy()).expect_err("reject missing");

        assert!(!error.is_empty());
    }

    #[test]
    fn validation_rejects_directories() {
        let error = validate_file_path(&std::env::temp_dir().to_string_lossy())
            .expect_err("reject directory");

        assert!(error.contains("not a directory"));
    }

    #[test]
    fn validation_accepts_existing_file() {
        let path = std::env::temp_dir().join(format!(
            "sonilabs_native_drag_validation_{}.tmp",
            std::process::id()
        ));
        fs::write(&path, b"drag").expect("write temp file");

        let validated = validate_file_path(&path.to_string_lossy()).expect("validate file");

        assert!(validated.is_file());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn request_accepts_multiple_existing_files() {
        let first = std::env::temp_dir().join(format!(
            "sonilabs_native_drag_multi_first_{}.tmp",
            std::process::id()
        ));
        let second = std::env::temp_dir().join(format!(
            "sonilabs_native_drag_multi_second_{}.tmp",
            std::process::id()
        ));
        fs::write(&first, b"drag").expect("write first temp file");
        fs::write(&second, b"drag").expect("write second temp file");

        let paths = validate_request_file_paths(&StartNativeFileDragRequest {
            file_path: first.to_string_lossy().to_string(),
            file_paths: Some(vec![
                first.to_string_lossy().to_string(),
                second.to_string_lossy().to_string(),
            ]),
            icon_path: None,
            display_name: None,
            allowed_effect: "copy".to_string(),
        })
        .expect("validate multi-file request");

        assert_eq!(paths.len(), 2);
        let _ = fs::remove_file(first);
        let _ = fs::remove_file(second);
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn validation_returns_shell_compatible_windows_path() {
        let path = std::env::temp_dir().join(format!(
            "sonilabs_native_drag_shell_path_{}.tmp",
            std::process::id()
        ));
        fs::write(&path, b"drag").expect("write temp file");

        let validated = validate_file_path(&path.to_string_lossy()).expect("validate file");

        assert!(!validated.to_string_lossy().starts_with(r"\\?\"));
        let _ = fs::remove_file(path);
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn diagnostic_validates_hdrop_shell_readback() {
        let path = std::env::temp_dir().join(format!(
            "sonilabs_native_drag_hdrop_{}.tmp",
            std::process::id()
        ));
        fs::write(&path, b"drag").expect("write temp file");

        let response = diagnose_native_file_drag_payload(StartNativeFileDragRequest {
            file_path: path.to_string_lossy().to_string(),
            file_paths: None,
            icon_path: None,
            display_name: None,
            allowed_effect: "copy".to_string(),
        });

        assert!(response.ok, "{response:?}");
        assert_eq!(response.effect, "copy");
        assert!(response
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.contains("CF_HDROP payload")));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn request_rejects_non_copy_effect() {
        let response = start_native_file_drag(StartNativeFileDragRequest {
            file_path: "ignored".to_string(),
            file_paths: None,
            icon_path: None,
            display_name: None,
            allowed_effect: "move".to_string(),
        });

        assert!(!response.ok);
        assert_eq!(response.effect, "none");
        assert_eq!(
            response.error.as_deref(),
            Some("allowedEffect must be copy")
        );
    }
}
