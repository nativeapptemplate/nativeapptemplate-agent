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
# Slug-agnostic: tail the stable trace paths directly so the script
# works for any spec, any time, regardless of which slug the planner
# picks. The trace logs are the actual content; cd'ing panes into
# out/<slug>/<platform>/ was only cosmetic and forced an ordering
# constraint (init dirs first, predict slug, then run agent).
#
# Usage: scripts/demo-tmux.sh

set -euo pipefail

session="demo"
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
trace_dir="$repo_root/tmp/trace"

if ! command -v tmux >/dev/null 2>&1; then
  echo "error: tmux not installed (brew install tmux)" >&2
  exit 69
fi

mkdir -p "$trace_dir"
for agent in rails ios android reviewer; do
  touch "$trace_dir/$agent.log"
done

if tmux has-session -t "$session" 2>/dev/null; then
  tmux kill-session -t "$session"
fi

tmux new-session -d -s "$session" -c "$repo_root"
tmux send-keys -t "$session" "tail -F tmp/trace/rails.log" C-m

tmux split-window -h -t "$session" -c "$repo_root"
tmux send-keys -t "$session" "tail -F tmp/trace/ios.log" C-m

tmux split-window -v -t "$session" -c "$repo_root"
tmux send-keys -t "$session" "tail -F tmp/trace/android.log" C-m

tmux select-pane -t "$session" -L
tmux split-window -v -t "$session" -c "$repo_root"
tmux send-keys -t "$session" "tail -F tmp/trace/reviewer.log" C-m

tmux select-layout -t "$session" tiled
tmux select-pane -t "$session" -t 0

echo "session ready: tmux attach -t $session"
echo "in another terminal, run the agent: npm run dev -- \"<your spec here>\""
