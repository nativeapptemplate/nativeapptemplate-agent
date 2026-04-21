#!/usr/bin/env bash
#
# Aggregate token usage from tmp/trace/*.log and estimate Opus 4.7 cost.
# Each sub-agent emits lines like:
#   [02:09:29] usage: 1897 in / 656 out
# This script sums those per agent, prints a table, and estimates USD.
#
# Usage: scripts/cost.sh   (or: npm run cost)
# Opus 4.7 rates: $15/Mtok input, $75/Mtok output.

set -euo pipefail

trace_dir="$(cd "$(dirname "$0")/.." && pwd)/tmp/trace"

if [[ ! -d "$trace_dir" ]] || ! compgen -G "$trace_dir/*.log" >/dev/null; then
  echo "no trace files at $trace_dir — run \`npm run dev -- \"...\"\` first"
  exit 0
fi

awk '
  BEGIN {
    printf "%-12s %6s %12s %12s %12s\n", "Agent", "Calls", "Tokens in", "Tokens out", "Est. USD"
    printf "%-12s %6s %12s %12s %12s\n", "------------", "------", "------------", "------------", "------------"
  }
  /usage:/ {
    agent = FILENAME
    sub(/.*\//, "", agent)
    sub(/\.log$/, "", agent)
    in_tok = 0
    out_tok = 0
    for (i = 1; i <= NF; i++) {
      if ($i == "usage:") { in_tok = $(i + 1); out_tok = $(i + 4) }
    }
    if (!(agent in seen)) { order[++n_agents] = agent; seen[agent] = 1 }
    calls[agent]++
    sum_in[agent] += in_tok
    sum_out[agent] += out_tok
  }
  END {
    if (n_agents == 0) {
      print "no usage: lines found in trace logs"
      exit 0
    }
    total_calls = 0; total_in = 0; total_out = 0; total_cost = 0
    for (i = 1; i <= n_agents; i++) {
      a = order[i]
      cost = sum_in[a] * 15 / 1000000 + sum_out[a] * 75 / 1000000
      printf "%-12s %6d %12d %12d %12s\n", a, calls[a], sum_in[a], sum_out[a], sprintf("$%.4f", cost)
      total_calls += calls[a]
      total_in += sum_in[a]
      total_out += sum_out[a]
      total_cost += cost
    }
    printf "%-12s %6s %12s %12s %12s\n", "------------", "------", "------------", "------------", "------------"
    printf "%-12s %6d %12d %12d %12s\n", "Total", total_calls, total_in, total_out, sprintf("$%.4f", total_cost)
  }
' "$trace_dir"/*.log
