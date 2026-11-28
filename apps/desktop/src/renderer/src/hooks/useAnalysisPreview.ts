import { useEffect, useRef, useState } from 'react';
import type { AnalysisPreview, AnalysisTarget } from '@assetforge/contracts';
import { call, describeError } from '../api';

/** The preview counts of the start dialog. */
export interface PreviewState {
  /** The counts; null while they are read or failed. */
  preview: AnalysisPreview | null;
  previewing: boolean;
  /** Why the counts could not be read; null when they could. */
  previewError: string | null;
  /** Reads the counts again after a failure. */
  retry(): void;
}

/**
 * The preview counts of `target` for one provider and model, read again whenever one of them
 * changes or `retry` is called; an answer that was superseded is dropped.
 *
 * @param open whether the dialog is open; nothing is read while it is closed
 * @param target what to analyse; null reads nothing
 * @param model the model; null reads nothing
 * @param providerId the provider entry; null reads nothing
 * @returns the counts, their state and the retry
 */
export function useAnalysisPreview(
  open: boolean,
  target: AnalysisTarget | null,
  model: string | null,
  providerId: string | null,
): PreviewState {
  const [preview, setPreview] = useState<AnalysisPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Rises with every retry of a failed preview, so the preview effect runs again.
  const [previewRun, setPreviewRun] = useState(0);

  // The target as a value: a caller may pass an equal target as a new object on every render.
  const targetKey = target === null ? null : JSON.stringify(target);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    const current = targetRef.current;
    setPreview(null);
    setPreviewError(null);
    if (!open || current === null || model === null || providerId === null) {
      setPreviewing(false);
      return;
    }
    let superseded = false;
    setPreviewing(true);
    call('analysis:preview', { target: current, model, providerId })
      .then(
        (next) => {
          if (!superseded) setPreview(next);
        },
        (error: unknown) => {
          if (!superseded) setPreviewError(describeError(error));
        },
      )
      .finally(() => {
        if (!superseded) setPreviewing(false);
      });
    return () => {
      superseded = true;
    };
  }, [open, targetKey, model, providerId, previewRun]);

  return { preview, previewing, previewError, retry: () => setPreviewRun((run) => run + 1) };
}
