//! Port of `bboxForScreen` in `packages/core/src/bbox.ts`: CI precaches against the TS
//! version and the client renders against this one, so a divergence means the
//! fetched area stops matching the drawn area. Both are tested against the same
//! cases, scripts/fixtures/bbox-cases.json (`pnpm bbox-test` and the test below).

use serde::{Deserialize, Serialize};

const KM_PER_DEG_LAT: f64 = 111.32;

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Bbox {
    pub south: f64,
    pub west: f64,
    pub north: f64,
    pub east: f64,
}

/// Build a bbox sized to the screen aspect: the longer side spans `2 * max_half_km`,
/// the shorter side is scaled down by the aspect ratio.
/// `aspect` is screen width / screen height.
/// Mirrors `bboxForScreen` in `packages/core/src/bbox.ts`.
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The cases `pnpm bbox-test` runs against `bboxForScreen`, so the TS formula CI
    /// precaches with and this one can only change together. 1e-9° (~0.1 mm) is far
    /// below a pixel and far above the last-bit noise two `cos` implementations allow.
    #[test]
    fn bbox_for_screen_matches_the_shared_fixture() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Case {
            name: String,
            lat: f64,
            lon: f64,
            max_half_km: f64,
            /// width:height
            aspect: [f64; 2],
            bbox: Bbox,
        }
        #[derive(Deserialize)]
        struct Fixture {
            cases: Vec<Case>,
        }
        let fixture: Fixture =
            serde_json::from_str(include_str!("../../../../scripts/fixtures/bbox-cases.json"))
                .unwrap();
        assert!(!fixture.cases.is_empty());
        for c in fixture.cases {
            let got = bbox_for_screen(c.lat, c.lon, c.max_half_km, c.aspect[0] / c.aspect[1]);
            for (edge, got, want) in [
                ("south", got.south, c.bbox.south),
                ("west", got.west, c.bbox.west),
                ("north", got.north, c.bbox.north),
                ("east", got.east, c.bbox.east),
            ] {
                assert!(
                    (got - want).abs() < 1e-9,
                    "{}: {edge} is {got}, the fixture says {want}",
                    c.name
                );
            }
        }
    }
}
