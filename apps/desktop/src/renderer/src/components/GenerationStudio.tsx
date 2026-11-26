import type { JSX } from 'react';
import type { FileRecord } from '@assetforge/contracts';

export interface GenerationStudioProps {
  /** The source image. */
  file: FileRecord;
  onClose(): void;
  /** Opens a result (or the source) in the file detail dialog. */
  onOpenFile(fileId: string): void;
}

/** The generation studio: edits and upscales of one image. A stub until the studio is built. */
export function GenerationStudio(_props: GenerationStudioProps): JSX.Element | null {
  return null;
}
