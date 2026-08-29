#!/bin/sh

failures=0
suites=0

run_suite() {
  name=$1
  shift
  suites=$((suites + 1))
  printf '\nRUN  %s\n' "$name"
  if "$@"; then
    printf 'PASS %s\n' "$name"
  else
    status=$?
    failures=$((failures + 1))
    printf 'FAIL %s (exit %s)\n' "$name" "$status"
  fi
}

run_suite "turbo run test" turbo run test --continue
run_suite "test:packed-cli-e2e" pnpm run test:packed-cli-e2e

printf '\n%s of %s suites failed\n' "$failures" "$suites"
[ "$failures" -eq 0 ]
