#!/bin/bash
# Uses built-in macOS tools only; never launches the application.
set -eu
stop_data="${1:-$HOME/Library/Application Support/org.LiveSub.LiveSub}"
stop_file="$stop_data/player.url"
if [ ! -f "$stop_file" ]; then echo 'V-Translate is not running (no saved local address).'; exit 0; fi
stop_url="$(cat "$stop_file")"
if [[ ! "$stop_url" =~ ^http://127\.0\.0\.1:([0-9]{1,5})/#token=([a-fA-F0-9]{64})$ ]]; then echo 'Invalid local V-Translate address.'; exit 1; fi
stop_port="${BASH_REMATCH[1]}"
stop_token="${BASH_REMATCH[2]}"
if [ "$stop_port" -lt 1 ] || [ "$stop_port" -gt 65535 ]; then exit 1; fi
stop_origin="http://127.0.0.1:$stop_port"
if ! curl --noproxy '*' --fail --silent --max-time 5 -H "Authorization: Bearer $stop_token" "$stop_origin/api/version" >/dev/null; then echo 'V-Translate is already stopped or unreachable.'; exit 0; fi
curl --noproxy '*' --fail --silent --max-time 15 -X POST -H "Authorization: Bearer $stop_token" "$stop_origin/api/quit" >/dev/null
for ((stop_attempt=0;stop_attempt<30;stop_attempt++)); do
  if ! curl --noproxy '*' --fail --silent --max-time 1 -H "Authorization: Bearer $stop_token" "$stop_origin/api/version" >/dev/null; then echo 'Whisper and the local server have stopped.'; exit 0; fi
  sleep .5
done
echo 'Shutdown is taking longer than expected. Please retry.'; exit 1
