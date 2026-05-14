import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { audioPreviewService } from "@/features/audio-preview/previewService";
import {
  canonicalProcessingChain,
  createGainProcessingChain,
} from "@/features/audio-preview/processingChain";
import type { ProcessingSettings } from "@/features/audio-preview/types";
import type { BrowseRow } from "@/features/browsing/browseTypes";
import { categorySummaryForTags } from "@/features/browsing/tagCategories";
import { formatAudioTimeParts } from "@/lib/timeFormat";

type RightInspectorProps = {
  activeAsset: Extract<BrowseRow, { kind: "asset" }> | null;
  onClose: () => void;
};

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[78px_minmax(0,1fr)] gap-2 text-[12px]">
      <span className="text-muted-foreground/85">{label}</span>
      <span className="truncate font-medium text-foreground" title={value}>
        {value}
      </span>
    </div>
  );
}

export function RightInspector({ activeAsset, onClose }: RightInspectorProps) {
  const [processing, setProcessing] = useState<ProcessingSettings>(
    audioPreviewService.getProcessing(),
  );
  const chain = useMemo(
    () => createGainProcessingChain(processing.gainDb),
    [processing.gainDb],
  );
  const categorySummary = useMemo(
    () => (activeAsset ? categorySummaryForTags(activeAsset.tags) : ""),
    [activeAsset],
  );

  useEffect(() => audioPreviewService.subscribeProcessing(setProcessing), []);

  if (!activeAsset) {
    return (
      <aside className="col-start-3 row-start-1 border-l border-border bg-panel p-3 text-[12px] text-muted-foreground">
        <div className="mb-2 flex items-center justify-between">
          <span>Select a sound to inspect.</span>
          <Button
            className="size-7 p-0"
            onClick={onClose}
            size="icon"
            title="Close summary"
            variant="ghost"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="col-start-3 row-start-1 flex min-h-0 flex-col overflow-auto border-l border-border bg-panel text-[12px]">
      <section className="border-b border-border p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
            File Summary
          </span>
          <Button
            className="size-7 p-0"
            onClick={onClose}
            size="icon"
            title="Close summary"
            variant="ghost"
          >
            <X className="size-3.5" />
          </Button>
        </div>
        <div className="space-y-1">
          <InfoRow label="Name" value={activeAsset.name} />
          <InfoRow label="Source" value={activeAsset.sourceName} />
          <InfoRow label="Path" value={activeAsset.relativePath} />
          <InfoRow label="Format" value={activeAsset.format ?? "--"} />
          <InfoRow
            label="Duration"
            value={formatAudioTimeParts(activeAsset.durationSeconds).full}
          />
          <InfoRow label="Rate" value={activeAsset.sampleRate?.toString() ?? "--"} />
          <InfoRow label="Bits" value={activeAsset.bitDepth?.toString() ?? "--"} />
          <InfoRow label="Channels" value={activeAsset.channels?.toString() ?? "--"} />
          <InfoRow label="License" value={activeAsset.license ?? "--"} />
          <InfoRow label="Originator" value={activeAsset.originator ?? "--"} />
          <InfoRow label="Categories" value={categorySummary || "--"} />
          <InfoRow
            label="Tags"
            value={activeAsset.tags.length ? activeAsset.tags.join(", ") : "--"}
          />
        </div>
      </section>
      <section className="p-3">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-foreground">
          Processing Chain
        </div>
        <ol className="space-y-1 text-muted-foreground">
          <li>1. Input trim for selected-region export</li>
          <li>2. Gain {processing.gainDb.toFixed(1)} dB</li>
          <li>3. Export encoding</li>
        </ol>
        <p className="mt-3 text-muted-foreground">
          Normalize, limiter, EQ, and presets are deferred.
        </p>
        <code className="mt-3 block truncate rounded-sm bg-background p-2 text-[10px] text-muted-foreground">
          {canonicalProcessingChain(chain)}
        </code>
      </section>
    </aside>
  );
}
