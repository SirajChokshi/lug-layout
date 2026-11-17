set -e
OUT=$1
cd /tmp/drv
export DISPLAY=:1
U="api=webgl2&measure=1&warmup=2&frames=8"
SPECS=""
for m in 7936-1 10264-1 10185-1 10190-1 10218-1 2150-1 4554-1 4555-1 10128-1 10133-1; do
  SPECS="$SPECS before-$m=http://localhost:4173/?model=$m&$U after-$m=http://localhost:4174/?model=$m&$U"
done
for cam in street aerial; do
  SPECS="$SPECS before-city20k-$cam=http://localhost:4173/?scene=city&parts=20000&camera=$cam&$U after-city20k-$cam=http://localhost:4174/?scene=city&parts=20000&camera=$cam&$U"
done
node shoot.mjs $OUT $SPECS
