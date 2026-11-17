import csv, json, sys
from collections import Counter, defaultdict

bundle, demo = sys.argv[1], sys.argv[2]
manifest = json.load(open(f"{bundle}/manifest.json"))
parts = [p["id"] for p in manifest["parts"] if p.get("role") != "model"]
dump = json.load(open(f"{demo}/city-result.json"))["worldPlacements"]


def dumped(region):
    by_index = defaultdict(Counter)
    for ref, color, x, z in zip(dump["refId"], dump["colorId"], dump["x"], dump["z"]):
        if region and not (region[0] <= x < region[2] and region[1] <= z < region[3]):
            continue
        by_index[color][parts[ref]] += 1
    return by_index


def exported(path):
    by_code = defaultdict(Counter)
    for row in csv.DictReader(open(path)):
        if row["Expanded from"]:
            raise SystemExit(f"unexpected expansion in {path}: {row}")
        by_code[int(row["LDraw colour"])][row["LDraw part"]] += int(row["Quantity"])
    return by_code


def unique_matching(by_index, by_code):
    mapping = {}
    for index, part_counts in by_index.items():
        codes = [code for code, counts in by_code.items() if counts == part_counts]
        if len(codes) != 1:
            return None
        mapping[index] = codes[0]
    if len(set(mapping.values())) != len(mapping) or set(mapping.values()) != set(by_code):
        return None
    return mapping


world = unique_matching(dumped(None), exported(f"{demo}/city-1-2000.parts.csv"))
region_index = dumped((0, 0, 640, 640))
region_export = exported(f"{demo}/city-1-2000.region_0_0_640_640.parts.csv")
region_mapped = defaultdict(Counter)
for index, counts in region_index.items():
    if world is not None:
        region_mapped[world[index]] += counts

print(json.dumps({
    "worldPlacements": len(dump["refId"]),
    "regionPlacements": sum(sum(c.values()) for c in region_index.values()),
    "method": "per colour index in the app's dumped World, its part counts must equal exactly one exported LDraw colour's part counts, one-to-one; that mapping is then applied to the Region's placements",
    "worldEqualsByPartAndColour": world is not None,
    "regionEqualsByPartAndColour": world is not None and region_mapped == region_export,
    "colourIndexToLdraw": world,
}, indent=1))
