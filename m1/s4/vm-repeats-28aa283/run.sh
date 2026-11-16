#!/usr/bin/env bash
cd /tmp/s4rep
for cam in street aerial; do
  for i in 1 2 3 4 5; do
    for side in origin far; do
      extra=""; [ $side = far ] && extra="&origin=39063,39063"
      DISPLAY=:1 timeout 1800 node /tmp/cmp.cjs 4173 "scene=city&parts=250000&api=webgl2&camera=$cam$extra&measure=1&warmup=5&frames=30&maxMs=2400000" "$cam-$side-$i" > /dev/null 2>&1
    done
  done
done
echo REP-DONE > done
