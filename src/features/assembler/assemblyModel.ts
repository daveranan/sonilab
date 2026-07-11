import type { WaveformRegion } from "@/features/audio-preview/types";

import type {
  AssemblyAsset,
  AssemblyClip,
  AssemblyProject,
  AssemblyTrack,
} from "./types";

const defaultClipDurationSeconds = 1;
const minClipDurationSeconds = 0.02;

function createId(prefix: string): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

export function createTrack(index: number): AssemblyTrack {
  return {
    id: createId("track"),
    name: `Layer ${index + 1}`,
    muted: false,
    solo: false,
    gain: 1,
    clips: [],
  };
}

export function createAssemblyProject(): AssemblyProject {
  return {
    id: createId("assembly"),
    name: "Untitled assembly",
    tracks: [createTrack(0), createTrack(1), createTrack(2)],
  };
}

export function createClip(
  asset: AssemblyAsset,
  region: WaveformRegion | null,
  startSeconds: number,
): AssemblyClip {
  const sourceStartSeconds = Math.max(0, region?.startSeconds ?? 0);
  const regionDuration = region
    ? Math.max(0.01, region.endSeconds - region.startSeconds)
    : null;
  const durationSeconds = Math.max(
    0.01,
    regionDuration ?? asset.durationSeconds ?? defaultClipDurationSeconds,
  );
  let hash = 0;
  for (let index = 0; index < asset.id.length; index += 1) {
    hash = (hash * 31 + asset.id.charCodeAt(index)) | 0;
  }
  return {
    id: createId("clip"),
    assetId: asset.id,
    name: asset.name,
    sourceAsset: asset,
    startSeconds: Math.max(0, startSeconds),
    sourceStartSeconds,
    durationSeconds,
    fadeInSeconds: 0,
    fadeOutSeconds: 0,
    colorIndex: Math.abs(hash) % 5,
  };
}

export function duplicateClip(
  clip: AssemblyClip,
  startSeconds: number,
): AssemblyClip {
  return {
    ...clip,
    id: createId("clip"),
    startSeconds: Math.max(0, startSeconds),
  };
}

export function projectDuration(project: AssemblyProject): number {
  return project.tracks.reduce(
    (projectEnd, track) =>
      track.clips.reduce(
        (trackEnd, clip) =>
          Math.max(trackEnd, clip.startSeconds + clip.durationSeconds),
        projectEnd,
      ),
    0,
  );
}

export function snapTimelineSeconds(seconds: number, step = 0.05): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.max(0, Math.round(seconds / step) * step);
}

export function clipsOverlap(
  leftStartSeconds: number,
  leftDurationSeconds: number,
  rightStartSeconds: number,
  rightDurationSeconds: number,
): boolean {
  const epsilon = 0.0001;
  return (
    leftStartSeconds < rightStartSeconds + rightDurationSeconds - epsilon &&
    rightStartSeconds < leftStartSeconds + leftDurationSeconds - epsilon
  );
}

export function canPlaceClip(
  project: AssemblyProject,
  clipId: string,
  trackId: string,
  startSeconds: number,
  durationSeconds?: number,
): boolean {
  const movingClip = project.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === clipId);
  const duration = durationSeconds ?? movingClip?.durationSeconds;
  const targetTrack = project.tracks.find((track) => track.id === trackId);
  if (!targetTrack || !duration || duration <= 0) return false;
  const start = Math.max(0, startSeconds);
  return !targetTrack.clips.some(
    (clip) =>
      clip.id !== clipId &&
      clipsOverlap(start, duration, clip.startSeconds, clip.durationSeconds),
  );
}

export function addClipToTrack(
  project: AssemblyProject,
  trackId: string,
  clip: AssemblyClip,
): AssemblyProject {
  if (
    !canPlaceClip(
      project,
      clip.id,
      trackId,
      clip.startSeconds,
      clip.durationSeconds,
    )
  ) {
    return project;
  }
  return {
    ...project,
    tracks: project.tracks.map((track) =>
      track.id === trackId ? { ...track, clips: [...track.clips, clip] } : track,
    ),
  };
}

export function moveClip(
  project: AssemblyProject,
  clipId: string,
  trackId: string,
  startSeconds: number,
): AssemblyProject {
  const movingClip = project.tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === clipId);
  if (!movingClip) return project;
  const snappedStartSeconds = snapTimelineSeconds(startSeconds);
  if (
    !canPlaceClip(
      project,
      clipId,
      trackId,
      snappedStartSeconds,
      movingClip.durationSeconds,
    )
  ) {
    return project;
  }
  const tracksWithoutClip = project.tracks.map((track) => ({
    ...track,
    clips: track.clips.filter((clip) => clip.id !== clipId),
  }));
  const movedClip = {
    ...movingClip,
    startSeconds: snappedStartSeconds,
  };
  return {
    ...project,
    tracks: tracksWithoutClip.map((track) =>
      track.id === trackId ? { ...track, clips: [...track.clips, movedClip] } : track,
    ),
  };
}

export function removeClips(
  project: AssemblyProject,
  clipIds: Iterable<string>,
): AssemblyProject {
  const ids = new Set(clipIds);
  if (ids.size === 0) return project;
  return {
    ...project,
    tracks: project.tracks.map((track) => ({
      ...track,
      clips: track.clips.filter((clip) => !ids.has(clip.id)),
    })),
  };
}

export function removeTrack(
  project: AssemblyProject,
  trackId: string,
): AssemblyProject {
  if (project.tracks.length <= 1) {
    return {
      ...project,
      tracks: project.tracks.map((track) =>
        track.id === trackId ? { ...track, clips: [] } : track,
      ),
    };
  }
  return {
    ...project,
    tracks: project.tracks.filter((track) => track.id !== trackId),
  };
}

export function moveTrack(
  project: AssemblyProject,
  trackId: string,
  targetIndex: number,
): AssemblyProject {
  const sourceIndex = project.tracks.findIndex((track) => track.id === trackId);
  if (sourceIndex === -1) return project;
  const clampedIndex = Math.max(0, Math.min(project.tracks.length - 1, targetIndex));
  if (sourceIndex === clampedIndex) return project;
  const tracks = [...project.tracks];
  const [track] = tracks.splice(sourceIndex, 1);
  if (!track) return project;
  tracks.splice(clampedIndex, 0, track);
  return { ...project, tracks };
}

export function trimClip(
  project: AssemblyProject,
  clipId: string,
  edge: "start" | "end",
  deltaSeconds: number,
  sourceDurationSeconds?: number,
): AssemblyProject {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds === 0) return project;
  return {
    ...project,
    tracks: project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) => {
        if (clip.id !== clipId) return clip;
        const clipEndSeconds = clip.startSeconds + clip.durationSeconds;
        if (edge === "start") {
          const earliestStartSeconds = Math.max(
            0,
            clip.startSeconds - clip.sourceStartSeconds,
          );
          const nextStartSeconds = Math.min(
            clipEndSeconds - minClipDurationSeconds,
            Math.max(
              earliestStartSeconds,
              snapTimelineSeconds(clip.startSeconds + deltaSeconds),
            ),
          );
          const actualDelta = nextStartSeconds - clip.startSeconds;
          const nextDurationSeconds = Math.max(
            minClipDurationSeconds,
            clipEndSeconds - nextStartSeconds,
          );
          return {
            ...clip,
            startSeconds: nextStartSeconds,
            sourceStartSeconds: Math.max(0, clip.sourceStartSeconds + actualDelta),
            durationSeconds: nextDurationSeconds,
            fadeInSeconds: Math.min(clip.fadeInSeconds ?? 0, nextDurationSeconds),
            fadeOutSeconds: Math.min(clip.fadeOutSeconds ?? 0, nextDurationSeconds),
          };
        }
        const maxDurationSeconds = Number.isFinite(sourceDurationSeconds)
          ? Math.max(
              minClipDurationSeconds,
              (sourceDurationSeconds ?? 0) - clip.sourceStartSeconds,
            )
          : Number.POSITIVE_INFINITY;
        const nextDurationSeconds = Math.min(
          maxDurationSeconds,
          Math.max(
            minClipDurationSeconds,
            snapTimelineSeconds(clip.durationSeconds + deltaSeconds),
          ),
        );
        return {
          ...clip,
          durationSeconds: nextDurationSeconds,
          fadeInSeconds: Math.min(clip.fadeInSeconds ?? 0, nextDurationSeconds),
          fadeOutSeconds: Math.min(clip.fadeOutSeconds ?? 0, nextDurationSeconds),
        };
      }),
    })),
  };
}

export function updateClip(
  project: AssemblyProject,
  clipId: string,
  update: Partial<AssemblyClip>,
): AssemblyProject {
  return {
    ...project,
    tracks: project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((clip) =>
        clip.id === clipId ? { ...clip, ...update } : clip,
      ),
    })),
  };
}
