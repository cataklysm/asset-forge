import type { FileRecord } from '@assetforge/contracts';
import { FileTile } from './FileTile';

interface Props {
  files: readonly FileRecord[];
  coverFileId: string | null;
  onSelect(file: FileRecord, trigger: HTMLElement): void;
}

export function FileGrid({ files, coverFileId, onSelect }: Props) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
      {files.map((file) => (
        <FileTile key={file.id} file={file} isCover={file.id === coverFileId} onSelect={onSelect} />
      ))}
    </div>
  );
}
