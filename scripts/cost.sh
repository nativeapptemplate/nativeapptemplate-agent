#!/usr/bin/env bash
#
# Aggregate token usage from tmp/trace/*.log and estimate Claude Opus 5.5 cost.
# The planner and judge emit one line per API call (src/structured-output.ts):
#   [02:09:29] usage: 83 in / 312 out / 1520 cache-write / 0 cache-read
# Lines from before cache tokens were logged ("usage: N in / M out") still
# parse, with zero cache tokens. The repair agent (Claude Agent SDK) emits
#   [02:10:01] ios/layer2: 3 turns, sdk-cost: $0.1000 (12 in / 3400 out / ...)
# and its USD is the SDK's own total_cost_usd, counted once and not re-priced.
#
# Usage: scripts/cost.sh [trace_dir]   (or: npm run cost)
# The agent writes traces to tmp/trace/ under the directory it ran in, so the
# default is that directory's tmp/trace/: INIT_CWD under `npm run cost` (npm
# runs scripts from the package root), else the current directory.
# Thinking tokens are billed as output and included in the out counts.
# Trace logs append across runs: clear tmp/trace/ first to cost a single run.

set -euo pipefail

# Claude Opus 5.5, USD per million tokens. Must match OPUS_PRICE_PER_MTOK in
# src/models.ts (a test checks). Cache writes: 5-minute TTL = 1.25x input
# (the judge's cache_control has no ttl, i.e. 5 minutes). Cache reads: 0.1x.
RATE_IN=4
RATE_OUT=20
RATE_CACHE_WRITE=5
RATE_CACHE_READ=0.4

trace_dir="${1:-${INIT_CWD:-$PWD}/tmp/trace}"

if [[ ! -d "$trace_dir" ]] || ! compgen -G "$trace_dir/*.log" >/dev/null; then
  echo "no trace files at $trace_dir — run \`npm run dev -- \"...\"\` first"
  exit 0
fi

awk -v r_in="$RATE_IN" -v r_out="$RATE_OUT" -v r_cw="$RATE_CACHE_WRITE" -v r_cr="$RATE_CACHE_READ" '
  function row(name, c, i, o, w, r, usd) {
    printf "%-12s %6s %10s %10s %12s %12s %10s\n", name, c, i, o, w, r, usd
  }
  function rule() {
    row("------------", "------", "----------", "----------", "------------", "------------", "----------")
  }
  # Reads "<n> in / <n> out [/ <n> cache-write / <n> cache-read]" starting
  # at field `start` into tok_in/tok_out/tok_cw/tok_cr. Fixed positions, so
  # free text after the counts (a repair summary) is never read as a count.
  function num(v) { gsub(/[^0-9]/, "", v); return v + 0 }
  function tokens(start) {
    tok_in = num($start)
    tok_out = num($(start + 3))
    tok_cw = 0; tok_cr = 0
    if ($(start + 7) == "cache-write") tok_cw = num($(start + 6))
    if ($(start + 10) ~ /^cache-read/) tok_cr = num($(start + 9))
  }
  function add(agent, usd) {
    if (!(agent in seen)) { order[++n_agents] = agent; seen[agent] = 1 }
    calls[agent]++
    sum_in[agent] += tok_in
    sum_out[agent] += tok_out
    sum_cw[agent] += tok_cw
    sum_cr[agent] += tok_cr
    cost[agent] += usd
  }
  BEGIN {
    row("Agent", "Calls", "Tokens in", "Tokens out", "Cache write", "Cache read", "Est. USD")
    rule()
  }
  {
    agent = FILENAME
    sub(/.*\//, "", agent)
    sub(/\.log$/, "", agent)
    for (i = 1; i <= NF; i++) {
      if ($i == "usage:") {
        tokens(i + 1)
        add(agent, (tok_in * r_in + tok_out * r_out + tok_cw * r_cw + tok_cr * r_cr) / 1000000)
        break
      }
      if ($i == "sdk-cost:") {
        usd = $(i + 1)
        sub(/^\$/, "", usd)
        tokens(i + 2)
        add(agent, usd + 0)
        break
      }
    }
  }
  END {
    if (n_agents == 0) {
      print "no usage lines found in trace logs"
      exit 0
    }
    t_calls = 0; t_in = 0; t_out = 0; t_cw = 0; t_cr = 0; t_cost = 0
    for (k = 1; k <= n_agents; k++) {
      a = order[k]
      row(a, calls[a], sum_in[a], sum_out[a], sum_cw[a], sum_cr[a], sprintf("$%.4f", cost[a]))
      t_calls += calls[a]; t_in += sum_in[a]; t_out += sum_out[a]
      t_cw += sum_cw[a]; t_cr += sum_cr[a]; t_cost += cost[a]
    }
    rule()
    row("Total", t_calls, t_in, t_out, t_cw, t_cr, sprintf("$%.4f", t_cost))
  }
' "$trace_dir"/*.log
