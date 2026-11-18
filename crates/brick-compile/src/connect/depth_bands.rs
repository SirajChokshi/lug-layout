use super::solid::HALF_GRID_LDU;

pub struct DepthBands {
    bands: Vec<Band>,
}

struct Band {
    span: f64,
    facets: Vec<u32>,
}

fn span_of(low: f64, high: f64) -> f64 {
    let mut span = HALF_GRID_LDU;
    while low + span < high {
        span *= 2.0;
    }
    span
}

impl DepthBands {
    pub fn new(
        mut facets: Vec<u32>,
        low_of: impl Fn(u32) -> f64,
        high_of: impl Fn(u32) -> f64,
    ) -> Self {
        facets.sort_by(|&a, &b| low_of(a).total_cmp(&low_of(b)).then(a.cmp(&b)));
        let span = |facet: u32| span_of(low_of(facet), high_of(facet));
        let Some(first) = facets.first().map(|&facet| span(facet)) else {
            return DepthBands { bands: Vec::new() };
        };
        if facets.iter().all(|&facet| span(facet) == first) {
            return DepthBands {
                bands: vec![Band {
                    span: first,
                    facets,
                }],
            };
        }
        let mut bands: Vec<Band> = Vec::new();
        for facet in facets {
            let wide = span(facet);
            let band = match bands.iter().position(|band| band.span == wide) {
                Some(found) => found,
                None => {
                    bands.push(Band {
                        span: wide,
                        facets: Vec::new(),
                    });
                    bands.len() - 1
                }
            };
            bands[band].facets.push(facet);
        }
        DepthBands { bands }
    }

    pub fn starting_before(
        &self,
        (from, to): (f64, f64),
        low_of: impl Fn(u32) -> f64,
        found: &mut impl FnMut(u32) -> bool,
    ) -> bool {
        for band in &self.bands {
            let start = band
                .facets
                .partition_point(|&facet| low_of(facet) + band.span < from);
            for &facet in &band.facets[start..] {
                if low_of(facet) > to {
                    break;
                }
                if !found(facet) {
                    return false;
                }
            }
        }
        true
    }
}
