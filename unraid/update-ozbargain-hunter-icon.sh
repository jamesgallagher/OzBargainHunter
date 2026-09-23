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
#   - if exactly one authorised old <Icon> exists and no <Icon>NEW</Icon> exists,
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

LEGACY_ICON_URL='https://ozb-icon-hosting.invalid/ozbargainhunter-icon-256.png'
OLD_ICON_URL='https://raw.githubusercontent.com/jamesgallagher/OzBargainHunter/main/assets/logo/icon-256.png'
NEW_ICON_URL='https://raw.githubusercontent.com/jamesgallagher/OzBargainHunter/main/assets/logo/icon-1024.png'
LEGACY_EL="<Icon>${LEGACY_ICON_URL}</Icon>"
OLD_EL="<Icon>${OLD_ICON_URL}</Icon>"
NEW_EL="<Icon>${NEW_ICON_URL}</Icon>"

# Test-only target override; production uses the default deployed path.
TARGET="${OZB_UNRAID_TEMPLATE_PATH:-/boot/config/plugins/dockerMan/templates-user/my-ozbargain-hunter.xml}"

# Count occurrences of an exact complete element, including multiple
# occurrences on one line. This is a literal substring count, not a count of
# matching lines.
count_el() {
  FILE=${2:-$TARGET}
  awk -v needle="$1" '
    {
      rest = $0
      while ((position = index(rest, needle)) != 0) {
        count++
        rest = substr(rest, position + length(needle))
      }
    }
    END { print count + 0 }
  ' "$FILE" 2>/dev/null
}

# Validate well-formedness, the authorised location, and the parsed value of
# the unique direct-child Icon. Binding the expected value here prevents an
# exact OLD/NEW byte sequence in a comment or CDATA section from being treated
# as the target. The file is never serialized.
check_single_top_level_icon_value() {
  EXPECTED=$1
  FILE=${2:-$TARGET}
  if command -v xmllint >/dev/null 2>&1; then
    RESULT=$(xmllint --nonet --xpath \
      "count(//*[name() = 'Icon']) = 1 and count(/*/*[name() = 'Icon']) = 1 and string(/*/*[name() = 'Icon']) = '$EXPECTED'" \
      "$FILE" 2>/dev/null) || return 1
    [ "$RESULT" = 'true' ]
  elif command -v php >/dev/null 2>&1; then
    php -r '
      libxml_use_internal_errors(true);
      $doc = new DOMDocument();
      if (!$doc->load($argv[1], LIBXML_NONET)) exit(1);
      $all = 0;
      $top = 0;
      foreach ($doc->getElementsByTagName("*") as $element) {
        if ($element->tagName !== "Icon") continue;
        $all++;
        if ($element->parentNode->isSameNode($doc->documentElement)) $top++;
      }
      $icons = $doc->documentElement->getElementsByTagName("Icon");
      $direct = null;
      foreach ($doc->documentElement->childNodes as $child) {
        if ($child instanceof DOMElement && $child->tagName === "Icon") $direct = $child;
      }
      exit($all === 1 && $top === 1 && $direct->textContent === $argv[2] ? 0 : 1);
    ' "$FILE" "$EXPECTED" >/dev/null 2>&1
  elif command -v python3 >/dev/null 2>&1 || command -v python >/dev/null 2>&1; then
    PY=$(command -v python3 || command -v python)
    "$PY" -c '
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
all_icons = sum(element.tag == "Icon" for element in root.iter())
top_icons = [element for element in root if element.tag == "Icon"]
value = "".join(top_icons[0].itertext()) if len(top_icons) == 1 else None
sys.exit(0 if all_icons == 1 and value == sys.argv[2] else 1)
' "$FILE" "$EXPECTED" >/dev/null 2>&1
  else
    return 1
  fi
}

fail() { printf 'FAIL: %s\n' "$1"; exit 1; }

# 1. The target must exist and be non-empty. Its unique direct-child Icon must
#    parse to exactly one of the three authorised values before any mutation.
[ -f "$TARGET" ] || fail "target template is missing"
[ -s "$TARGET" ] || fail "target template is empty"
if check_single_top_level_icon_value "$LEGACY_ICON_URL"; then
  ICON_STATE=old
  OLD_EL=$LEGACY_EL
elif check_single_top_level_icon_value "$OLD_ICON_URL"; then
  ICON_STATE=old
elif check_single_top_level_icon_value "$NEW_ICON_URL"; then
  ICON_STATE=new
else
  fail "ambiguous icon state; no change made"
fi

OLD_N=$(count_el "$OLD_EL")
NEW_N=$(count_el "$NEW_EL")

# 4. Idempotent: old absent and exactly one new element already present.
if [ "$ICON_STATE" = new ] && [ "$OLD_N" -eq 0 ] && [ "$NEW_N" -eq 1 ]; then
  printf 'PASS: icon already canonical (no change made)\n'
  exit 0
fi

# 2. Exactly one old element and no new element: perform the replacement.
if [ "$ICON_STATE" = old ] && [ "$OLD_N" -eq 1 ] && [ "$NEW_N" -eq 0 ]; then
  # Literal byte substitution of the exact complete element. Write to a temp
  # file in the same directory, then move it over the target (atomic, no
  # partial write).
  TMP="${TARGET}.icon-tmp.$$"
  if ! sed "s|${OLD_EL}|${NEW_EL}|g" "$TARGET" > "$TMP" 2>/dev/null; then
    rm -f "$TMP"
    fail "replacement write failed"
  fi
  # Validate the candidate before replacing the target. This catches the case
  # where the sole raw OLD literal was a comment/CDATA decoy while the real
  # Icon used a different lexical representation of the same parsed value.
  V_OLD=$(count_el "$OLD_EL" "$TMP")
  V_NEW=$(count_el "$NEW_EL" "$TMP")
  if ! check_single_top_level_icon_value "$NEW_ICON_URL" "$TMP" || \
      [ "$V_OLD" -ne 0 ] || [ "$V_NEW" -ne 1 ]; then
    rm -f "$TMP"
    fail "ambiguous icon state; no change made"
  fi
  if ! mv "$TMP" "$TARGET" 2>/dev/null; then
    rm -f "$TMP"
    fail "replacement move failed"
  fi
  # 3. Verify after mutation: structure remains authorised, the old complete
  #    element is absent, and exactly one new complete element exists.
  V_OLD=$(count_el "$OLD_EL")
  V_NEW=$(count_el "$NEW_EL")
  if check_single_top_level_icon_value "$NEW_ICON_URL" && [ "$V_OLD" -eq 0 ] && [ "$V_NEW" -eq 1 ]; then
    printf 'PASS: icon replaced (one exact replacement)\n'
    exit 0
  fi
  fail "post-replacement verification failed"
fi

# 5. Every other state is ambiguous and fails without mutation.
fail "ambiguous icon state; no change made"
