#!/usr/bin/env bash
# Regenerate src/ui/examples/opentpu.v from OpenTPU (#63): clone, apply the export settings, run OpenTPU's
# simplemult program on PyRTL's simulator (reference results) and write the Verilog with the WebSim header.
#   scripts/opentpu_regen.sh [workdir]        (needs git, python3 with venv/pip, network)
# Outputs in the work directory: opentpu.v (ready to copy over src/ui/examples/opentpu.v) and reference.txt.
set -euo pipefail
WS=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(realpath -m "${1:-$(mktemp -d)}")
REV=${OPENTPU_REV:-ca5d381c93752a504e8de1fa10c9d51649853c70}
mkdir -p "$WORK"
cd "$WORK"
[ -d OpenTPU ] || git clone -q https://github.com/UCSBarchlab/OpenTPU
git -C OpenTPU checkout -q "$REV"
git -C OpenTPU checkout -q -- .
python3 -m venv venv
venv/bin/pip install -q 'pyrtl==0.10.2' numpy
cd OpenTPU
# export settings: an 8x8 array and smaller memories for the browser
sed -i -E 's/^MATSIZE = .*/MATSIZE = 8/; s/^IMEM_ADDR_SIZE = .*/IMEM_ADDR_SIZE = 9/; s/^UB_ADDR_SIZE = .*/UB_ADDR_SIZE = 8/; s/^ACC_ADDR_SIZE = .*/ACC_ADDR_SIZE = 8/' config.py
# PyRTL 0.10 has signed_mult where OpenTPU calls helperfuncs.mult_signed
sed -i 's/helperfuncs\.mult_signed(/signed_mult(/' matrix.py
../venv/bin/python assembler.py simplemult.a
PYTHONPATH=. ../venv/bin/python "$WS/scripts/opentpu_export.py" > ../reference.txt
# the WebSim header (provenance, export settings, license) and the module name
{ sed -n '1,/^$/p' "$WS/src/ui/examples/opentpu.v"; sed -n '/^module /,$p' opentpu.v | sed 's/^module toplevel(/module opentpu(/'; } > ../opentpu.v
cd ..
echo "Wrote $WORK/opentpu.v and $WORK/reference.txt"
if cmp -s opentpu.v "$WS/src/ui/examples/opentpu.v"; then echo "opentpu.v: identical to src/ui/examples/opentpu.v"; else echo "opentpu.v: differs from src/ui/examples/opentpu.v"; diff "$WS/src/ui/examples/opentpu.v" opentpu.v | head -40; fi
