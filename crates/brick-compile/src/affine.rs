#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Affine {
    pub m: [f64; 12],
}

pub type Vec3 = [f64; 3];

impl Affine {
    pub const IDENTITY: Affine = Affine {
        m: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
    };

    pub const LDRAW_TO_Y_UP: Affine = Affine {
        m: [1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0],
    };

    pub fn from_ldraw(translation: Vec3, rotation: [f64; 9]) -> Affine {
        let [a, b, c, d, e, f, g, h, i] = rotation;
        Affine {
            m: [
                a,
                b,
                c,
                translation[0],
                d,
                e,
                f,
                translation[1],
                g,
                h,
                i,
                translation[2],
            ],
        }
    }

    pub fn then(&self, child: &Affine) -> Affine {
        let p = &self.m;
        let c = &child.m;
        let mut out = [0.0; 12];
        for row in 0..3 {
            for col in 0..4 {
                let mut value = 0.0;
                for k in 0..3 {
                    value += p[row * 4 + k] * c[k * 4 + col];
                }
                if col == 3 {
                    value += p[row * 4 + 3];
                }
                out[row * 4 + col] = value;
            }
        }
        Affine { m: out }
    }

    pub fn apply(&self, v: Vec3) -> Vec3 {
        let m = &self.m;
        [
            m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + m[3],
            m[4] * v[0] + m[5] * v[1] + m[6] * v[2] + m[7],
            m[8] * v[0] + m[9] * v[1] + m[10] * v[2] + m[11],
        ]
    }

    pub fn rotate(&self, v: Vec3) -> Vec3 {
        let m = &self.m;
        [
            m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
            m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
            m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
        ]
    }

    pub fn determinant(&self) -> f64 {
        let m = &self.m;
        m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8])
            + m[2] * (m[4] * m[9] - m[5] * m[8])
    }

    pub fn ldraw_to_y_up(&self) -> Affine {
        Affine::LDRAW_TO_Y_UP
            .then(self)
            .then(&Affine::LDRAW_TO_Y_UP)
    }
}
