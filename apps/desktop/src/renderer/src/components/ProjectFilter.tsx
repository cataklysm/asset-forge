import { X } from 'lucide-react';
import { useState } from 'react';
import { call } from '../api';
import { useLoad } from '../hooks/useLoad';
import { PROJECT_FILTER_LABEL, PROJECT_FILTER_TITLE, removeProjectFilterLabel } from '../labels';
import { CHIP_BUTTON, FILTER_CHIP } from '../ui';
import { ProjectPicker } from './ProjectPicker';

// The project filter of the asset gallery: a search-driven picker, and the chosen project as a chip.

interface Props {
  /** The chosen project's id, '' for none. */
  projectId: string;
  /** Chooses a project, '' clears the filter. */
  onChange(projectId: string): void;
}

/** A picked project, so its name shows without another request. */
interface Picked {
  id: string;
  name: string;
}

/**
 * The name of the chosen project: the picked one at once, otherwise read through `projects:get` (a filter restored
 * from the list state or set by Show all may name a project no loaded page holds).
 *
 * @param projectId the chosen project's id, '' for none
 * @param picked the project picked last in this filter
 * @returns the name, '' while unknown
 */
function useProjectName(projectId: string, picked: Picked | null): string {
  const known = picked !== null && picked.id === projectId;
  const lookup = useLoad(
    () => (projectId === '' || known ? Promise.resolve(null) : call('projects:get', { id: projectId })),
    [projectId, known],
  );
  if (known) return picked.name;
  return lookup.data?.name ?? '';
}

/**
 * The project filter: a picker while no project is chosen, then a chip with the project's name and a remove button.
 *
 * @param props the chosen project and its change
 * @returns the filter
 */
export function ProjectFilter({ projectId, onChange }: Props) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const name = useProjectName(projectId, picked);
  if (projectId === '') {
    return (
      <ProjectPicker
        label={PROJECT_FILTER_LABEL}
        title={PROJECT_FILTER_TITLE}
        onPick={(project) => {
          setPicked({ id: project.id, name: project.name });
          onChange(project.id);
        }}
      />
    );
  }
  return (
    <span className={`${FILTER_CHIP} max-w-64`} title={PROJECT_FILTER_TITLE}>
      <span className="truncate">{name}</span>
      <button
        type="button"
        aria-label={removeProjectFilterLabel(name)}
        onClick={() => onChange('')}
        className={`-mr-1 ${CHIP_BUTTON}`}
      >
        <X size={14} aria-hidden />
      </button>
    </span>
  );
}
