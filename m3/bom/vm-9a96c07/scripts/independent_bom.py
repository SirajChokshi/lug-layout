#!/usr/bin/env python3
import csv
import glob
import json
import os
import sys
from collections import Counter


def load_bundle(bundle_dir):
    manifest = json.load(open(os.path.join(bundle_dir, "manifest.json")))
    crosswalk = json.load(open(os.path.join(bundle_dir, manifest["crosswalk"]["file"])))
    return manifest, crosswalk


def model_lines(bundle_dir, entry):
    model = json.load(open(os.path.join(bundle_dir, entry["file"])))
    counts = Counter()
    for part, color in zip(model["instances"]["part"], model["instances"]["color"]):
        counts[(model["parts"][part], color)] += 1
    return counts


def expand(part, color, quantity, crosswalk, origin, depth, out):
    entry = crosswalk["parts"].get(part, {})
    components = entry.get("components") or []
    if not components or depth >= 8:
        out.append((part, color, quantity, origin))
        return
    for component in components:
        child_color = color if component["color"] == 16 else component["color"]
        expand(component["part"], child_color, quantity, crosswalk, origin or part, depth + 1, out)


def catalog(counts, crosswalk, system):
    mapped, unmapped = Counter(), Counter()
    for (part, color), quantity in counts.items():
        leaves = []
        expand(part, color, quantity, crosswalk, None, 0, leaves)
        for leaf, leaf_color, leaf_quantity, _ in leaves:
            part_id = crosswalk["parts"].get(leaf, {}).get(system)
            color_id = crosswalk["colors"].get(str(leaf_color), {}).get(system)
            if part_id is None or color_id is None:
                unmapped[(leaf, leaf_color)] += leaf_quantity
            else:
                mapped[(part_id, color_id)] += leaf_quantity
    return mapped, unmapped


def read_export(path):
    counts = Counter()
    with open(path, newline="") as handle:
        for row in csv.DictReader(handle):
            counts[(row["Part"], int(row["Color"]))] += int(row["Quantity"])
    return counts


def main():
    bundle_dir = sys.argv[1]
    export_dir = sys.argv[2] if len(sys.argv) > 2 else None
    manifest, crosswalk = load_bundle(bundle_dir)
    rows = []
    for entry in manifest["models"]:
        counts = model_lines(bundle_dir, entry)
        rb, rb_unmapped = catalog(counts, crosswalk, "rebrickable")
        bl, bl_unmapped = catalog(counts, crosswalk, "bricklink")
        row = {
            "set": entry["name"],
            "instances": sum(counts.values()),
            "manifestInstances": entry["instances"],
            "rebrickableParts": sum(rb.values()),
            "rebrickableUnmappedParts": sum(rb_unmapped.values()),
            "rebrickableUnmappedIds": sorted({p for p, _ in rb_unmapped}),
            "bricklinkParts": sum(bl.values()),
            "bricklinkUnmappedParts": sum(bl_unmapped.values()),
        }
        if export_dir:
            path = os.path.join(export_dir, f"{entry['name']}.rebrickable.csv")
            if os.path.exists(path):
                row["appExportEqualsIndependent"] = read_export(path) == rb
        rows.append(row)
    json.dump(rows, sys.stdout, indent=1)
    print()


main()
