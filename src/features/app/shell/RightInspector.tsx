import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  assetUserMetadata,
  updateAssetUserMetadata,
  type AssetUserMetadata,
} from "@/features/audio-preview/commands";
import { audioPreviewService } from "@/features/audio-preview/previewService";
import {
  canonicalProcessingChain,
  createProcessingChain,
} from "@/features/audio-preview/processingChain";
import type { ProcessingSettings } from "@/features/audio-preview/types";
import type { BrowseRow } from "@/features/browsing/browseTypes";
import {
  canonicalizeTag,
  categorySummaryForTags,
} from "@/features/browsing/tagCategories";
import { formatAudioTimeParts } from "@/lib/timeFormat";

type RightInspectorProps = {
  activeAsset: Extract<BrowseRow, { kind: "asset" }> | null;
  onMetadataChanged?: () => void;
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

export function RightInspector({
  activeAsset,
  onClose,
  onMetadataChanged,
}: RightInspectorProps) {
  const [processing, setProcessing] = useState<ProcessingSettings>(
    audioPreviewService.getProcessing(),
  );
  const [metadata, setMetadata] = useState<AssetUserMetadata | null>(null);
  const [tagInput, setTagInput] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const chain = useMemo(
    () =>
      createProcessingChain({
        gainDb: processing.gainDb,
        eq: processing.eq,
        pitchSemitones: processing.pitchSemitones,
        reversed: processing.reversed,
      }),
    [
      processing.eq,
      processing.gainDb,
      processing.pitchSemitones,
      processing.reversed,
    ],
  );
  const categorySummary = useMemo(
    () => (activeAsset ? categorySummaryForTags(activeAsset.tags) : ""),
    [activeAsset],
  );

  useEffect(() => audioPreviewService.subscribeProcessing(setProcessing), []);
  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setSaveStatus(null);
      setTagInput("");
    });
    if (!activeAsset) {
      queueMicrotask(() => {
        if (cancelled) return;
        setMetadata(null);
        setCommentDraft("");
      });
      return () => {
        cancelled = true;
      };
    }
    void assetUserMetadata(activeAsset.id)
      .then((next) => {
        if (cancelled) return;
        setMetadata(next);
        setCommentDraft(next.userComment);
      })
      .catch(() => {
        if (!cancelled) {
          setMetadata({ assetId: activeAsset.id, userTags: [], userComment: "" });
          setCommentDraft("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeAsset]);

  const saveUserMetadata = async (
    nextTags = metadata?.userTags ?? [],
    nextComment = commentDraft,
  ) => {
    if (!activeAsset) return;
    setSaveStatus("Saving...");
    try {
      const saved = await updateAssetUserMetadata({
        assetId: activeAsset.id,
        userTags: nextTags,
        userComment: nextComment,
      });
      setMetadata(saved);
      setCommentDraft(saved.userComment);
      setSaveStatus("Saved");
      onMetadataChanged?.();
    } catch (error) {
      setSaveStatus(error instanceof Error ? error.message : "Save failed");
    }
  };

  const addUserTag = () => {
    const nextTag = normalizeUserTagInput(tagInput);
    if (!nextTag || !metadata) return;
    const nextTags = [...new Set([...metadata.userTags, nextTag])].sort();
    setTagInput("");
    void saveUserMetadata(nextTags);
  };

  const removeUserTag = (tag: string) => {
    if (!metadata) return;
    void saveUserMetadata(metadata.userTags.filter((candidate) => candidate !== tag));
  };

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
      <section className="border-b border-border p-3">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-foreground">
          User Metadata
        </div>
        <div className="mb-2 flex flex-wrap gap-1">
          {metadata?.userTags.length ? (
            metadata.userTags.map((tag) => (
              <button
                className="rounded-sm border border-border bg-muted px-1.5 py-0.5 text-[11px] text-foreground hover:border-destructive"
                key={tag}
                onClick={() => removeUserTag(tag)}
                title="Remove user tag"
                type="button"
              >
                {displayUserTag(tag)}
              </button>
            ))
          ) : (
            <span className="text-muted-foreground">No user tags</span>
          )}
        </div>
        <div className="mb-2 flex gap-1">
          <input
            className="h-7 min-w-0 flex-1 rounded-sm border border-input bg-background px-2 text-[12px] outline-none focus-visible:border-primary"
            onChange={(event) => setTagInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addUserTag();
            }}
            placeholder="Add tag"
            value={tagInput}
          />
          <Button className="size-7 p-0" onClick={addUserTag} size="icon">
            <Plus className="size-3.5" />
          </Button>
        </div>
        <textarea
          className="h-24 w-full resize-none rounded-sm border border-input bg-background p-2 text-[12px] text-foreground outline-none focus-visible:border-primary"
          onBlur={() => void saveUserMetadata(undefined, commentDraft)}
          onChange={(event) => setCommentDraft(event.target.value)}
          placeholder="User comments"
          value={commentDraft}
        />
        {saveStatus ? (
          <div className="mt-1 text-[11px] text-muted-foreground">{saveStatus}</div>
        ) : null}
      </section>
      <section className="p-3">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-foreground">
          Processing Chain
        </div>
        <ol className="space-y-1 text-muted-foreground">
          <li>1. Input trim for selected-region export</li>
          <li>2. Reverse {processing.reversed ? "on" : "off"}</li>
          <li>3. Gain {processing.gainDb.toFixed(1)} dB</li>
          <li>
            4. EQ L {processing.eq.lowDb.toFixed(1)} / M{" "}
            {processing.eq.midDb.toFixed(1)} / H {processing.eq.highDb.toFixed(1)} dB
          </li>
          <li>5. Pitch {processing.pitchSemitones.toFixed(1)} st</li>
          <li>6. Export encoding</li>
        </ol>
        <code className="mt-3 block truncate rounded-sm bg-background p-2 text-[10px] text-muted-foreground">
          {canonicalProcessingChain(chain)}
        </code>
      </section>
    </aside>
  );
}

function normalizeUserTagInput(input: string): string {
  const compact = input.trim().replace(/\s+/g, " ");
  const grouped = compact.match(/^(.+?)\s+(?:view\s*)?v?(\d+)$/i);
  if (grouped) {
    const category = canonicalizeTag(grouped[1] ?? "");
    const version = `v${grouped[2]}`;
    if (category) return `${category}:${version}`;
  }
  return canonicalizeTag(compact);
}

function displayUserTag(tag: string): string {
  const [category, label] = tag.split(":", 2);
  return category && label ? `${category} / ${label}` : tag;
}
