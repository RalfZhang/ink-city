export type Bbox = { south: number; west: number; north: number; east: number };

const KM_PER_DEG_LAT = 111.32;

/// Build a bbox sized to the screen aspect: the longer side spans 2 * maxHalfKm,
/// the shorter side is scaled down by the aspect ratio (width / height).
export function bboxForScreen(lat: number, lon: number, maxHalfKm: number, aspect: number): Bbox {
  const [halfWKm, halfHKm] = aspect >= 1
    ? [maxHalfKm, maxHalfKm / aspect]
    : [maxHalfKm * aspect, maxHalfKm];
  const dLat = halfHKm / KM_PER_DEG_LAT;
  const dLon = halfWKm / (KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
  return { south: lat - dLat, west: lon - dLon, north: lat + dLat, east: lon + dLon };
}

export function project(lat: number, lon: number, b: Bbox, width: number, height: number): [number, number] {
  const x = ((lon - b.west) / (b.east - b.west)) * width;
  const y = ((b.north - lat) / (b.north - b.south)) * height;
  return [x, y];
}
