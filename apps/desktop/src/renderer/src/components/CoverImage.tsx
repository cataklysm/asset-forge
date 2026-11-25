import { useState } from 'react';
import { previewUrl } from '../media-url';
import { MUTED } from '../ui';

interface Props {
  fileId: string | null;
  size: 'thumb' | 'detail';
  /** Shown instead of the image when there is none or it fails to load. */
  fallback: string;
  className?: string;
}

/** A preview in a fixed frame; never a broken-image icon. */
export function CoverImage({ fileId, size, fallback, className = '' }: Props) {
  // Remembers which file failed, so a new `fileId` gets a fresh attempt.
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = fileId !== null && failed !== fileId;
  return (
    <div
      className={`flex items-center justify-center overflow-hidden rounded bg-slate-100 dark:bg-slate-800 ${className}`}
    >
      {showImage ? (
        <img
          src={previewUrl(fileId, size)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          // Never upscaled; larger images shrink to fit, uncropped.
          className="max-h-full max-w-full object-contain"
          onError={() => setFailed(fileId)}
        />
      ) : (
        <span className={`truncate px-1 text-xs ${MUTED}`}>{fallback}</span>
      )}
    </div>
  );
}
