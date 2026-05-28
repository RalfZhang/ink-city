export type City = {
  id: number;
  name: string;
  localName: string;
  country: string;
  lat: number;
  lon: number;
  population: number;
};

export type ThemeMode = "light" | "dark" | "system";

export type ColorPair = {
  background: string;
  foreground: string;
};

export type Status = {
  enabled: boolean;
  hide_tray: boolean;
  running: boolean;
  city: City;
  date: string;
  theme: ThemeMode;
  effectiveTheme: "light" | "dark";
  light: ColorPair;
  dark: ColorPair;
};
