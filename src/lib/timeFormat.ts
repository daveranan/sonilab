export type AudioTimeParts = {
  main: string;
  milliseconds: string | null;
  full: string;
};

export function formatAudioTimeParts(value: number | null | undefined): AudioTimeParts {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
    return { main: "--", milliseconds: null, full: "--" };
  }

  const totalMilliseconds = Math.round(value * 1000);
  const milliseconds = String(totalMilliseconds % 1000).padStart(3, "0");
  const totalSeconds = Math.floor(totalMilliseconds / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const main =
    hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${Math.floor(totalSeconds / 60)}:${String(seconds).padStart(2, "0")}`;

  return {
    main,
    milliseconds,
    full: `${main}.${milliseconds}`,
  };
}
