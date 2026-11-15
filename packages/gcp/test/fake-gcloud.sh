#!/bin/sh
# A stand-in for gcloud in tests (spec D97): never the real one, which isn't installed here. It answers the two
# commands Landlens runs:
#   gcloud config get-value account                    → the account
#   gcloud auth print-access-token --account=<account> → the token, only for that account
# With CLOUDSDK_CONFIG set (Landlens passes CLOUDSDK_* through), files in that folder change its answers:
#   account  the account to print (empty: signed out)     token  the token to print
#   fail     print-access-token fails                       and every call is appended to `calls`, the environment
#   it was given to `env` (so a test can check what reached it).
dir="${CLOUDSDK_CONFIG:-}"
account="person@example.com"
token="ya29.FakeTokenForLandlensTestsOnly_0123456789abcdefghijklmnop"
if [ -n "$dir" ]; then
  [ -f "$dir/account" ] && account="$(cat "$dir/account")"
  [ -f "$dir/token" ] && token="$(cat "$dir/token")"
  echo "$*" >> "$dir/calls"
  env > "$dir/env"
fi
case "$1 $2 $3" in
  "config get-value account")
    if [ -n "$account" ]; then echo "$account"; else echo "(unset)" >&2; fi
    exit 0 ;;
  "auth print-access-token "*)
    if [ -n "$dir" ] && [ -f "$dir/fail" ]; then echo "ERROR: (gcloud.auth.print-access-token) reauth needed" >&2; exit 1; fi
    if [ -z "$account" ] || [ "$3" != "--account=$account" ]; then echo "ERROR: no credentials for $3" >&2; exit 1; fi
    echo "$token"
    exit 0 ;;
esac
echo "fake gcloud: unknown command $*" >&2
exit 2
