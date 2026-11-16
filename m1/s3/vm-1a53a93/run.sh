#!/usr/bin/env bash
cd /tmp/s3cmp
for q in "250k-aerial-gl:scene=city&parts=250000&api=webgl2&camera=aerial" "250k-street-gl:scene=city&parts=250000&api=webgl2&camera=street" "20k-aerial-gl:scene=city&parts=20000&api=webgl2&camera=aerial" "20k-street-gl:scene=city&parts=20000&api=webgl2&camera=street" "1m-aerial-gl:scene=city&parts=1000000&api=webgl2&camera=aerial" "1m-street-gl:scene=city&parts=1000000&api=webgl2&camera=street" "250k-aerial-gpu:scene=city&parts=250000&api=webgpu&camera=aerial"; do
  n=${q%%:*}; u=${q#*:}
  for side in main:4177 slice:4173; do
    label=${side%%:*}; port=${side#*:}
    DISPLAY=:1 timeout 3000 node /tmp/cmp.cjs $port "$u&measure=1&warmup=2&frames=3&maxMs=2400000" "$n-$label" > "$n-$label.log" 2>&1
  done
done
echo CMP-DONE > done
