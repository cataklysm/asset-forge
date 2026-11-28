import { useState } from 'react';
import { previewUrl } from '../media-url';
import { MUTED } from '../ui';

// A cached preview in a fixed frame.

interface Props {
  /** The file whose preview is shown; null for none. */
  fileId: string | null;
  /** The thumbnail or the detail preview. */
  size: 'thumb' | 'detail';
  /** Shown instead of the image when there is none or it fails to load. */
  fallback: string;
  /** Classes of the frame. */
  className?: string;
}

/**
 * A preview in a fixed frame; never a broken-image icon.
 *
 * @param props the file, the size, the fallback text and the frame's classes
 * @returns the frame
 */
export function CoverImage({ fileId, size, fallback, className = '' }: Props) {
  // Remembers which file failed, so a new `fileId` gets a fresh attempt.
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = fileId !== null && failed !== fileId;
  return (
    <div
      className={`flex items-center justify-center overflow-hidden rounded-control bg-raised ${className}`}
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
