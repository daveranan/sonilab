import {
  Bug,
  Clipboard,
  Database,
  Download,
  FolderPlus,
  HardDrive,
  RefreshCw,
  Settings,
  ShieldCheck,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import type React from "react";

import { Button } from "@/components/ui/button";
import { shortcutHelpItems } from "@/features/app/commandRegistry";
import {
  cacheManagementSummary,
  checkInstallAndRelaunchUpdate,
  enforceCacheLimit,
  licenseAttributionReport,
  openLocalPath,
  updateFlowStatus,
  type CacheManagementSummary,
  type LicenseAttributionRow,
  type UpdateFlowStatus,
} from "@/features/audio-preview/commands";
import { audioPreviewService } from "@/features/audio-preview/previewService";
import { getBufferedLogEvents } from "@/lib/logger";

type LocalSourceRecord = {
  id: string;
  displayName: string;
  rootUri: string;
  status: string;
};

type SettingsPanelProps = {
  activeTab: SettingsPanelTab;
  localSources: LocalSourceRecord[];
  open: boolean;
  onAddLocalFolder: () => void;
  onTabChange: (tab: SettingsPanelTab) => void;
  onClose: () => void;
  onDeleteSource: (sourceId: string) => void;
  onRefreshSources: () => void;
  onReindexSource: (sourceId: string) => void;
};

export type SettingsPanelTab = "main" | "diagnostics" | "shortcuts";

type ExportDefaults = {
  format: string;
  filenamePattern: string;
  overwriteMode: "skip" | "replace" | "rename";
  preserveFolders: boolean;
  includeSidecar: boolean;
};

type StoredProductionPolishSettings = {
  audioDeviceId?: string;
  cacheLimitMb?: number;
  exportDefaults?: Partial<ExportDefaults>;
};

type AppPaths = {
  config_dir?: string;
  configDir?: string;
  data_dir?: string;
  dataDir?: string;
  cache_dir?: string;
  cacheDir?: string;
  log_dir?: string;
  logDir?: string;
};

type LogExport = {
  path: string;
  bytes: number;
};

const settingsStorageKey = "sonilabs.productionPolishSettings";
const defaultExportDefaults: ExportDefaults = {
  format: "WAV",
  filenamePattern: "{name}_processed",
  overwriteMode: "rename",
  preserveFolders: false,
  includeSidecar: false,
};
const denseInputClass =
  "h-7 rounded-md border border-input bg-black px-2 text-[11px] text-foreground outline-none focus-visible:border-primary";

export function SettingsPanel({
  activeTab,
  localSources,
  open,
  onAddLocalFolder,
  onTabChange,
  onClose,
  onDeleteSource,
  onRefreshSources,
  onReindexSource,
}: SettingsPanelProps) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const storedSettings = useMemo(() => readStoredSettings(), []);
  const [deviceId, setDeviceId] = useState(storedSettings.audioDeviceId ?? "");
  const [deviceStatus, setDeviceStatus] = useState<string | null>(null);
  const [cacheLimitMb, setCacheLimitMb] = useState(
    clampCacheLimitMb(storedSettings.cacheLimitMb ?? 2048),
  );
  const [cacheSummary, setCacheSummary] = useState<CacheManagementSummary | null>(null);
  const [cacheStatus, setCacheStatus] = useState<string | null>(null);
  const [reportRows, setReportRows] = useState<LicenseAttributionRow[]>([]);
  const [updateStatus, setUpdateStatus] = useState<UpdateFlowStatus | null>(null);
  const [updateActionStatus, setUpdateActionStatus] = useState<string | null>(null);
  const [appPaths, setAppPaths] = useState<AppPaths | null>(null);
  const [logExport, setLogExport] = useState<LogExport | null>(null);
  const [diagnosticsStatus, setDiagnosticsStatus] = useState<string | null>(null);
  const [exportDefaults, setExportDefaults] = useState<ExportDefaults>(() =>
    readExportDefaults(storedSettings),
  );

  const refreshCache = useCallback(() => {
    void cacheManagementSummary()
      .then(setCacheSummary)
      .catch((error: unknown) =>
        setCacheStatus(error instanceof Error ? error.message : "Cache scan failed."),
      );
  }, []);

  useEffect(() => {
    if (!open) return;
    refreshCache();
    void licenseAttributionReport(250)
      .then(setReportRows)
      .catch(() => setReportRows([]));
    void updateFlowStatus()
      .then(setUpdateStatus)
      .catch(() => setUpdateStatus(null));
    void refreshDiagnostics(setAppPaths, setLogExport, setDiagnosticsStatus);
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((items) => setDevices(items.filter((item) => item.kind === "audiooutput")))
      .catch(() => setDevices([]));
  }, [open, refreshCache]);

  useEffect(() => {
    window.localStorage.setItem(
      settingsStorageKey,
      JSON.stringify({ audioDeviceId: deviceId, cacheLimitMb, exportDefaults }),
    );
    window.dispatchEvent(
      new CustomEvent("sonilabs:export-defaults-changed", {
        detail: exportDefaults,
      }),
    );
  }, [cacheLimitMb, deviceId, exportDefaults]);

  useEffect(() => {
    if (!deviceId) return;
    void audioPreviewService.setOutputDevice(deviceId).catch(() => undefined);
  }, [deviceId]);

  const cacheRows = cacheSummary?.byKind ?? [];
  const totalCache = formatBytes(cacheSummary?.totalBytes ?? 0);
  const diskCache = formatBytes(cacheSummary?.diskBytes ?? 0);
  const knownReportRows = useMemo(
    () =>
      reportRows.filter(
        (row) => row.license || row.attribution || row.originator || row.tags.length,
      ),
    [reportRows],
  );
  const handleUpdateCheck = useCallback(() => {
    setUpdateActionStatus("Checking for updates...");
    void checkInstallAndRelaunchUpdate(setUpdateActionStatus).catch((error: unknown) =>
      setUpdateActionStatus(
        error instanceof Error ? error.message : "Update check failed.",
      ),
    );
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 p-4">
      <section className="mx-auto grid h-full max-w-[1180px] grid-rows-[40px_minmax(0,1fr)] overflow-hidden border border-border bg-background shadow-2xl">
        <header className="flex items-center justify-between border-b border-border bg-panel px-3">
          <div className="flex items-center gap-2 text-[12px] font-semibold">
            <Settings className="size-4" />
            Settings
          </div>
          <Button className="size-8 p-0" onClick={onClose} size="icon" variant="ghost">
            <X className="size-4" />
          </Button>
        </header>
        <div className="grid min-h-0 grid-cols-[240px_minmax(0,1fr)] overflow-hidden">
          <nav className="border-r border-border bg-sidebar p-2 text-[11px] text-muted-foreground">
            <NavLink
              active={activeTab === "main"}
              label="Main Settings"
              onClick={() => onTabChange("main")}
            />
            <NavLink
              active={activeTab === "shortcuts"}
              label="Shortcuts"
              onClick={() => onTabChange("shortcuts")}
            />
            <NavLink
              active={activeTab === "diagnostics"}
              label="Diagnostics"
              onClick={() => onTabChange("diagnostics")}
            />
          </nav>
          <div className="min-h-0 overflow-auto p-3">
            {activeTab === "main" ? (
              <>
                <PanelSection icon={<HardDrive />} title="Local Sources">
                  <div className="mb-2 flex gap-2">
                    <Button
                      className="h-8 gap-1.5"
                      onClick={onAddLocalFolder}
                      size="sm"
                    >
                      <FolderPlus className="size-3.5" />
                      Add Local Folder
                    </Button>
                    <Button
                      className="h-8 gap-1.5"
                      onClick={onRefreshSources}
                      size="sm"
                      variant="secondary"
                    >
                      <RefreshCw className="size-3.5" />
                      Refresh
                    </Button>
                  </div>
                  <div className="overflow-hidden border border-border">
                    {localSources.length === 0 ? (
                      <div className="px-2 py-3 text-[12px] text-muted-foreground">
                        No local folders are connected.
                      </div>
                    ) : (
                      localSources.map((source) => (
                        <div
                          className="grid grid-cols-[minmax(0,1fr)_72px_76px_32px] items-center gap-2 border-b border-border/70 px-2 py-1.5 text-[11px] last:border-b-0"
                          key={source.id}
                        >
                          <div className="min-w-0">
                            <div className="truncate text-foreground">
                              {source.displayName}
                            </div>
                            <div className="truncate font-mono text-muted-foreground">
                              {source.rootUri}
                            </div>
                          </div>
                          <span className="text-muted-foreground">{source.status}</span>
                          <Button
                            className="h-7 px-2 text-[11px]"
                            onClick={() => onReindexSource(source.id)}
                            size="sm"
                            variant="secondary"
                          >
                            Reindex
                          </Button>
                          <Button
                            className="size-7 p-0"
                            onClick={() => onDeleteSource(source.id)}
                            size="icon"
                            title="Remove source from index"
                            variant="ghost"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      ))
                    )}
                  </div>
                </PanelSection>

                <PanelSection icon={<Volume2 />} title="Audio Devices">
                  <div className="grid grid-cols-[150px_minmax(0,1fr)_120px] items-center gap-2 text-[11px]">
                    <span className="text-muted-foreground">Output device</span>
                    <select
                      className={denseInputClass}
                      onChange={(event) => setDeviceId(event.target.value)}
                      value={deviceId}
                    >
                      <option value="">System default</option>
                      {devices.map((device) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.label ||
                            `Audio output ${device.deviceId.slice(0, 6)}`}
                        </option>
                      ))}
                    </select>
                    <Button
                      className="h-7 text-[11px]"
                      onClick={() => {
                        void audioPreviewService
                          .setOutputDevice(deviceId || null)
                          .then((applied) =>
                            setDeviceStatus(
                              applied
                                ? "Output device applied."
                                : "Device selection saved; this WebView does not expose sink routing.",
                            ),
                          )
                          .catch((error: unknown) =>
                            setDeviceStatus(
                              error instanceof Error
                                ? error.message
                                : "Device switch failed.",
                            ),
                          );
                      }}
                      size="sm"
                    >
                      Apply
                    </Button>
                  </div>
                  {deviceStatus ? (
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      {deviceStatus}
                    </div>
                  ) : null}
                </PanelSection>

                <PanelSection icon={<Database />} title="Cache">
                  <div className="mb-2 grid grid-cols-[140px_90px_90px_minmax(0,1fr)_96px] items-center gap-2 text-[11px]">
                    <span className="text-muted-foreground">Limit MB</span>
                    <input
                      className={denseInputClass}
                      min={256}
                      onChange={(event) => setCacheLimitMb(Number(event.target.value))}
                      type="number"
                      value={cacheLimitMb}
                    />
                    <Button
                      className="h-7 text-[11px]"
                      onClick={() => {
                        void enforceCacheLimit(cacheLimitMb * 1024 * 1024)
                          .then((report) => {
                            setCacheStatus(
                              report
                                ? `Removed ${report.removedEntries}; ${formatBytes(
                                    report.afterBytes,
                                  )} remains.`
                                : "Cache enforcement requires Tauri.",
                            );
                            refreshCache();
                          })
                          .catch((error: unknown) =>
                            setCacheStatus(
                              error instanceof Error
                                ? error.message
                                : "Cache cleanup failed.",
                            ),
                          );
                      }}
                      size="sm"
                    >
                      Enforce
                    </Button>
                    <span className="truncate text-muted-foreground">
                      DB {totalCache} / disk {diskCache}
                    </span>
                    <Button
                      className="h-7 text-[11px]"
                      onClick={refreshCache}
                      size="sm"
                      variant="secondary"
                    >
                      Refresh
                    </Button>
                  </div>
                  <div className="grid grid-cols-4 border border-border text-[11px]">
                    {cacheRows.map((row) => (
                      <div
                        className="border-r border-border p-2 last:border-r-0"
                        key={row.kind}
                      >
                        <div className="font-medium text-foreground">{row.kind}</div>
                        <div className="text-muted-foreground">
                          {row.entries} entries / {formatBytes(row.bytes)}
                        </div>
                      </div>
                    ))}
                  </div>
                  {cacheStatus ? (
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      {cacheStatus}
                    </div>
                  ) : null}
                </PanelSection>

                <PanelSection icon={<Download />} title="Export Defaults">
                  <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-2 text-[11px]">
                    <Label>Format</Label>
                    <select
                      className={denseInputClass}
                      onChange={(event) =>
                        setExportDefaults((current) => ({
                          ...current,
                          format: event.target.value,
                        }))
                      }
                      value={exportDefaults.format}
                    >
                      {["WAV", "MP3", "OGG", "FLAC", "AAC", "M4A", "MP4"].map(
                        (format) => (
                          <option key={format}>{format}</option>
                        ),
                      )}
                    </select>
                    <Label>Filename pattern</Label>
                    <input
                      className={denseInputClass}
                      onChange={(event) =>
                        setExportDefaults((current) => ({
                          ...current,
                          filenamePattern: event.target.value,
                        }))
                      }
                      value={exportDefaults.filenamePattern}
                    />
                    <Label>Overwrite</Label>
                    <select
                      className={denseInputClass}
                      onChange={(event) =>
                        setExportDefaults((current) => ({
                          ...current,
                          overwriteMode: event.target
                            .value as ExportDefaults["overwriteMode"],
                        }))
                      }
                      value={exportDefaults.overwriteMode}
                    >
                      <option value="rename">Rename</option>
                      <option value="skip">Skip</option>
                      <option value="replace">Replace</option>
                    </select>
                    <Label>Sidecars</Label>
                    <div className="flex gap-5">
                      <Toggle
                        checked={exportDefaults.preserveFolders}
                        label="Preserve folders"
                        onChange={(checked) =>
                          setExportDefaults((current) => ({
                            ...current,
                            preserveFolders: checked,
                          }))
                        }
                      />
                      <Toggle
                        checked={exportDefaults.includeSidecar}
                        label="License sidecar"
                        onChange={(checked) =>
                          setExportDefaults((current) => ({
                            ...current,
                            includeSidecar: checked,
                          }))
                        }
                      />
                    </div>
                  </div>
                </PanelSection>

                <PanelSection icon={<ShieldCheck />} title="License / Attribution">
                  <div className="mb-2 text-[11px] text-muted-foreground">
                    Local/imported metadata rows with available license, author, or tag
                    data:
                    {knownReportRows.length}
                  </div>
                  <div className="max-h-72 overflow-auto border border-border text-[11px]">
                    {knownReportRows.slice(0, 100).map((row) => (
                      <div
                        className="grid grid-cols-[minmax(0,1.1fr)_90px_minmax(0,1fr)_minmax(0,1fr)] gap-2 border-b border-border/70 px-2 py-1.5 last:border-b-0"
                        key={row.assetId}
                      >
                        <span className="truncate text-foreground" title={row.path}>
                          {row.name}
                        </span>
                        <span className="truncate text-muted-foreground">
                          {row.license ?? "unknown"}
                        </span>
                        <span className="truncate text-muted-foreground">
                          {row.attribution ?? row.originator ?? "--"}
                        </span>
                        <span className="truncate text-muted-foreground">
                          {row.tags.join(", ") || row.sourceName}
                        </span>
                      </div>
                    ))}
                  </div>
                </PanelSection>

                <PanelSection icon={<RefreshCw />} title="Updates">
                  <div className="grid grid-cols-[180px_minmax(0,1fr)] gap-2 text-[11px]">
                    <Label>Version</Label>
                    <span>{updateStatus?.currentVersion ?? "0.1.0"}</span>
                    <Label>Channel</Label>
                    <span>{updateStatus?.channel ?? "stable"}</span>
                    <Label>Endpoint</Label>
                    <span>
                      {updateStatus?.endpointConfigured
                        ? "configured"
                        : "not configured"}
                    </span>
                    <Label>Updater signing key</Label>
                    <span>
                      {updateStatus?.signingPublicKeyConfigured
                        ? "configured"
                        : "not configured"}
                    </span>
                  </div>
                  <div className="mt-2 text-[11px] text-muted-foreground">
                    {updateActionStatus ??
                      updateStatus?.message ??
                      "Update checks are signing-ready, but no update endpoint is configured."}
                  </div>
                  <div className="mt-3 flex justify-end">
                    <Button
                      className="h-8 gap-2"
                      onClick={handleUpdateCheck}
                      title="Check for updates"
                      variant="secondary"
                    >
                      <Download className="size-4" />
                      Check updates
                    </Button>
                  </div>
                </PanelSection>
              </>
            ) : activeTab === "diagnostics" ? (
              <DiagnosticsPanel
                appPaths={appPaths}
                diagnosticsStatus={diagnosticsStatus}
                localSources={localSources}
                logExport={logExport}
                onRefresh={() =>
                  void refreshDiagnostics(
                    setAppPaths,
                    setLogExport,
                    setDiagnosticsStatus,
                  )
                }
                onStatus={setDiagnosticsStatus}
                updateStatus={updateStatus}
              />
            ) : (
              <ShortcutsPanel />
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function readStoredSettings(): StoredProductionPolishSettings {
  try {
    const raw = window.localStorage.getItem(settingsStorageKey);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function readExportDefaults(settings: StoredProductionPolishSettings): ExportDefaults {
  return { ...defaultExportDefaults, ...settings.exportDefaults };
}

async function refreshDiagnostics(
  setAppPaths: (paths: AppPaths | null) => void,
  setLogExport: (log: LogExport | null) => void,
  setStatus: (status: string | null) => void,
): Promise<void> {
  try {
    const [paths, logs] = await Promise.all([
      invoke<AppPaths>("app_paths"),
      invoke<LogExport>("export_local_logs"),
    ]);
    setAppPaths(paths);
    setLogExport(logs);
    setStatus("Diagnostics refreshed.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Diagnostics unavailable.");
  }
}

function clampCacheLimitMb(value: number): number {
  if (!Number.isFinite(value)) return 2048;
  return Math.max(256, Math.min(1_048_576, Math.round(value)));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function NavLink({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`mb-1 h-8 w-full rounded-sm px-2 text-left ${
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function ShortcutsPanel() {
  const groups = ["Browse", "Tabs", "Preview", "Waveform"] as const;

  return (
    <div className="grid gap-3">
      {groups.map((group) => (
        <PanelSection icon={<Settings />} key={group} title={group}>
          <div className="grid max-w-[620px] grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-[12px]">
            {shortcutHelpItems
              .filter((item) => item.group === group)
              .map((item) => (
                <div className="contents" key={item.command}>
                  <span className="truncate text-muted-foreground">{item.label}</span>
                  <kbd className="font-mono text-foreground">{item.shortcut}</kbd>
                </div>
              ))}
          </div>
        </PanelSection>
      ))}
    </div>
  );
}

function DiagnosticsPanel({
  appPaths,
  diagnosticsStatus,
  localSources,
  logExport,
  onRefresh,
  onStatus,
  updateStatus,
}: {
  appPaths: AppPaths | null;
  diagnosticsStatus: string | null;
  localSources: LocalSourceRecord[];
  logExport: LogExport | null;
  onRefresh: () => void;
  onStatus: (status: string | null) => void;
  updateStatus: UpdateFlowStatus | null;
}) {
  const recentEvents = getBufferedLogEvents().slice(-20);
  const latestError = [...recentEvents]
    .reverse()
    .find((event) => event.level === "error");
  const latestCode =
    latestError?.context && "code" in latestError.context
      ? String(latestError.context.code)
      : "--";
  const logDir = appPaths?.log_dir ?? appPaths?.logDir ?? "";
  const dataDir = appPaths?.data_dir ?? appPaths?.dataDir ?? "";
  const cacheDir = appPaths?.cache_dir ?? appPaths?.cacheDir ?? "";

  const copyReport = () => {
    const report = buildDiagnosticsReport({
      appPaths,
      latestCode,
      localSources,
      logExport,
      recentEvents,
      updateStatus,
    });
    void navigator.clipboard
      .writeText(report)
      .then(() => onStatus(`Copied diagnostics report. Latest code: ${latestCode}`))
      .catch((error: unknown) =>
        onStatus(error instanceof Error ? error.message : "Copy failed."),
      );
  };
  const openDiagnosticsPath = (path: string, label: string) => {
    void openLocalPath(path)
      .then(() => onStatus(`Opened ${label}.`))
      .catch((error: unknown) =>
        onStatus(error instanceof Error ? error.message : `Open ${label} failed.`),
      );
  };

  return (
    <div className="grid gap-3">
      <PanelSection icon={<Bug />} title="Diagnostics">
        <div className="mb-2 flex flex-wrap gap-2">
          <Button className="h-8 gap-1.5" onClick={copyReport} size="sm">
            <Clipboard className="size-3.5" />
            Copy Report
          </Button>
          <Button className="h-8" onClick={onRefresh} size="sm" variant="secondary">
            Refresh
          </Button>
          <Button
            className="h-8"
            disabled={!logExport?.path}
            onClick={() =>
              logExport?.path && openDiagnosticsPath(logExport.path, "log")
            }
            size="sm"
            variant="secondary"
          >
            Open Log
          </Button>
          <Button
            className="h-8"
            disabled={!logDir}
            onClick={() => logDir && openDiagnosticsPath(logDir, "log folder")}
            size="sm"
            variant="secondary"
          >
            Open Log Folder
          </Button>
        </div>
        <div className="grid grid-cols-[150px_minmax(0,1fr)] gap-2 text-[11px]">
          <Label>Latest error code</Label>
          <span className="font-mono">{latestCode}</span>
          <Label>Log file</Label>
          <span className="truncate font-mono" title={logExport?.path ?? ""}>
            {logExport?.path ?? "--"}
          </span>
          <Label>Log size</Label>
          <span>{formatBytes(logExport?.bytes ?? 0)}</span>
          <Label>Data dir</Label>
          <span className="truncate font-mono" title={dataDir}>
            {dataDir || "--"}
          </span>
          <Label>Cache dir</Label>
          <span className="truncate font-mono" title={cacheDir}>
            {cacheDir || "--"}
          </span>
        </div>
        {diagnosticsStatus ? (
          <div className="mt-2 text-[11px] text-muted-foreground">
            {diagnosticsStatus}
          </div>
        ) : null}
      </PanelSection>

      <PanelSection icon={<Database />} title="Recent Events">
        <div className="max-h-80 overflow-auto border border-border text-[11px]">
          {recentEvents.length === 0 ? (
            <div className="px-2 py-3 text-muted-foreground">No buffered events.</div>
          ) : (
            recentEvents
              .slice()
              .reverse()
              .map((event) => (
                <div
                  className="grid grid-cols-[70px_170px_minmax(0,1fr)] gap-2 border-b border-border/70 px-2 py-1.5 last:border-b-0"
                  key={`${event.timestamp}-${event.scope}-${event.message}`}
                >
                  <span className="uppercase text-muted-foreground">{event.level}</span>
                  <span className="truncate font-mono text-muted-foreground">
                    {event.scope}
                  </span>
                  <span className="truncate text-foreground" title={event.message}>
                    {event.message}
                  </span>
                </div>
              ))
          )}
        </div>
      </PanelSection>
    </div>
  );
}

function buildDiagnosticsReport(input: {
  appPaths: AppPaths | null;
  latestCode: string;
  localSources: LocalSourceRecord[];
  logExport: LogExport | null;
  recentEvents: ReturnType<typeof getBufferedLogEvents>;
  updateStatus: UpdateFlowStatus | null;
}): string {
  return `${JSON.stringify(
    {
      app: "Sonilabs",
      generatedAt: new Date().toISOString(),
      latestErrorCode: input.latestCode,
      version: input.updateStatus?.currentVersion ?? "0.1.0",
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      paths: input.appPaths,
      log: input.logExport,
      sources: input.localSources.map((source) => ({
        id: source.id,
        name: source.displayName,
        status: source.status,
        rootUri: source.rootUri,
      })),
      recentEvents: input.recentEvents,
    },
    null,
    2,
  )}\n`;
}

function PanelSection({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-3 border-b border-border pb-3">
      <h2 className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase text-foreground">
        <span className="[&_svg]:size-3.5">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="self-center text-muted-foreground">{children}</span>;
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-muted-foreground">
      <input
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      {label}
    </label>
  );
}
