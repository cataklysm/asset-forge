import { useEffect, useRef, useState, type RefObject } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { OPEN_EXTERNALLY_LABEL, VIDEO_LABEL, VIDEO_UNPLAYABLE_TEXT } from '../labels';
import { previewUrl, videoUrl } from '../media-url';
import { BUTTON, MUTED } from '../ui';

// The video of the file detail dialog, with the element's own controls and the volume of the app session.

/** Volume and mute of the app session: every video starts with the values the last one ended with. */
const session = { volume: 1, muted: false };

/** Back to full volume, unmuted; for tests. */
export function resetVideoSession(): void {
  session.volume = 1;
  session.muted = false;
}

/** Seeks and toggles the video the stage shows; the dialog's keys call it. */
export interface VideoControls {
  /** Moves the play position by seconds, within the video. */
  seek(seconds: number): void;
  /** Plays a paused video, else pauses it. */
  togglePlayback(): void;
}

/**
 * The controls of the element `ref` points to; nothing happens while there is none.
 *
 * @param ref the video element
 * @returns the controls
 */
export function videoControls(ref: RefObject<HTMLVideoElement | null>): VideoControls {
  return {
    seek(seconds) {
      const video = ref.current;
      if (video === null) return;
      const end = Number.isFinite(video.duration) ? video.duration : Number.POSITIVE_INFINITY;
      video.currentTime = Math.min(end, Math.max(0, video.currentTime + seconds));
    },
    togglePlayback() {
      const video = ref.current;
      if (video === null) return;
      if (video.paused) Promise.resolve(video.play()).catch(() => {});
      else video.pause();
    },
  };
}

interface Props {
  /** The shown file. */
  file: FileRecord;
  /** Receives the video element, for the dialog's keys. */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Opening externally is offered when the element cannot play the file; disabled while false. */
  canOpenExternally: boolean;
  /** Opens the file in the system's program. */
  onOpenExternally(): void;
}

/**
 * A video with the element's own controls, in the place of the image stage. Mount it keyed by the
 * file id, so leaving the file starts the next one afresh.
 *
 * @param props the file, the element ref and the external opening
 * @returns the stage
 */
export function VideoStage({ file, videoRef, canOpenExternally, onOpenExternally }: Props) {
  const [failed, setFailed] = useState(false);
  const own = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = own.current;
    if (video === null) return;
    video.volume = session.volume;
    video.muted = session.muted;
    return () => {
      // Leaving the file or closing the dialog ends playback and releases the request and the decoder.
      // StrictMode's simulated unmount leaves the element in place; it must keep its source then,
      // because React does not set an unchanged attribute again.
      if (video.isConnected) return;
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch {
        // Nothing to stop.
      }
    };
  }, []);

  return (
    <div role="region" aria-label={VIDEO_LABEL} className="flex h-full w-full items-center justify-center bg-raised">
      {failed ? (
        <div className="flex flex-col items-center gap-4">
          <p role="status" className={MUTED}>
            {VIDEO_UNPLAYABLE_TEXT}
          </p>
          <button type="button" className={BUTTON} disabled={!canOpenExternally} onClick={onOpenExternally}>
            {OPEN_EXTERNALLY_LABEL}
          </button>
        </div>
      ) : (
        <video
          ref={(element) => {
            own.current = element;
            videoRef.current = element;
          }}
          src={videoUrl(file.id)}
          poster={file.thumbnail ? previewUrl(file.id, 'detail') : undefined}
          preload="metadata"
          controls
          controlsList="nofullscreen nodownload noremoteplayback"
          disablePictureInPicture
          className="max-h-full max-w-full"
          onVolumeChange={(event) => {
            session.volume = event.currentTarget.volume;
            session.muted = event.currentTarget.muted;
          }}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
