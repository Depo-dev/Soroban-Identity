import { useState, useEffect } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';

const THEME_STORAGE_KEY = 'theme-preference';

/**
 * Custom hook for theme management with system preference support.
 * 
 * @returns [currentTheme, setTheme, isDarkMode] tuple
 * - currentTheme: The user's theme preference ('system', 'light', or 'dark')
 * - setTheme: Function to update the theme preference
 * - isDarkMode: Boolean indicating if dark mode is active (considering system preference)
 */
export function useTheme(): [ThemePreference, (theme: ThemePreference) => void, boolean] {
  const [theme, setThemeState] = useState<ThemePreference>(() => {
    // Try to load from localStorage first
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored as ThemePreference;
    }
    // Default to system
    return 'system';
  });

  // Apply theme to document
  useEffect(() => {
    const html = document.documentElement;
    
    // Remove any existing theme classes
    html.classList.remove('light', 'dark');
    
    if (theme === 'light') {
      html.classList.add('light');
    } else if (theme === 'dark') {
      html.classList.add('dark');
    }
    // If theme is 'system', we don't add any class - CSS media query handles it
    
    // Persist to localStorage
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    
    // Ensure no flash of wrong theme by setting attribute immediately
    html.setAttribute('data-theme', theme);
  }, [theme]);

  // Determine if dark mode is active (for UI indicators)
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (theme === 'light') return false;
    if (theme === 'dark') return true;
    // For 'system', check system preference
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  // Listen for system preference changes when theme is 'system'
  useEffect(() => {
    if (theme !== 'system') {
      setIsDarkMode(theme === 'dark');
      return;
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    
    const handleChange = () => {
      setIsDarkMode(mediaQuery.matches);
    };
    
    // Set initial value
    setIsDarkMode(mediaQuery.matches);
    
    // Listen for changes
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  const setTheme = (newTheme: ThemePreference) => {
    setThemeState(newTheme);
  };

  return [theme, setTheme, isDarkMode];
}

/**
 * Cycles through theme preferences: system → light → dark → system
 */
export function cycleTheme(currentTheme: ThemePreference): ThemePreference {
  switch (currentTheme) {
    case 'system':
      return 'light';
    case 'light':
      return 'dark';
    case 'dark':
      return 'system';
    default:
      return 'system';
  }
}

/**
 * Gets the appropriate icon for the theme toggle button
 */
export function getThemeIcon(theme: ThemePreference, isDarkMode: boolean): string {
  if (theme === 'system') {
    return isDarkMode ? '☾' : '☀';
  }
  return theme === 'dark' ? '☾' : '☀';
}

/**
 * Gets the appropriate label for the theme toggle button
 */
export function getThemeLabel(theme: ThemePreference, isDarkMode: boolean, t: (key: string) => string): string {
  if (theme === 'system') {
    return isDarkMode ? t('app.darkMode') : t('app.lightMode');
  }
  return theme === 'dark' ? t('app.darkMode') : t('app.lightMode');
}