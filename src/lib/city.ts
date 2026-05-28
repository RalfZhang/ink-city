import citiesData from "../data/cities.json";

export type City = {
  id: number;
  name: string;
  localName: string;
  country: string;
  lat: number;
  lon: number;
  population: number;
};

export const cities: readonly City[] = citiesData as City[];

const EPOCH_UTC = Date.UTC(2023, 2, 3); // 2023-03-03
const MS_PER_DAY = 86_400_000;

export function dayIndex(date: Date): number {
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const diffDays = Math.floor((today - EPOCH_UTC) / MS_PER_DAY);
  const n = cities.length;
  return ((diffDays % n) + n) % n;
}

export function pickCityForDate(date: Date): City {
  return cities[dayIndex(date)];
}

export function dateStamp(date: Date): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}
