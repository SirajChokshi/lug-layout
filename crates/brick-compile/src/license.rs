#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LicenseVerdict {
    ContributorAgreement,
    NonContributorAgreement,
    Missing,
    Unrecognized(String),
}

impl LicenseVerdict {
    pub fn is_shippable(&self) -> bool {
        matches!(self, LicenseVerdict::ContributorAgreement)
    }
}

const CA_MARKERS: [&str; 3] = ["CCAL version 2.0", "CC BY 2.0", "CC BY 4.0"];
const NON_CA_MARKER: &str = "Not redistributable";

pub fn classify(license: Option<&str>) -> LicenseVerdict {
    let Some(text) = license.map(str::trim).filter(|t| !t.is_empty()) else {
        return LicenseVerdict::Missing;
    };
    if text.contains(NON_CA_MARKER) || text.contains("NonCA") {
        return LicenseVerdict::NonContributorAgreement;
    }
    if CA_MARKERS.iter().any(|marker| text.contains(marker)) {
        return LicenseVerdict::ContributorAgreement;
    }
    LicenseVerdict::Unrecognized(text.to_string())
}
