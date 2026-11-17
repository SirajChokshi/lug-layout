import json, sys, tarfile

bundle, archive = sys.argv[1], sys.argv[2]
manifest = json.load(open(f"{bundle}/manifest.json"))
crosswalk = json.load(open(f"{bundle}/{manifest['crosswalk']['file']}"))
parts = crosswalk["parts"]

keywords = {}
with tarfile.open(archive) as tar:
    for member in tar:
        segments = member.name.split("/")
        if len(segments) < 2 or segments[-2] != "parts" or not member.isfile() or not member.name.endswith(".dat"):
            continue
        ids = []
        for line in tar.extractfile(member).read().decode("utf8", "replace").splitlines()[:40]:
            if line.startswith("0 !KEYWORDS"):
                for token in line[11:].split(","):
                    token = token.strip()
                    if token.lower().startswith("rebrickable "):
                        ids.append(token.split(None, 1)[1].strip())
        keywords[segments[-1][:-4].lower()] = ids

chosen = [(k[6:], v) for k, v in parts.items() if v["rebrickable"] and v.get("rebrickableAlternatives")]
unjustified = [k for k, v in chosen if v["rebrickable"] != k and v["rebrickable"] not in keywords.get(k, [])]
ambiguous = sorted(k[6:] for k, v in parts.items() if not v["rebrickable"] and v.get("rebrickableAlternatives") and not v.get("rejectedAssemblyIds"))
flagged = {k: v for k, v in parts.items() if v.get("rejectedAssemblyIds")}
leaks = [k for k, v in flagged.items() if v["rebrickable"] in v["rejectedAssemblyIds"]["rebrickable"] or v["bricklink"] in v["rejectedAssemblyIds"]["bricklink"]]
reverse_leaks = [(bl, x) for bl, files in crosswalk["bricklinkParts"].items() for x in files if bl in flagged.get(x, {}).get("rejectedAssemblyIds", {}).get("bricklink", [])]
placeholders = sum("/" in k[6:] for k in parts) + sum("/" in x[6:] for table in (crosswalk["bricklinkParts"], crosswalk.get("bricklinkPartVariants", {})) for files in table.values() for x in files)
report = {
    "bundle": manifest["bundleVersion"],
    "crosswalk": manifest["crosswalk"]["file"],
    "entries": len(parts),
    "rebrickable": sum(1 for v in parts.values() if v["rebrickable"]),
    "bricklink": sum(1 for v in parts.values() if v["bricklink"]),
    "R1_chosenAmongSeveral": len(chosen),
    "R1_byOwnKeyword": sum(1 for k, v in chosen if v["rebrickable"] in keywords.get(k, [])),
    "R1_byExactId": sum(1 for k, v in chosen if v["rebrickable"] == k and v["rebrickable"] not in keywords.get(k, [])),
    "R1_unjustified": unjustified,
    "R1_unmappedWithAlternatives": ambiguous,
    "N5_placeholderIds": placeholders,
    "N6_flagged": len(flagged),
    "N6_flaggedStillMappedElsewhere": sum(1 for v in flagged.values() if v["rebrickable"] or v["bricklink"]),
    "N6_mappedToRejectedId": leaks,
    "N6_reverseLeaks": reverse_leaks,
    "examples": {k: parts.get("ldraw:" + k) for k in ["37365p01", "3815bpc44", "20460bp00", "973p8z", "4180", "3626bp8d"]},
    "bricklinkParts_970cm00pb018": crosswalk["bricklinkParts"].get("970cm00pb018"),
    "bricklinkParts_973pb0410c01": crosswalk["bricklinkParts"].get("973pb0410c01"),
}
print(json.dumps(report, indent=1))
