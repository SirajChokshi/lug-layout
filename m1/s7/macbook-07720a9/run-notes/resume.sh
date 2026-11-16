#!/bin/zsh
unset PLAYWRIGHT_CORE
OUT=$HOME/brr-s7/repo/s7-macbook-07720a9
SCRIPTS=$HOME/brr-s7/work/m1/s7/scripts
export NODE_PATH=$HOME/brr-s7/work/node_modules
export NODE_OPTIONS="--require $HOME/brr-s7/bg-window-shim.cjs"
export FOCUS_LOG=$HOME/brr-s7/focus.log
export BRR_CDP_URL=http://127.0.0.1:9555
echo "$(date -u +%FT%TZ) == resume with shared background Chrome (tabs created in background) ==" >> $FOCUS_LOG
mv $OUT/scene10-webgl2 $OUT/scene10-webgl2.interrupted 2>/dev/null
{ echo "== resume $(date '+%F %T %Z')"; pmset -g batt | head -1; echo "load $(sysctl -n vm.loadavg)"; } >> $OUT/machine.txt
node $SCRIPTS/s7-scene.cjs --channel chrome --scene 10 --api webgl2 --width 1800 --height 1000 --dpr 2 --measure auto,near,mid,far --video 1 --out $OUT/scene10-webgl2 > $HOME/brr-s7/resume-scene10.log 2>&1
echo "scene10 exit=$?" >> $HOME/brr-s7/resume.log
node $SCRIPTS/s7-scene.cjs --channel chrome --scene 50 --api webgl2 --width 1800 --height 1000 --dpr 2 --measure auto,near,mid,far --out $OUT/scene50-webgl2 > $HOME/brr-s7/resume-scene50.log 2>&1
echo "scene50 exit=$?" >> $HOME/brr-s7/resume.log
uptime >> $OUT/machine.txt
echo RESUME_DONE >> $HOME/brr-s7/resume.log
