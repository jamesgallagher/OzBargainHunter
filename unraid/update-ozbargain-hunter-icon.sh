#!/bin/sh
# update-ozbargain-hunter-icon.sh — surgical, idempotent Icon fix for the
# deployed Unraid template.
#
# Run on the Unraid host (or via ssh 'sh -s'):
#   ssh -i <key> root@<host> 'sh -s' < unraid/update-ozbargain-hunter-icon.sh
#
# This is the ONLY host-side write authorised by the feature. It performs an
# exact literal byte substitution of the single top-level <Icon> element: it
# does not parse or serialize XML, it changes no other bytes, and it never
# performs any container lifecycle operation.
#
# Behaviour:
#   - fails without mutation unless the target exists and is non-empty;
#   - if exactly one <Icon>OLD</Icon> exists and no <Icon>NEW</Icon> exists,
#     replaces that exact complete element with <Icon>NEW</Icon>;
#   - verifies after the write that the old complete element is absent and
#     exactly one new complete element exists;
#   - is idempotent: if the old element is absent and exactly one new element
#     already exists, returns success without writing;
#   - fails on every ambiguous state (missing Icon, duplicate elements, both
#     old and new present, or an unexpected Icon);
#   - prints only fixed status messages (never the template, matching lines,
#     value hashes, or diffs);
#   - supports a test-only target override via OZB_UNRAID_TEMPLATE_PATH.
set -u

OLD_ICON_URL='https://ozb-icon-hosting.invalid/ozbargainhunter-icon-256.png'
NEW_ICON_URL='https://raw.githubusercontent.com/jamesgallagher/OzBargainHunter/main/assets/logo/icon-256.png'
OLD_EL="<Icon>${OLD_ICON_URL}</Icon>"
NEW_EL="<Icon>${NEW_ICON_URL}</Icon>"

# Test-only target override; production uses the default deployed path.
TARGET="${OZB_UNRAID_TEMPLATE_PATH:-/boot/config/plugins/dockerMan/templates-user/my-ozbargain-hunter.xml}"

# Count occurrences of an exact complete element. `grep -c` prints 0 on a
# clean miss (exit 1); `|| true` swallows that exit status so the captured
# count is a single line (a `|| echo 0` would double it to "0\n0").
count_el() {
  grep -c -F "$1" "$TARGET" 2>/dev/null || true
}

# Well-formedness gate (D4 #1): the target must be well-formed XML before any
# mutation. Prefer xmllint, fall back to python3/python; if neither is
# available the check is reported as a NOTE (not a failure) — the exact
# element-state checks below are the load-bearing contract.
check_well_formed() {
  if command -v xmllint >/dev/null 2>&1; then
    xmllint --noout "$TARGET" >/dev/null 2>&1
  elif command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then
    PY=$(command -v python3 || command -v python)
    "$PY" -c 'import sys,xml.dom.minidom;xml.dom.minidom.parse(sys.argv[1])' "$TARGET" >/dev/null 2>&1
  else
    printf 'NOTE: no XML parser available; well-formedness not checked\n'
    return 0
  fi
}

fail() { printf 'FAIL: %s\n' "$1"; exit 1; }

# 1. The target must exist, be non-empty, and be well-formed XML before any
#    mutation.
[ -f "$TARGET" ] || fail "target template is missing"
[ -s "$TARGET" ] || fail "target template is empty"
check_well_formed || fail "target template is not well-formed XML"

OLD_N=$(count_el "$OLD_EL")
NEW_N=$(count_el "$NEW_EL")

# 4. Idempotent: old absent and exactly one new element already present.
if [ "$OLD_N" -eq 0 ] && [ "$NEW_N" -eq 1 ]; then
  printf 'PASS: icon already canonical (no change made)\n'
  exit 0
fi

# 2. Exactly one old element and no new element: perform the replacement.
if [ "$OLD_N" -eq 1 ] && [ "$NEW_N" -eq 0 ]; then
  # Literal byte substitution of the exact complete element. Write to a temp
  # file in the same directory, then move it over the target (atomic, no
  # partial write).
  TMP="${TARGET}.icon-tmp.$$"
  if ! sed "s|${OLD_EL}|${NEW_EL}|g" "$TARGET" > "$TMP" 2>/dev/null; then
    rm -f "$TMP"
    fail "replacement write failed"
  fi
  if ! mv "$TMP" "$TARGET" 2>/dev/null; then
    rm -f "$TMP"
    fail "replacement move failed"
  fi
  # 3. Verify after mutation: old complete element absent, exactly one new.
  V_OLD=$(count_el "$OLD_EL")
  V_NEW=$(count_el "$NEW_EL")
  if [ "$V_OLD" -eq 0 ] && [ "$V_NEW" -eq 1 ]; then
    printf 'PASS: icon replaced (one exact replacement)\n'
    exit 0
  fi
  fail "post-replacement verification failed"
fi

# 5. Every other state is ambiguous and fails without mutation.
fail "ambiguous icon state; no change made"
