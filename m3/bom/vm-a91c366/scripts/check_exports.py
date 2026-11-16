#!/usr/bin/env python3
import csv
import glob
import gzip
import json
import os
import sys
import xml.etree.ElementTree as ET
from collections import Counter

exports, catalog = sys.argv[1], sys.argv[2]


def gz_rows(path):
    with gzip.open(path, "rt", newline="") as handle:
        yield from csv.DictReader(handle)


rebrickable_parts = {row["part_num"] for row in gz_rows(f"{catalog}/rebrickable-dump/parts.csv.gz")}
api_colors = json.load(open(f"{catalog}/rebrickable-colors-api/colors.json"))["results"]
rebrickable_colors = {color["id"] for color in api_colors}
bricklink_colors = {
    i for color in api_colors for i in color["external_ids"].get("BrickLink", {}).get("ext_ids", []) if i is not None
}
bricklink_parts = {b for part in json.load(open(f"{catalog}/rebrickable-parts-api/partList.json")) for b in part["b"]}


def rebrickable_csv(path):
    counts = Counter()
    with open(path, newline="") as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        counts[(row["Part"], int(row["Color"]))] += int(row["Quantity"])
    return counts


def bricklink_xml(path):
    root = ET.parse(path).getroot()
    assert root.tag == "INVENTORY", root.tag
    counts = Counter()
    for item in root.findall("ITEM"):
        assert item.findtext("ITEMTYPE") == "P"
        counts[(item.findtext("ITEMID"), int(item.findtext("COLOR")))] += int(item.findtext("MINQTY"))
    return counts


report = {"files": {}, "importWorld": None, "regions": {}}
for path in sorted(glob.glob(f"{exports}/**/*.rebrickable.csv", recursive=True)):
    counts = rebrickable_csv(path)
    xml = bricklink_xml(path.replace(".rebrickable.csv", ".bricklink.xml"))
    report["files"][os.path.relpath(path, exports)] = {
        "rebrickableLots": len(counts),
        "rebrickableParts": sum(counts.values()),
        "rebrickablePartsNotInRebrickable": sorted({p for p, _ in counts} - rebrickable_parts),
        "rebrickableColorsNotInRebrickable": sorted({c for _, c in counts} - rebrickable_colors),
        "bricklinkLots": len(xml),
        "bricklinkParts": sum(xml.values()),
        "bricklinkItemsNotInRebrickableBrickLinkColumn": sorted({p for p, _ in xml} - bricklink_parts),
        "bricklinkColorsNotInRebrickableBrickLinkColumn": sorted({c for _, c in xml} - bricklink_colors),
    }

model = {
    os.path.basename(p).replace(".rebrickable.csv", ""): rebrickable_csv(p)
    for p in glob.glob(f"{exports}/model/*.rebrickable.csv")
}
world_files = glob.glob(f"{exports}/import/imported-world.rebrickable.csv")
if world_files:
    world = rebrickable_csv(world_files[0])
    total = Counter()
    for counts in model.values():
        total.update(counts)
    report["importWorld"] = {"equalsSumOfModelExports": world == total, "parts": sum(world.values())}
placements = json.load(open(f"{exports}/placements.json")) if os.path.exists(f"{exports}/placements.json") else []
order = sys.argv[3].split(",") if len(sys.argv) > 3 else []
for placement in placements:
    name = order[placement["module"]] if placement["module"] < len(order) else str(placement["module"])
    stem = f"imported-world.region_{placement['x'] - 10}_{placement['z'] - 10}_{placement['x'] + 10}_{placement['z'] + 10}"
    path = f"{exports}/import/{stem}.rebrickable.csv"
    if os.path.exists(path):
        region = rebrickable_csv(path)
        same_bytes = open(path, "rb").read() == open(f"{exports}/model/{name}.rebrickable.csv", "rb").read()
        report["regions"][name] = {
            "region": stem,
            "equalsModelExport": region == model.get(name),
            "byteIdentical": same_bytes,
        }
json.dump(report, sys.stdout, indent=1)
print()
