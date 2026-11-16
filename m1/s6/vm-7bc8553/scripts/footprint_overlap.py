import json, sys
bundle = sys.argv[1]
run = json.load(open(sys.argv[2]))
world = run["world"]
manifest = json.load(open(bundle + "/manifest.json"))
files = {m["name"]: m["file"] for m in manifest["models"]}
baseplate_cells = set()
expected = 0
p = world["placements"]
for k, ref in enumerate(p["refId"]):
    if world["refs"][ref] == "ldraw:3811":
        x, z = p["x"][k] // 20, p["z"][k] // 20
        baseplate_cells |= {(x + i, z + j) for i in range(-16, 16) for j in range(-16, 16)}
for k, ref in enumerate(p["refId"]):
    rid = world["refs"][ref]
    if not rid.startswith("omr:") or p["rot"][k] != 0 or p["yPlates"][k] != 0:
        continue
    cells = json.load(open(bundle + "/" + files[rid[4:]]))["cover"]["cells"]
    shift = world["frameShifts"][ref]
    w = cells["size"][0]
    ox = (cells["origin"][0] + shift[0]) / 20 + p["x"][k] // 20
    oz = (cells["origin"][1] + shift[2]) / 20 + p["z"][k] // 20
    under = {(int(ox) + c % w, int(oz) + c // w) for c in cells["footprint"]}
    n = len(under & baseplate_cells)
    expected += n
    print(f"{rid}: {len(cells['footprint'])} footprint cells, {n} over a placed 3811 baseplate")
print("predicted baseplate studs culled under footprints:", expected, "| app reported:", run["world"]["studs"]["culledUnderFootprints"])
