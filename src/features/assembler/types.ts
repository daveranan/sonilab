import type { BrowseRow } from "@/features/browsing/browseTypes";

export type AssemblyAsset = Extract<BrowseRow, { kind: "asset" }>;

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
