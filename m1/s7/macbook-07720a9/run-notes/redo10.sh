#!/bin/zsh
unset PLAYWRIGHT_CORE
OUT=$HOME/brr-s7/repo/s7-macbook-07720a9
export NODE_PATH=$HOME/brr-s7/work/node_modules
export NODE_OPTIONS="--require $HOME/brr-s7/bg-window-shim.cjs"
export FOCUS_LOG=$HOME/brr-s7/focus.log
export BRR_CDP_URL=http://127.0.0.1:9555
echo "$(date -u +%FT%TZ) == redo scene10-webgl2 for video ==" >> $FOCUS_LOG
mv $OUT/scene10-webgl2 $OUT/scene10-webgl2.novideo 2>/dev/null
node $HOME/brr-s7/work/m1/s7/scripts/s7-scene.cjs --channel chrome --scene 10 --api webgl2 --width 1800 --height 1000 --dpr 2 --measure auto,near,mid,far --video 1 --out $OUT/scene10-webgl2 > $HOME/brr-s7/redo10.log 2>&1
echo "EXIT=$?" >> $HOME/brr-s7/redo10.log
