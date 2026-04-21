#!/usr/bin/env bash
#
# Launch the 2x2 tmux layout used in the demo video's beat-3 visual:
# three workers editing their generated platforms + a reviewer pane
# streaming OpenAPI-diff events. Each pane tails one log file under
# tmp/trace/; the agent writes those files at runtime.
#
# Layout:
#   [rails worker]  | [iOS worker]
#   [reviewer]      | [Android worker]
#
# Usage: scripts/demo-tmux.sh [spec-slug]
# Default slug: clinic-queue

set -euo pipefail

slug="${1:-clinic-queue}"
session="demo"

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
out_root="$repo_root/out/$slug"
trace_dir="$repo_root/tmp/trace"

if ! command -v tmux >/dev/null 2>&1; then
  echo "error: tmux not installed (brew install tmux)" >&2
  exit 69
fi

if [[ ! -d "$out_root/rails" || ! -d "$out_root/ios" || ! -d "$out_root/android" ]]; then
  echo "error: $out_root/{rails,ios,android} incomplete. Run scripts/init-generated-project.sh $slug first." >&2
  exit 66
fi

mkdir -p "$trace_dir"
for agent in rails ios android reviewer; do
  touch "$trace_dir/$agent.log"
done

if tmux has-session -t "$session" 2>/dev/null; then
  tmux kill-session -t "$session"
fi

tmux new-session -d -s "$session" -c "$out_root/rails"
tmux send-keys -t "$session" "tail -F $trace_dir/rails.log" C-m

tmux split-window -h -t "$session" -c "$out_root/ios"
tmux send-keys -t "$session" "tail -F $trace_dir/ios.log" C-m

tmux split-window -v -t "$session" -c "$out_root/android"
tmux send-keys -t "$session" "tail -F $trace_dir/android.log" C-m

tmux select-pane -t "$session" -L
tmux split-window -v -t "$session" -c "$repo_root"
tmux send-keys -t "$session" "tail -F tmp/trace/reviewer.log" C-m

tmux select-layout -t "$session" tiled
tmux select-pane -t "$session" -t 0

echo "session ready: tmux attach -t $session"
echo "in another terminal, run the agent: npm run dev -- \"<your spec here>\""
