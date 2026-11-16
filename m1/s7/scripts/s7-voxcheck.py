import json, os, re, struct, sys, glob, math
from collections import defaultdict
from multiprocessing import Pool
import numpy as np

REPO = os.environ.get("REPO", os.getcwd())
LIB = f"{REPO}/.cache/ldraw"
OMR = f"{REPO}/.cache/omr"
FIX = f"{REPO}/packages/test-fixtures"
FAR = f"{REPO}/tools/asset-pipeline/dist/bundle/far"
CELL = np.array([20.0, 8.0, 20.0])
MARGIN = 0.1
STUDS = {"stud.dat", "stud2.dat"}

library = {}
for root, _, files in os.walk(LIB):
    for f in files:
        p = os.path.join(root, f)
        library[os.path.relpath(p, LIB).replace("\\", "/").lower()] = p


def norm(r):
    return r.strip().lower().replace("\\", "/")


def read(path):
    return open(path, encoding="utf-8", errors="replace").read().splitlines()


def resolve(ref):
    for cand in ("parts/" + ref, "p/" + ref, ref):
        if cand in library:
            return cand
    raise KeyError(ref)


def mat(tk):
    x, y, z, a, b, c, d, e, f, g, h, i = map(float, tk)
    return np.array([[a, b, c, x], [d, e, f, y], [g, h, i, z], [0, 0, 0, 1.0]])


part_cache = {}


def flatten_part(path):
    if path in part_cache:
        return part_cache[path]
    tris = defaultdict(list)
    studs = []

    def walk(lines, m, color):
        for line in lines:
            tk = line.split()
            if not tk:
                continue
            if tk[0] == "1" and len(tk) >= 15:
                c = int(tk[1])
                c = color if c == 16 else c
                ref = norm(" ".join(tk[14:]))
                mm = m @ mat(tk[2:14])
                if ref in STUDS:
                    studs.append(mm[:3, 3].copy())
                    continue
                walk(read(library[resolve(ref)]), mm, c)
            elif tk[0] in ("3", "4"):
                c = int(tk[1])
                c = color if c == 16 else c
                n = int(tk[0])
                v = np.array(list(map(float, tk[2 : 2 + 3 * n]))).reshape(n, 3)
                v = (m[:3, :3] @ v.T).T + m[:3, 3]
                tris[c].append(v[[0, 1, 2]])
                if n == 4:
                    tris[c].append(v[[0, 2, 3]])

    walk(read(library[path]), np.eye(4), 16)
    out = ({c: np.array(t) for c, t in tris.items()}, np.array(studs).reshape(-1, 3))
    part_cache[path] = out
    return out


def mpd_sections(path):
    secs, order, cur = {}, [], None
    for line in read(path):
        tk = line.split()
        if len(tk) >= 3 and tk[0] == "0" and tk[1].upper() == "FILE":
            cur = norm(" ".join(tk[2:]))
            secs[cur] = []
            order.append(cur)
            continue
        if cur is None:
            cur = ""
            secs[cur] = []
            order.append(cur)
        secs[cur].append(line)
    return secs, order


def is_part_section(lines):
    for line in lines:
        tk = line.split()
        if len(tk) >= 3 and tk[0] == "0" and tk[1] == "!LDRAW_ORG":
            return tk[2].lower() != "model"
    return False


def official(name):
    d, n = ("s/", name[2:]) if name.startswith("s/") else ("", name)
    m = re.match(r"^(\d+(?:-\d+)?) - (.*)$", n)
    return d + m.group(2) if m else name


def model_instances(path):
    secs, order = mpd_sections(path)
    out = []

    def walk(lines, m, color, depth):
        for line in lines:
            tk = line.split()
            if not tk or tk[0] != "1" or len(tk) < 15:
                continue
            c = int(tk[1])
            c = color if c == 16 else c
            ref = norm(" ".join(tk[14:]))
            mm = m @ mat(tk[2:14])
            if ref in secs and not is_part_section(secs[ref]):
                walk(secs[ref], mm, c, depth + 1)
                continue
            name = official(ref) if ref in secs else ref
            out.append((resolve(name), c, mm))

    walk(secs[order[0]], np.eye(4), 16, 0)
    return out


Y_UP = np.diag([1.0, -1.0, -1.0, 1.0])


def tri_area(t):
    return 0.5 * np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1)


def clip_area(tri, lo, hi):
    poly = [tuple(p) for p in tri]
    for axis in range(3):
        for bound, above in ((lo[axis], True), (hi[axis], False)):
            res = []
            for i in range(len(poly)):
                a, b = poly[i], poly[(i + 1) % len(poly)]
                ina = a[axis] >= bound if above else a[axis] <= bound
                inb = b[axis] >= bound if above else b[axis] <= bound
                if ina:
                    res.append(a)
                if ina != inb:
                    t = (bound - a[axis]) / (b[axis] - a[axis])
                    p = [a[k] + t * (b[k] - a[k]) for k in range(3)]
                    p[axis] = bound
                    res.append(tuple(p))
            poly = res
            if not poly:
                return 0.0
    if len(poly) < 3:
        return 0.0
    o = np.array(poly[0])
    s = np.zeros(3)
    for i in range(1, len(poly) - 1):
        s += np.cross(np.array(poly[i]) - o, np.array(poly[i + 1]) - o)
    return 0.5 * np.linalg.norm(s)


def phase_of(instances):
    layers = defaultdict(lambda: defaultdict(int))
    for path, _, m in instances:
        _, studs = flatten_part(path)
        if len(studs) == 0:
            continue
        w = (Y_UP @ m)[:3, :3] @ studs.T + (Y_UP @ m)[:3, 3:4]
        for x, y, z in w.T:
            px, pz = round(x % 20, 6) % 20, round(z % 20, 6) % 20
            if px != int(px) or pz != int(pz):
                continue
            layers[round(y * 1000)][(int(px), int(pz))] += 1
    low = min(layers)
    phases = layers[low]
    best = max(phases.values())
    winners = [p for p, c in phases.items() if c == best]
    assert len(winners) == 1, winners
    px, pz = winners[0]
    return np.array([(px - 10) % 20, round(low / 1000) % 8, (pz - 10) % 20], dtype=float)


def voxelize(name, path):
    instances = model_instances(path)
    phase = phase_of(instances)
    areas = defaultdict(lambda: defaultdict(float))
    triangles = 0
    for part, color, m in instances:
        tris, _ = flatten_part(part)
        M = Y_UP @ m
        for c, t in tris.items():
            cc = color if c == 16 else c
            w = np.einsum("ij,ntj->nti", M[:3, :3], t) + M[:3, 3]
            triangles += len(w)
            lo = np.floor((w.min(axis=1) - phase - MARGIN) / CELL).astype(int)
            hi = np.floor((w.max(axis=1) - phase + MARGIN) / CELL).astype(int)
            single = np.all(lo == hi, axis=1)
            a = tri_area(w)
            for k in np.nonzero(single & (a > 0))[0]:
                areas[tuple(lo[k])][cc] += a[k]
            for k in np.nonzero(~single)[0]:
                for i in range(lo[k, 0], hi[k, 0] + 1):
                    for j in range(lo[k, 1], hi[k, 1] + 1):
                        for l in range(lo[k, 2], hi[k, 2] + 1):
                            edge = phase + np.array([i, j, l]) * CELL
                            ar = clip_area(w[k], edge + MARGIN, edge + CELL - MARGIN)
                            if ar > 0:
                                areas[(i, j, l)][cc] += ar
    return name, phase, areas, triangles, len(instances)


def read_glb(path):
    b = open(path, "rb").read()
    n = struct.unpack("<I", b[12:16])[0]
    doc = json.loads(b[20 : 20 + n])
    bin_start = 20 + n + 8
    def arr(i):
        acc = doc["accessors"][i]
        view = doc["bufferViews"][acc["bufferView"]]
        o = bin_start + view.get("byteOffset", 0)
        return np.frombuffer(b[o : o + 4 * acc["count"]], dtype="<u4")
    ex = doc["extras"]
    return ex["voxels"], arr(ex["arrays"]["voxelCells"]), arr(ex["arrays"]["voxelColors"])


def translucent_codes():
    codes = set()
    for line in read(library["ldconfig.ldr"]):
        tk = line.split()
        if tk[:2] == ["0", "!COLOUR"] and "ALPHA" in tk:
            if int(tk[tk.index("ALPHA") + 1]) < 255:
                codes.add(int(tk[tk.index("CODE") + 1]))
    return codes


def check(args):
    name, path = args
    name, phase, areas, triangles, parts = voxelize(name, path)
    translucent = translucent_codes()
    manifest = json.load(open(f"{FAR}/manifest.json"))
    entry = next(m for m in manifest["models"] if m["name"] == name)
    meta, cells, colors = read_glb(f"{FAR}/{entry['farMesh']['file']}")
    origin = np.array(meta["origin"])
    dims = meta["dims"]
    baked = {}
    for cell, color in zip(cells.tolist(), colors.tolist()):
        x = cell % dims[0]
        y = (cell // dims[0]) % dims[1]
        z = cell // (dims[0] * dims[1])
        key = tuple(((origin + np.array([x, y, z]) * CELL - phase) / CELL).round().astype(int))
        baked[key] = color
    mine = {}
    for key, by_color in areas.items():
        opaque = {c: a for c, a in by_color.items() if c not in translucent}
        pool = opaque or by_color
        best = max(pool.values())
        mine[key] = min(c for c, a in pool.items() if a == best)
    only_mine = set(mine) - set(baked)
    only_baked = set(baked) - set(mine)
    colour_diff = sum(1 for k in set(mine) & set(baked) if mine[k] != baked[k])
    origin_cell_aligned = bool(np.all(((origin - phase) % CELL) == 0))
    return dict(
        model=name,
        parts=parts,
        triangles=triangles,
        independentPhase=phase.tolist(),
        bakedOrigin=origin.tolist(),
        originOnIndependentPhase=origin_cell_aligned,
        independentVoxels=len(mine),
        bakedVoxels=len(baked),
        onlyIndependent=len(only_mine),
        onlyBaked=len(only_baked),
        colourMismatches=colour_diff,
    )


if __name__ == "__main__":
    palette = json.load(open(f"{REPO}/tools/asset-pipeline/palette.json"))
    jobs = []
    for m in palette["models"]:
        if sys.argv[1:] and m["name"] not in sys.argv[1:]:
            continue
        root = OMR if m["origin"] == "omr" else FIX
        jobs.append((m["name"], f"{root}/{m['file']}"))
    with Pool(min(len(jobs), os.cpu_count() or 4)) as pool:
        rows = pool.map(check, jobs)
    for r in rows:
        print(json.dumps(r))
    json.dump(rows, open(os.environ.get("OUT", "voxcheck.json"), "w"), indent=1)
