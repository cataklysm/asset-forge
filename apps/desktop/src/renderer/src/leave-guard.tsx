import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';

type Guard = () => Promise<boolean>;

interface LeaveGuardState {
  /** Installs `guard` until the returned function removes it again. */
  register(guard: { current: Guard | null }): () => void;
  confirm(): Promise<boolean>;
}

const ALWAYS = async () => true;

const LeaveGuardContext = createContext<LeaveGuardState | null>(null);

/** Lets one mounted screen hold the main navigation back, e.g. while it has unsaved changes. */
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

/** While mounted with a non-null guard, the main navigation awaits it and stays when it answers false. */
export function useLeaveGuard(guard: Guard | null): void {
  const context = useContext(LeaveGuardContext);
  const latest = useRef<Guard | null>(guard);
  latest.current = guard;
  useEffect(() => context?.register(latest), [context]);
}

/** Asks the installed guards; true outside a provider or when none holds the navigation back. */
export function useConfirmLeave(): () => Promise<boolean> {
  return useContext(LeaveGuardContext)?.confirm ?? ALWAYS;
}
