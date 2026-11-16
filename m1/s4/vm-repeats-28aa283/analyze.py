import json, glob, statistics, os
os.chdir('/tmp/s4rep')
rows = []
for cam in ["street", "aerial"]:
    for side in ["origin", "far"]:
        med, p95, cpu = [], [], []
        for f in sorted(glob.glob(f"{cam}-{side}-*.json")):
            t = json.load(open(f))["timings"]
            med.append(t["medianFrameMs"]); p95.append(t["p95FrameMs"]); cpu.append(t["medianCpuSubmitMs"])
        if med:
            rows.append((cam, side, len(med), med, statistics.median(med), statistics.median(p95), statistics.median(cpu)))
for cam, side, n, med, mm, pp, cc in rows:
    print(json.dumps({"camera": cam, "side": side, "runs": n, "medianFrameMsPerRun": [round(m, 1) for m in med],
                      "medianOfMedians": round(mm, 1), "medianP95": round(pp, 1), "medianCpuSubmit": round(cc, 2)}))
