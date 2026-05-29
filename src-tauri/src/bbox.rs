use serde::Serialize;

const KM_PER_DEG_LAT: f64 = 111.32;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct Bbox {
    pub south: f64,
    pub west: f64,
    pub north: f64,
    pub east: f64,
}

/// Build a bbox sized to the screen aspect: the longer side spans `2 * max_half_km`,
/// the shorter side is scaled down by the aspect ratio.
/// `aspect` is screen width / screen height.
/// Mirrors `bboxForScreen` in `src/core/bbox.ts`; keep them in sync.
pub fn bbox_for_screen(lat: f64, lon: f64, max_half_km: f64, aspect: f64) -> Bbox {
    let (half_w_km, half_h_km) = if aspect >= 1.0 {
        (max_half_km, max_half_km / aspect)
    } else {
        (max_half_km * aspect, max_half_km)
    };
    let d_lat = half_h_km / KM_PER_DEG_LAT;
    let d_lon = half_w_km / (KM_PER_DEG_LAT * lat.to_radians().cos());
    Bbox { south: lat - d_lat, west: lon - d_lon, north: lat + d_lat, east: lon + d_lon }
}
