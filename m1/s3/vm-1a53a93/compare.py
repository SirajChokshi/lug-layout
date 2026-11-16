import json, glob, os
import subprocess
os.chdir('/tmp/s3cmp')
keys = [("parts", lambda r: r["summary"]["parts"]), ("modules", lambda r: r["summary"]["modules"]),
        ("studInstances", lambda r: r["summary"]["studInstances"]), ("studsDrawn", lambda r: r["summary"]["visibleStudInstances"]),
        ("sceneTriangles", lambda r: r["summary"]["bodyTriangles"] + r["summary"]["studTriangles"]),
        ("drawCalls", lambda r: r["timings"]["medianDrawCalls"]), ("drawnTriangles", lambda r: r["timings"]["medianDrawnTriangles"]),
        ("tiers", lambda r: "/".join(str(int(r["timings"]["medianChunkTiers"][k])) for k in ("near", "mid", "far"))),
        ("coverage", lambda r: ",".join(f"{c:.4f}" for c in r["timings"]["sceneCoverage"])),
        ("vertexIndexBytes", lambda r: r["memory"]["vertexIndexBytes"])]
for f in sorted(glob.glob("*-main.json")):
    n = f[:-len("-main.json")]
    if not os.path.exists(f"{n}-slice.json"): continue
    a = json.load(open(f)); b = json.load(open(f"{n}-slice.json"))
    same = all(k(a) == k(b) for _, k in keys)
    diffs = [name for name, k in keys if k(a) != k(b)]
    ha = int(open(f"{n}-main.heap.txt").read()); hb = int(open(f"{n}-slice.heap.txt").read())
    pd = json.loads(subprocess.check_output(["node", "/tmp/s3cmp/pixdiff.cjs", f"{n}-main.canvas.png", f"{n}-slice.canvas.png"]))
    print(json.dumps({"run": n, "countsIdentical": same, "differing": diffs, "parts": keys[0][1](a), "modules": keys[1][1](a),
        "studs": f"{keys[3][1](a)}/{keys[2][1](a)}", "sceneTris": keys[4][1](a), "draws": keys[5][1](a), "drawnTris": keys[6][1](a),
        "tiers": keys[7][1](a), "gpuVI": keys[9][1](a), "heapMainAfterGC": ha, "heapSliceAfterGC": hb, "heapDelta": hb - ha,
        "pixelDiff": pd,
        "medianMain": round(a["timings"]["medianFrameMs"], 1), "medianSlice": round(b["timings"]["medianFrameMs"], 1)}))
