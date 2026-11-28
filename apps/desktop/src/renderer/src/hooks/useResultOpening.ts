import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { call, describeError } from '../api';
import { appliedByBatch, takeStored, toggledOff, type AppliedTag, type Shown, type Stored } from '../analysis-result';

/** Reads and shows the stored proposal of a file. */
export interface ProposalReader {
  /**
   * Reads the proposal of `id`; only the newest read of the file still shown sets what is shown or the error.
   *
   * @param id the file
   * @returns the answer, or null when the read failed
   */
  read(id: string): Promise<Stored | null>;
  /**
   * Shows `stored` for `id` and drops any read in flight.
   *
   * @param id the file
   * @param stored the answer
   */
  show(id: string, stored: Stored): void;
}

/** The refs and setters a read works with. */
interface Reading {
  readSeq: MutableRefObject<number>;
  fileIdRef: MutableRefObject<string | null>;
  setShown: Dispatch<SetStateAction<Shown | null>>;
  setError(message: string): void;
}

/**
 * Reads the proposal of `id`; only the newest read of the file still shown applies its answer.
 *
 * @param reading the refs and setters
 * @param id the file
 * @returns the answer, or null when the read failed
 */
async function readProposal(reading: Reading, id: string): Promise<Stored | null> {
  const seq = ++reading.readSeq.current;
  try {
    const stored = await call('analysis:getProposal', { fileId: id });
    const applied = appliedByBatch(stored) ? await readAppliedTags(id) : null;
    if (seq === reading.readSeq.current && reading.fileIdRef.current === id) {
      takeStored(reading.setShown, id, stored, applied);
    }
    return stored;
  } catch (error) {
    if (seq === reading.readSeq.current && reading.fileIdRef.current === id) reading.setError(describeError(error));
    return null;
  }
}

/**
 * The AI tags the file carries now, read after a batch analysis applied them.
 *
 * @param id the file
 * @returns the AI tags; empty when the file is gone or in the trash; rejects when the read fails
 */
async function readAppliedTags(id: string): Promise<AppliedTag[]> {
  const page = await call('files:list', { scope: { kind: 'all' }, ids: [id], offset: 0, limit: 1 });
  const record = page.items.find((item) => item.id === id);
  if (record === undefined) return [];
  return record.tags
    .filter((tag) => tag.origin === 'ai')
    .map((tag) => ({ name: tag.name, displayName: tag.displayName }));
}

/** The refs and setters an action works with. */
interface ActionControl {
  openingRef: MutableRefObject<number>;
  busyRef: MutableRefObject<number | null>;
  setBusyOpening(opening: number | null): void;
  setError(message: string | null): void;
}

/**
 * Runs one action of the current opening; `live()` is false once the dialog closed or switched
 * file, and every state change or callback after an await checks it.
 *
 * @param control the refs and setters
 * @param action the action
 * @returns resolves once the action ended; nothing runs while an action of this opening is in flight
 */
async function runInOpening(control: ActionControl, action: (live: () => boolean) => Promise<void>): Promise<void> {
  const token = control.openingRef.current;
  if (control.busyRef.current === token) return;
  control.busyRef.current = token;
  control.setBusyOpening(token);
  control.setError(null);
  const live = () => control.openingRef.current === token;
  try {
    await action(live);
  } finally {
    if (control.busyRef.current === token) {
      control.busyRef.current = null;
      control.setBusyOpening(null);
    }
  }
}

/** The owner's prompt pick for one file. */
export interface ChosenPrompt {
  fileId: string;
  id: string;
}

/** The state of the result dialog across its openings. */
export interface ResultOpening {
  shown: Shown | null;
  error: string | null;
  setError(message: string | null): void;
  /** An action of the current opening is in flight. */
  busy: boolean;
  /** The owner's prompt pick; null until one was made for the file shown. */
  chosenPrompt: ChosenPrompt | null;
  setChosenPrompt(chosen: ChosenPrompt | null): void;
  reader: ProposalReader;
  /**
   * Runs one action of the current opening (see `runInOpening`).
   *
   * @param action the action, given `live()`
   * @returns resolves once it ended
   */
  run(action: (live: () => boolean) => Promise<void>): Promise<void>;
  /**
   * Switches the tag `name` of the shown proposal on or off.
   *
   * @param name the tag
   */
  toggle(name: string): void;
  /**
   * Whether an action of the current opening is in flight right now.
   *
   * @returns true while one is
   */
  actionInFlight(): boolean;
}

/**
 * The openings of the result dialog: every open (or switch to another file) is a new opening, and
 * work started in one never touches the next. A moved change token re-reads what is shown.
 *
 * @param fileId the file shown; null while closed
 * @param changeToken the jobs context's change token
 * @returns the state and its actions
 */
export function useResultOpening(fileId: string | null, changeToken: number): ResultOpening {
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Every open (or switch to another file) is a new opening; work started in one never touches the next.
  const openingRef = useRef(0);
  const [opening, setOpening] = useState(0);
  // The opening whose action is in flight; another opening is not blocked by it.
  const busyRef = useRef<number | null>(null);
  const [busyOpening, setBusyOpening] = useState<number | null>(null);
  const busy = busyOpening !== null && busyOpening === opening;

  // The owner's prompt pick for this file; until then the tagging prompt used last (or the first).
  const [chosenPrompt, setChosenPrompt] = useState<ChosenPrompt | null>(null);
  const fileIdRef = useRef(fileId);
  fileIdRef.current = fileId;
  // Only the newest read may set what is shown.
  const readSeq = useRef(0);
  const lastFileId = useRef<string | null>(null);

  const reader: ProposalReader = {
    read: (id) => readProposal({ readSeq, fileIdRef, setShown, setError }, id),
    show: (id, stored) => {
      readSeq.current += 1;
      takeStored(setShown, id, stored);
    },
  };

  // Opening (or another file) starts fresh; a moved change token re-reads what is shown.
  useEffect(() => {
    if (fileId === null) {
      if (lastFileId.current !== null) {
        openingRef.current += 1;
        setOpening(openingRef.current);
      }
      lastFileId.current = null;
      readSeq.current += 1;
      setShown(null);
      setError(null);
      return;
    }
    if (lastFileId.current !== fileId) {
      lastFileId.current = fileId;
      openingRef.current += 1;
      setOpening(openingRef.current);
      setShown(null);
      setError(null);
      setChosenPrompt(null);
    }
    void reader.read(fileId);
    // `reader.read` only uses refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, changeToken]);

  return {
    shown,
    error,
    setError,
    busy,
    chosenPrompt,
    setChosenPrompt,
    reader,
    run: (action) => runInOpening({ openingRef, busyRef, setBusyOpening, setError }, action),
    toggle: (name) => setShown((current) => toggledOff(current, name)),
    actionInFlight: () => busyRef.current === openingRef.current,
  };
}
