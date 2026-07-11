import type { BrowseRow } from "@/features/browsing/browseTypes";
import type {
  ChannelMonitorMode,
  EqualizerSettings,
  PreviewMode,
} from "@/features/audio-preview/types";

export type AssemblyAsset = Extract<BrowseRow, { kind: "asset" }>;

export type AssemblyClipProcessing = {
  mode: PreviewMode;
  gainDb: number;
  eq: EqualizerSettings;
  pitchSemitones: number;
  playbackRate: number;
  channelMode: ChannelMonitorMode;
  reversed?: boolean;
};

export type AssemblyClip = {
  id: string;
  assetId: string;
  name: string;
  sourceAsset?: AssemblyAsset;
  startSeconds: number;
  sourceStartSeconds: number;
  durationSeconds: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  processing?: AssemblyClipProcessing;
  colorIndex: number;
};

export type AssemblyTrack = {
  id: string;
  name: string;
  muted: boolean;
  solo: boolean;
  gain: number;
  clips: AssemblyClip[];
};

export type AssemblyProject = {
  id: string;
  name: string;
  tracks: AssemblyTrack[];
};
