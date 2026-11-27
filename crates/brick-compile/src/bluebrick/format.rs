pub const NEWEST_FORMAT: u32 = 9;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Format {
    version: u32,
}

impl Format {
    pub fn new(version: u32) -> Format {
        Format { version }
    }

    pub fn version(self) -> u32 {
        self.version
    }

    pub fn has_comment(self) -> bool {
        self.version >= 1
    }

    pub fn has_altitude(self) -> bool {
        self.version >= 3
    }

    pub fn has_groups(self) -> bool {
        self.version >= 5
    }

    pub fn has_layer_opacity(self) -> bool {
        self.version >= 5
    }

    pub fn has_layer_ids(self) -> bool {
        self.version >= 6
    }

    pub fn has_font_style(self) -> bool {
        self.version >= 6
    }

    pub fn has_brick_ids(self) -> bool {
        self.version >= 7
    }

    pub fn has_hulls(self) -> bool {
        self.version >= 9
    }

    pub fn has_elevation_display(self) -> bool {
        self.version >= 9
    }
}
