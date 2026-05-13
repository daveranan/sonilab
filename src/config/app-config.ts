import { z } from "zod";

export const exportFormatSchema = z.enum([
  "wav",
  "mp3",
  "ogg-vorbis",
  "flac",
  "aac-m4a",
  "mp4-audio",
]);

export const cloudCredentialSchema = z.object({
  provider: z.enum(["freesound", "internet-archive", "opengameart", "pixabay"]),
  credentialRef: z.string().min(1),
  label: z.string().min(1).optional(),
});

export const appConfigSchema = z.object({
  version: z.literal(1).default(1),
  libraries: z
    .object({
      local: z
        .array(
          z.object({
            id: z.string().min(1),
            name: z.string().min(1),
            path: z.string().min(1),
            enabled: z.boolean().default(true),
          }),
        )
        .default([]),
      cloud: z
        .object({
          freesound: z
            .object({
              enabled: z.boolean().default(false),
              credentialRef: z.string().min(1).optional(),
              defaultLicense: z.enum(["cc0", "any"]).default("cc0"),
            })
            .default({ enabled: false, defaultLicense: "cc0" }),
          credentials: z.array(cloudCredentialSchema).default([]),
        })
        .default({
          freesound: { enabled: false, defaultLicense: "cc0" },
          credentials: [],
        }),
    })
    .default({
      local: [],
      cloud: {
        freesound: { enabled: false, defaultLicense: "cc0" },
        credentials: [],
      },
    }),
  cache: z
    .object({
      decodedAudioMb: z.number().int().min(64).max(4096).default(512),
      waveformMb: z.number().int().min(64).max(8192).default(1024),
      previewFiles: z.number().int().min(1).max(512).default(64),
    })
    .default({ decodedAudioMb: 512, waveformMb: 1024, previewFiles: 64 }),
  audio: z
    .object({
      outputDeviceId: z.string().nullable().default(null),
      previewVolume: z.number().min(0).max(1).default(0.8),
      defaultLoopMode: z.enum(["off", "file", "selection"]).default("off"),
    })
    .default({
      outputDeviceId: null,
      previewVolume: 0.8,
      defaultLoopMode: "off",
    }),
  export: z
    .object({
      defaultFormat: exportFormatSchema.default("wav"),
      outputDirectory: z.string().nullable().default(null),
      preserveFolderStructure: z.boolean().default(false),
    })
    .default({
      defaultFormat: "wav",
      outputDirectory: null,
      preserveFolderStructure: false,
    }),
  ffmpeg: z
    .object({
      executablePath: z.string().nullable().default(null),
      sidecarDirectory: z.string().default("src-tauri/bin"),
      minimumVersion: z.string().default("6.0"),
    })
    .default({
      executablePath: null,
      sidecarDirectory: "src-tauri/bin",
      minimumVersion: "6.0",
    }),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type CloudCredential = z.infer<typeof cloudCredentialSchema>;
export type ExportFormat = z.infer<typeof exportFormatSchema>;

export const defaultAppConfig: AppConfig = appConfigSchema.parse({});

export function parseAppConfig(input: unknown): AppConfig {
  return appConfigSchema.parse(input);
}
