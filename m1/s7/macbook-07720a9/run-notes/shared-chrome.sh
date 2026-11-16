#!/bin/zsh
PREV=$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true')
PROFILE=/tmp/brr-shared-chrome
rm -rf $PROFILE; mkdir -p $PROFILE
open -g -n -a "Google Chrome" --args --user-data-dir=$PROFILE --remote-debugging-port=9555 --window-size=1800,1130 --window-position=0,0 --no-first-run --no-default-browser-check --enable-unsafe-webgpu --ignore-gpu-blocklist --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling about:blank
for i in $(seq 1 40); do
  [ "$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true')" = "Google Chrome" ] && osascript -e "tell application \"$PREV\" to activate"
  curl -sf http://127.0.0.1:9555/json/version > /dev/null && break
  sleep 0.25
done
for i in $(seq 1 12); do
  [ "$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true')" = "Google Chrome" ] && { osascript -e "tell application \"$PREV\" to activate"; echo "$(date '+%T') launch: re-activated $PREV" >> ${FOCUS_LOG:-/dev/null}; }
  sleep 0.25
done
echo "shared chrome up on 9555 (previous app $PREV, now $(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'))"
