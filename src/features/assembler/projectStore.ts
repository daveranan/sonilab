import { createAssemblyProject } from "./assemblyModel";
import type { AssemblyProject } from "./types";

export const assemblyProjectsChangedEvent = "sonilabs:assembly-projects-changed";
export const assemblyProjectOpenEvent = "sonilabs:assembly-project-open";
export const assemblyProjectCreateEvent = "sonilabs:assembly-project-create";
export const assemblyProjectDeleteEvent = "sonilabs:assembly-project-delete";
export const assemblyProjectRenameEvent = "sonilabs:assembly-project-rename";

const projectsStorageKey = "sonilabs:assembly-projects:v2";
const legacyStorageKey = "sonilabs:assembly-project:v1";

export type AssemblyProjectsState = {
  activeProjectId: string;
  folders: AssemblyProjectFolder[];
  projectFolderIds: Record<string, string | null>;
  projects: AssemblyProject[];
};

export type AssemblyProjectFolder = {
  id: string;
  name: string;
};

function normalizeProject(project: AssemblyProject): AssemblyProject {
  return {
    ...project,
    tracks: project.tracks.map((track) => ({
      ...track,
      gain: Number.isFinite(track.gain) ? track.gain : 1,
      clips: track.clips.map((clip) => ({
        ...clip,
        fadeInSeconds: clip.fadeInSeconds ?? 0,
        fadeOutSeconds: clip.fadeOutSeconds ?? 0,
      })),
    })),
  };
}

export function readAssemblyProjects(): AssemblyProjectsState {
  try {
    const stored = window.localStorage.getItem(projectsStorageKey);
    if (stored) {
      const parsed = JSON.parse(stored) as AssemblyProjectsState;
      if (Array.isArray(parsed.projects) && parsed.projects.length) {
        const projects = parsed.projects.map(normalizeProject);
        const activeProjectId = projects.some(
          (project) => project.id === parsed.activeProjectId,
        )
          ? parsed.activeProjectId
          : projects[0].id;
        const folders = Array.isArray(parsed.folders) ? parsed.folders : [];
        const folderIds = new Set(folders.map((folder) => folder.id));
        const projectFolderIds = Object.fromEntries(
          projects.map((project) => {
            const folderId = parsed.projectFolderIds?.[project.id] ?? null;
            return [project.id, folderId && folderIds.has(folderId) ? folderId : null];
          }),
        );
        return { activeProjectId, folders, projectFolderIds, projects };
      }
    }
    const legacy = window.localStorage.getItem(legacyStorageKey);
    if (legacy) {
      const project = normalizeProject(JSON.parse(legacy) as AssemblyProject);
      return {
        activeProjectId: project.id,
        folders: [],
        projectFolderIds: { [project.id]: null },
        projects: [project],
      };
    }
  } catch {
    // Fall through to a fresh project.
  }
  const project = createAssemblyProject();
  return {
    activeProjectId: project.id,
    folders: [],
    projectFolderIds: { [project.id]: null },
    projects: [project],
  };
}

export function writeAssemblyProjects(state: AssemblyProjectsState): void {
  window.localStorage.setItem(projectsStorageKey, JSON.stringify(state));
  window.dispatchEvent(
    new CustomEvent(assemblyProjectsChangedEvent, { detail: state }),
  );
}

export function setActiveAssemblyProject(projectId: string): void {
  const state = readAssemblyProjects();
  if (!state.projects.some((project) => project.id === projectId)) return;
  writeAssemblyProjects({ ...state, activeProjectId: projectId });
}
