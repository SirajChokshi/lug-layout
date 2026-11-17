import json
import sys

bundle, run_path = sys.argv[1], sys.argv[2]
run = json.load(open(run_path))
world = run["world"]
manifest = json.load(open(bundle + "/manifest.json"))
files = {m["name"]: m["file"] for m in manifest["models"]}


def world_columns(name):
    cells = json.load(open(bundle + "/" + files[name]))["cover"]["cells"]
    shift = world["frameShifts"][world["refs"].index("omr:" + name)]
    width, depth = cells["size"]
    ox = (cells["origin"][0] + shift[0]) / 20
    oz = (cells["origin"][1] + shift[2]) / 20
    assert ox == int(ox) and oz == int(oz)
    columns = {}
    for j in range(depth):
        for i in range(width):
            k = j * width + i
            if cells["columnTop"][k] != -1:
                columns[(int(ox) + i, int(oz) + j)] = (cells["columnBottom"][k], cells["columnTop"][k])
    return columns


lower = world_columns(run["lower"])
upper = world_columns(run["upper"])
tallest = max(top for _, top in lower.values())
predicted = max(max(lower.get(cell, (0, 0))[1] - bottom for cell, (bottom, _) in upper.items()), 0)
y = world["placements"]["yPlates"][world["placements"]["refId"].index(world["refs"].index("omr:" + run["upper"]))]
print(f"{run['lower']} tallest column: {tallest} plates ({tallest * 8} LDU above its rest plane)")
print(f"{run['upper']} resting height predicted from the two bake files: {predicted} plates")
print(f"{run['upper']} yPlates in the live World: {y}")
