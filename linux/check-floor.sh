#!/bin/sh
# Fails when the binary needs a newer glibc or Qt than the README states.
set -e
for floor in GLIBC:2.34 Qt:6.4; do
  name=${floor%:*} max=${floor#*:}
  v=$(objdump -T "$1" | grep -o "${name}_[0-9.]*" | cut -d_ -f2 | sort -uV | tail -n 1)
  echo "$name $v"
  if [ -z "$v" ] || ! printf '%s\n%s\n' "$v" "$max" | sort -VC; then
    echo "::error::needs $name '$v', not at or below the README's $max"
    exit 1
  fi
done
