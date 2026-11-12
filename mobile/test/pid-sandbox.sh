#!/bin/bash
# Runs the tests that put a LIVE process at a PID the code under test reads
# (and that a defect or a mutant could signal) inside a throwaway container,
# never in the container or VM you run it from.
#
# WHY. On 2026-11-03 a mutation run of pd-happier-supervise's stale-record
# cleanup (a `kill $pids` mutant) met a test record naming PID 1 and SIGTERMed
# tini: the live pocket-dev died twice. Since then every record in
# happier.test.js names a PID no process can hold, and the few tests that need
# a real process are gated on PD_PID_SANDBOX=1 AND a PID 1 whose arguments
# include "pd-pid-sandbox", which only this script's container has. In here,
# kill(1) can only end this throwaway container.
#
# The repo is bind-mounted READ-ONLY and copied inside, so nothing the run does
# (a mutation included) can reach the working tree, even if it dies halfway.
# No network, capped memory and PIDs. The image is the Dockerfile's own final
# node base, so the Node version stays decided in one place.
#
# Usage: test/pid-sandbox.sh <repo root AS THE DOCKER HOST SEES IT> [vitest args]
#   in pocket-dev: the /coding path translates to /mnt/user/misc/coding/...
#   in CI:         "$GITHUB_WORKSPACE"
# Default vitest args: the PID-sandbox tests of test/server/happier.test.js and
# test/server/memguard.test.js.
# PD_PID_SANDBOX_PREP, when set, is a shell command run in the copy's mobile/
# directory before vitest (how a mutation is applied, to the copy only).
set -euo pipefail
src=${1:?usage: pid-sandbox.sh <repo root as the docker host sees it> [vitest args]}
shift
here=$(cd "$(dirname "$0")/../.." && pwd)
image=$(awk '$1 == "FROM" && $2 ~ /^node:/ { img = $2 } END { print img }' "$here/Dockerfile")
[ -n "$image" ] || { echo "pid-sandbox: no node base image in $here/Dockerfile" >&2; exit 2; }
[ "$#" -gt 0 ] || set -- test/server/happier.test.js test/server/memguard.test.js -t 'PID sandbox'
# Inside: a PREP must change the copy, and every "(PID sandbox)" test the
# filter selected must actually RUN (pass or fail), with at least one doing so,
# so a renamed describe, a filter that matches nothing, or a gate that no longer
# opens fails here instead of passing by running nothing.
exec docker run --rm --network=none --memory=2g --memory-swap=2g --pids-limit=512 \
  --user "$(id -u):$(id -g)" -e HOME=/tmp -e PD_PID_SANDBOX=1 \
  -e PD_PID_SANDBOX_PREP="${PD_PID_SANDBOX_PREP:-}" \
  -v "$src":/src:ro "$image" \
  bash -c 'cp -a /src /tmp/w && cd /tmp/w/mobile || exit 2
    if [ -n "$PD_PID_SANDBOX_PREP" ]; then
      bash -c "$PD_PID_SANDBOX_PREP" || exit 2
      if diff -rq -x node_modules -x .git /src /tmp/w >/dev/null; then
        echo "pid-sandbox: PD_PID_SANDBOX_PREP changed nothing" >&2; exit 2
      fi
    fi
    node node_modules/vitest/vitest.mjs run --reporter=default --reporter=json \
      --outputFile.json=/tmp/vitest.json "$@"
    rc=$?
    node -e "
      const r = JSON.parse(require(\"fs\").readFileSync(\"/tmp/vitest.json\", \"utf8\"));
      const t = r.testResults.flatMap((f) => f.assertionResults)
        .filter((a) => a.fullName.includes(\"(PID sandbox)\"));
      const ran = t.filter((a) => a.status === \"passed\" || a.status === \"failed\");
      if (!ran.length || ran.length !== t.length) {
        console.error(\"pid-sandbox: \" + ran.length + \" of \" + t.length + \" PID sandbox tests ran\");
        process.exit(1);
      }
      console.error(\"pid-sandbox: all \" + ran.length + \" PID sandbox tests ran\");
    " || exit 1
    exit $rc' pd-pid-sandbox "$@"
