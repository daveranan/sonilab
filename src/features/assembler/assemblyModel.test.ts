import { describe, expect, it } from "vitest";

import type { BrowseRow } from "@/features/browsing/browseTypes";

import {
  addClipToTrack,
  canPlaceClip,
  createAssemblyProject,
  createClip,
  moveTrack,
  removeClips,
  removeTrack,
  moveClip,
  projectDuration,
  snapTimelineSeconds,
  trimClip,
} from "./assemblyModel";

const asset = {
  kind: "asset",
  id: "asset-impact",
  name: "Impact.wav",
  durationSeconds: 2.5,
  sampleRate: 48_000,
  bitDepth: 24,
  channels: 2,
  format: "wav",
  codec: "pcm",
  fileSizeBytes: 1_000,
  peakDbfs: -1,
  rmsDbfs: -12,
  clipping: false,
  headroomDb: 1,
  sourceName: "Local",
  provider: "local",
  relativePath: "Impact.wav",
  license: null,
  metadataFile: null,
  originator: null,
  attribution: null,
  description: null,
  tags: [],
  rightsSummary: null,
  rating: null,
  imported: true,
  favorite: false,
  availability: "available",
} satisfies Extract<BrowseRow, { kind: "asset" }>;

describe("assembly model", () => {
  it("creates a clip from a selected waveform region", () => {
    const clip = createClip(asset, { startSeconds: 0.4, endSeconds: 1.1 }, 2);
    expect(clip.sourceStartSeconds).toBe(0.4);
    expect(clip.durationSeconds).toBeCloseTo(0.7);
    expect(clip.startSeconds).toBe(2);
  });

  it("snapshots preview processing and uses its rendered duration", () => {
    const clip = createClip(asset, { startSeconds: 0, endSeconds: 2 }, 0, {
      mode: "processed",
      gainDb: 6,
      eq: { enabled: true, lowDb: 2, midDb: -1, highDb: 3 },
      pitchSemitones: 12,
      playbackRate: 1,
      channelMode: "channel:0",
      reversed: false,
    });
    expect(clip.durationSeconds).toBeCloseTo(1);
    expect(clip.processing).toEqual({
      mode: "processed",
      gainDb: 6,
      eq: { enabled: true, lowDb: 2, midDb: -1, highDb: 3 },
      pitchSemitones: 12,
      playbackRate: 1,
      channelMode: "channel:0",
      reversed: false,
    });
  });

  it("moves clips between layers and updates project duration", () => {
    const project = createAssemblyProject();
    const clip = createClip(asset, null, 0);
    const withClip = addClipToTrack(project, project.tracks[0].id, clip);
    const moved = moveClip(withClip, clip.id, project.tracks[1].id, 1.24);
    expect(moved.tracks[0].clips).toHaveLength(0);
    expect(moved.tracks[1].clips[0].startSeconds).toBe(1.25);
    expect(projectDuration(moved)).toBe(3.75);
  });

  it("rejects overlapping clips on the same layer", () => {
    const project = createAssemblyProject();
    const first = createClip(asset, { startSeconds: 0, endSeconds: 1 }, 0);
    const second = createClip(asset, { startSeconds: 1, endSeconds: 2 }, 0.5);
    const withFirst = addClipToTrack(project, project.tracks[0].id, first);
    expect(
      canPlaceClip(
        withFirst,
        second.id,
        project.tracks[0].id,
        second.startSeconds,
        second.durationSeconds,
      ),
    ).toBe(false);
    const rejected = addClipToTrack(withFirst, project.tracks[0].id, second);
    expect(rejected.tracks[0].clips).toHaveLength(1);
  });

  it("snaps negative and fractional timeline positions", () => {
    expect(snapTimelineSeconds(-1)).toBe(0);
    expect(snapTimelineSeconds(1.234)).toBe(1.25);
  });

  it("removes selected clips without dropping layers", () => {
    const project = createAssemblyProject();
    const firstClip = createClip(asset, null, 0);
    const secondClip = createClip(asset, null, 1);
    const withClips = addClipToTrack(
      addClipToTrack(project, project.tracks[0].id, firstClip),
      project.tracks[1].id,
      secondClip,
    );
    const next = removeClips(withClips, [firstClip.id]);
    expect(next.tracks).toHaveLength(3);
    expect(next.tracks[0].clips).toHaveLength(0);
    expect(next.tracks[1].clips[0].id).toBe(secondClip.id);
  });

  it("reorders and removes layers", () => {
    const project = createAssemblyProject();
    const moved = moveTrack(project, project.tracks[2].id, 0);
    expect(moved.tracks[0].id).toBe(project.tracks[2].id);
    const removed = removeTrack(moved, moved.tracks[1].id);
    expect(removed.tracks).toHaveLength(2);
    expect(removed.tracks.some((track) => track.id === moved.tracks[1].id)).toBe(
      false,
    );
  });

  it("trims clip edges while preserving project timing rules", () => {
    const project = createAssemblyProject();
    const clip = createClip(asset, { startSeconds: 0.4, endSeconds: 2.4 }, 1);
    const withClip = addClipToTrack(project, project.tracks[0].id, clip);
    const trimmedStart = trimClip(withClip, clip.id, "start", 0.31);
    const nextClip = trimmedStart.tracks[0].clips[0];
    expect(nextClip.startSeconds).toBe(1.3);
    expect(nextClip.sourceStartSeconds).toBeCloseTo(0.7);
    expect(nextClip.durationSeconds).toBeCloseTo(1.7);
    const trimmedEnd = trimClip(trimmedStart, clip.id, "end", -0.42);
    expect(trimmedEnd.tracks[0].clips[0].durationSeconds).toBe(1.3);

    const expandedStart = trimClip(trimmedEnd, clip.id, "start", -0.2);
    expect(expandedStart.tracks[0].clips[0].startSeconds).toBe(1.1);
    expect(expandedStart.tracks[0].clips[0].sourceStartSeconds).toBeCloseTo(0.5);

    const expandedEnd = trimClip(expandedStart, clip.id, "end", 10, 2.5);
    expect(expandedEnd.tracks[0].clips[0].durationSeconds).toBeCloseTo(2);
  });
});
