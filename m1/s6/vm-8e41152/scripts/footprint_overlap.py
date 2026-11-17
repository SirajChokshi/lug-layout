import json
import sys

bundle = sys.argv[1]
run = json.load(open(sys.argv[2]))
world = run["world"]
manifest = json.load(open(bundle + "/manifest.json"))
files = {m["name"]: m["file"] for m in manifest["models"]}
p = world["placements"]
baseplate_cells = set()
for k, ref in enumerate(p["refId"]):
    if world["refs"][ref] == "ldraw:3811":
        x, z = p["x"][k] // 20, p["z"][k] // 20
        baseplate_cells |= {(x + i, z + j) for i in range(-16, 16) for j in range(-16, 16)}
neighbours = [(dx, dz) for dx in (-1, 0, 1) for dz in (-1, 0, 1) if (dx, dz) != (0, 0)]
expected = 0
for k, ref in enumerate(p["refId"]):
    rid = world["refs"][ref]
    if not rid.startswith("omr:") or p["rot"][k] != 0 or p["yPlates"][k] != 0:
        continue
    cells = json.load(open(bundle + "/" + files[rid[4:]]))["cover"]["cells"]
    shift = world["frameShifts"][ref]
    w = cells["size"][0]
    ox = int((cells["origin"][0] + shift[0]) / 20 + p["x"][k] // 20)
    oz = int((cells["origin"][1] + shift[2]) / 20 + p["z"][k] // 20)
    flat = {(ox + c % w, oz + c // w) for c in cells["flat"]}
    hollow = {(ox + c % w, oz + c // w) for c in cells["footprint"]} - flat
    culled = len(flat & baseplate_cells)
    culled += sum(
        1
        for (x, z) in hollow & baseplate_cells
        if all((x + dx, z + dz) in baseplate_cells for dx, dz in neighbours)
    )
    expected += culled
    print(f"{rid}: {len(flat)} flat + {len(hollow)} anti-stud footprint cells, {culled} baseplate studs culled")
print("predicted baseplate studs culled under footprints:", expected, "| app reported:", world["studs"]["culledUnderFootprints"])
