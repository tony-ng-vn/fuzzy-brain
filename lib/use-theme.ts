"use client";

import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "fuzzy-brain-theme";

// app/layout.tsx already set data-theme on <html> before paint (avoiding a
// flash); this hook just reads that starting value back and owns changes
// from here on.
function readInitialTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Private browsing or storage disabled: the toggle still works for
        // this session, it just will not persist across reloads.
      }
      return next;
    });
  }, []);

  return [theme, toggle];
}
