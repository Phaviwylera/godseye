#!/usr/bin/env bash
# God's Eye — full test suite (syntax + unit + UI contract)
set -e
set -o pipefail
cd "$(dirname "$0")/.."

echo "== JS syntax =="
for f in js/*.js netlify/functions/*.mjs; do
  node --check "$f" >/dev/null 2>&1 || node --input-type=module -e "import('./$f')" >/dev/null 2>&1
  echo "  OK $f"
done

echo "== Python syntax =="
python3 -m py_compile server.py tools/build_dataset.py tools/check_liveness.py tools/build_regions.py tools/build_site.py
echo "  OK server + tools"

echo "== Unit tests =="
python3 -m unittest discover -s tests -p "test_*.py" -v
node --test tests/*.test.mjs
python3 tools/build_site.py
test -f site/index.html && test -f site/data/cameras.index.json
test ! -e site/godseye-netlify-drop.zip && test ! -e site/tools

echo ""
echo "ALL TESTS PASSED ✅"
