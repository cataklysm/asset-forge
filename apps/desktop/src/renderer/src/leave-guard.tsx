import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';

/** Answers whether the navigation may leave; false keeps it where it is. */
type Guard = () => Promise<boolean>;

/** What the leave guard context offers. */
interface LeaveGuardState {
  /** Installs `guard` until the returned function removes it again. */
  register(guard: { current: Guard | null }): () => void;
  /** Asks the installed guards in order; false as soon as one holds the navigation back. */
  confirm(): Promise<boolean>;
}

/** The answer outside a provider: always leave. */
const ALWAYS = async () => true;

/** The installed guards of the main navigation. */
const LeaveGuardContext = createContext<LeaveGuardState | null>(null);

/**
 * Lets one mounted screen hold the main navigation back, e.g. while it has unsaved changes.
 *
 * @param props.children the tree that may install a guard
 */
export function LeaveGuardProvider({ children }: { children: ReactNode }) {
  const guards = useRef<{ current: Guard | null }[]>([]);
  const register = useCallback((guard: { current: Guard | null }) => {
    guards.current = [...guards.current, guard];
    return () => {
      guards.current = guards.current.filter((entry) => entry !== guard);
    };
  }, []);
  const confirm = useCallback(async () => {
    for (const entry of guards.current) {
      const guard = entry.current;
      if (guard !== null && !(await guard())) return false;
    }
    return true;
  }, []);
  const value = useMemo(() => ({ register, confirm }), [register, confirm]);
  return <LeaveGuardContext.Provider value={value}>{children}</LeaveGuardContext.Provider>;
}

/**
 * While mounted with a non-null guard, the main navigation awaits it and stays when it answers false.
 *
 * @param guard the guard in force; null lets the navigation leave
 */
export function useLeaveGuard(guard: Guard | null): void {
  const context = useContext(LeaveGuardContext);
  const latest = useRef<Guard | null>(guard);
  // Written after the commit, never during a render that may be thrown away.
  useLayoutEffect(() => {
    latest.current = guard;
  });
  useEffect(() => context?.register(latest), [context]);
}

/**
 * Asks the installed guards.
 *
 * @returns a function resolving to true outside a provider or when none holds the navigation back
 */
export function useConfirmLeave(): () => Promise<boolean> {
  return useContext(LeaveGuardContext)?.confirm ?? ALWAYS;
}
