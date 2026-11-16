#!/usr/bin/env bash
cd /tmp/s4ev
V() { DISPLAY=:1 timeout 1800 node /tmp/video.cjs "$@" > /dev/null 2>&1; }
C() { DISPLAY=:1 timeout 2400 node /tmp/cmp.cjs "$@" > /dev/null 2>&1; }
V 4178 "scene=city&parts=20000&api=webgl2&camera=aerial&origin=39063,39063" 12 before-aerial-far.webm
V 4173 "scene=city&parts=20000&api=webgl2&camera=aerial&origin=39063,39063" 12 after-aerial-far.webm
V 4173 "scene=city&parts=20000&api=webgl2&camera=aerial&origin=-39063,39063" 12 after-aerial-farneg.webm
V 4173 "scene=city&parts=20000&api=webgl2&camera=street&origin=39063,39063" 12 after-street-far.webm
V 4173 "scene=city&parts=250000&api=webgl2&camera=street&origin=39063,39063&measure=1&warmup=2&frames=40&maxMs=2400000" 0 after-rebase-250k-street-far.webm
C 4173 "scene=city&parts=20000&api=webgl2&camera=aerial&measure=1&warmup=2&frames=3&dumpWorld=1" dump-origin
C 4173 "scene=city&parts=20000&api=webgl2&camera=aerial&origin=39063,39063&measure=1&warmup=2&frames=3&dumpWorld=1" dump-far
C 4173 "scene=city&parts=20000&api=webgl2&camera=aerial&origin=-39063,39063&measure=1&warmup=2&frames=3&dumpWorld=1" dump-farneg
C 4173 "scene=city&parts=20000&api=webgl2&camera=street&origin=-39063,39063&measure=1&warmup=2&frames=3" c-street-farneg
C 4173 "scene=city&parts=250000&api=webgl2&camera=aerial&measure=1&warmup=2&frames=3&maxMs=2400000" c-250k-origin
C 4173 "scene=city&parts=250000&api=webgl2&camera=aerial&origin=39063,39063&measure=1&warmup=2&frames=3&maxMs=2400000" c-250k-far
C 4173 "scene=city&parts=250000&api=webgl2&camera=street&measure=1&warmup=2&frames=40&maxMs=2400000" c-250k-street-origin
C 4173 "scene=city&parts=250000&api=webgl2&camera=street&origin=39063,39063&measure=1&warmup=2&frames=40&maxMs=2400000" c-250k-street-far
C 4178 "scene=city&parts=250000&api=webgl2&camera=aerial&origin=39063,39063&measure=1&warmup=2&frames=3&maxMs=2400000" a-250k-far
C 4178 "scene=city&parts=250000&api=webgl2&camera=aerial&measure=1&warmup=2&frames=3&maxMs=2400000" a-250k-origin
echo EV-DONE > done
