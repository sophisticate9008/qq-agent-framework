import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark' | 'system';
const storageKey = 'qq-bridge-framework-theme';
const ThemeContext = createContext<{ theme: Theme; setTheme(theme: Theme): void }>({ theme: 'system', setTheme() {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState<Theme>(() => {
    try { const value = localStorage.getItem(storageKey); if (value === 'light' || value === 'dark' || value === 'system') return value; } catch {}
    return 'system';
  });
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = theme === 'system' ? media.matches ? 'dark' : 'light' : theme;
      document.documentElement.classList.toggle('dark', resolved === 'dark');
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.themePreference = theme;
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  function setTheme(value: Theme): void { updateTheme(value); try { localStorage.setItem(storageKey, value); } catch {} }
  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() { return useContext(ThemeContext); }
