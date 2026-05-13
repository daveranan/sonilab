import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type React from "react";

type ModalManagerValue = {
  activeSurface: string | null;
  close: (id?: string) => void;
  isOpen: (id: string) => boolean;
  open: (id: string) => void;
  toggle: (id: string) => void;
};

const fallbackManager: ModalManagerValue = {
  activeSurface: null,
  close: () => undefined,
  isOpen: () => false,
  open: () => undefined,
  toggle: () => undefined,
};

const ModalManagerContext = createContext<ModalManagerValue | null>(null);

export function ModalManagerProvider({ children }: { children: React.ReactNode }) {
  const [activeSurface, setActiveSurface] = useState<string | null>(null);

  const open = useCallback((id: string) => setActiveSurface(id), []);
  const close = useCallback((id?: string) => {
    setActiveSurface((current) => (!id || current === id ? null : current));
  }, []);
  const toggle = useCallback((id: string) => {
    setActiveSurface((current) => (current === id ? null : id));
  }, []);
  const isOpen = useCallback(
    (id: string) => activeSurface === id,
    [activeSurface],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !activeSurface) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activeSurface, close]);

  const value = useMemo(
    () => ({ activeSurface, close, isOpen, open, toggle }),
    [activeSurface, close, isOpen, open, toggle],
  );

  return (
    <ModalManagerContext.Provider value={value}>
      {children}
    </ModalManagerContext.Provider>
  );
}

export function useModalManager() {
  return useContext(ModalManagerContext) ?? fallbackManager;
}
