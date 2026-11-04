"""Regenerate src/ui/examples/opentpu.v from OpenTPU (https://github.com/UCSBarchlab/OpenTPU).

OpenTPU is written in PyRTL. This driver runs its "simplemult" program on PyRTL's simulator (like OpenTPU's
runtpu.py), prints the reference results the testbench checks, and writes the design as Verilog.

    git clone https://github.com/UCSBarchlab/OpenTPU && cd OpenTPU
    pip install pyrtl==0.10.2 numpy
    # config.py: MATSIZE = 8, IMEM_ADDR_SIZE = 9, UB_ADDR_SIZE = 8, ACC_ADDR_SIZE = 8
    # matrix.py (PyRTL 0.10): helperfuncs.mult_signed(weight, data_in) -> signed_mult(weight, data_in)
    python3 assembler.py simplemult.a
    PYTHONPATH=. python3 <websim>/scripts/opentpu_export.py > reference.txt
    # then add the provenance / license header and rename "module toplevel" to "module opentpu"
"""
import numpy as np
import pyrtl
import config
import tpu

with open('simplemult.out', 'rb') as f:
    code = f.read()
width = config.INSTRUCTION_WIDTH // 8
instrs = [int.from_bytes(code[i:i + width], 'big') for i in range(0, len(code), width)]


def concat_vec(vec):
    v = 0
    for x in reversed(vec):
        v = (v << 8) | (int(x) & 0xff)
    return v


def concat_tile(tile):
    v = 0
    for row in tile:
        for x in row:
            v = (v << 8) | (int(x) & 0xff)
    return v


host = {a: concat_vec(v) for a, v in enumerate(np.load('simplemult_hostmem.npy'))}
weights = {a: concat_tile(t) for a, t in enumerate(np.load('simplemult_weights.npy'))}
nchunks = max(config.MATSIZE * config.MATSIZE // 64, 1)

# the host memory and weight DRAM side, as in runtpu.py
sim = pyrtl.FastSimulation(tracer=pyrtl.SimulationTrace(), memory_value_map={tpu.IMem: dict(enumerate(instrs))})
idle = {tpu.weights_dram_in: 0, tpu.weights_dram_valid: 0, tpu.hostmem_rdata: 0}
sim.step(idle)
chunk, tile, cycles = nchunks, 0, 0
while not sim.inspect(tpu.halt):
    d = dict(idle)
    if chunk < nchunks:
        d[tpu.weights_dram_in] = (tile >> ((nchunks - chunk - 1) * 512)) & ((1 << 512) - 1)
        d[tpu.weights_dram_valid] = 1
        chunk += 1
    if sim.inspect(tpu.hostmem_re):
        d[tpu.hostmem_rdata] = host.get(sim.inspect(tpu.hostmem_raddr), 0)
    if sim.inspect(tpu.hostmem_we):
        host[sim.inspect(tpu.hostmem_waddr)] = sim.inspect(tpu.hostmem_wdata)
    if sim.inspect(tpu.weights_dram_read):
        tile, chunk = weights[sim.inspect(tpu.weights_dram_raddr)], 0
    sim.step(d)
    cycles += 1

print('instructions:', {a: hex(v) for a, v in enumerate(instrs) if v})
print('cycles', cycles)
for a, v in sorted(host.items()):
    print('host', a, hex(v))

# ports declared without a name in tpu.py get the name of their Python variable
for var in ['halt', 'hostmem_raddr', 'hostmem_rdata', 'hostmem_waddr', 'hostmem_wdata', 'hostmem_we',
            'weights_dram_raddr', 'weights_dram_read']:
    getattr(tpu, var).name = var
# readable names for the main registers and control signals (PyRTL calls them tmpN otherwise)
names = {
    'pc': 'pc', 'instr': 'instr', 'dispatch_mm': 'dispatch_mm', 'dispatch_act': 'dispatch_act',
    'dispatch_rhm': 'dispatch_rhm', 'dispatch_whm': 'dispatch_whm', 'dispatch_halt': 'dispatch_halt',
    'mm_busy': 'mm_busy', 'mm_done': 'mm_done', 'act_busy': 'act_busy', 'ub_act_we': 'ub_act_we',
    'ub_act_waddr': 'ub_act_waddr', 'act_out': 'act_out', 'ub_mm_raddr': 'ub_mm_raddr', 'UB2MM': 'ub_mm_rdata',
    'ubuffer_out': 'ub_whm_rdata', 'whm_N': 'whm_n', 'whm_busy': 'whm_busy', 'whm_addr': 'whm_addr',
    'whm_ub_raddr': 'whm_ub_raddr', 'rhm_N': 'rhm_n', 'rhm_busy': 'rhm_busy', 'rhm_addr': 'rhm_addr',
    'rhm_ub_waddr': 'rhm_ub_waddr', 'accum_act_raddr': 'accum_act_raddr',
}
for var, name in names.items():
    w = getattr(tpu, var)
    if isinstance(w, pyrtl.WireVector) and not isinstance(w, (pyrtl.Input, pyrtl.Output, pyrtl.Const)):
        w.name = name
tpu.IMem.name = 'imem'
tpu.UBuffer.name = 'unified_buffer'
with open('opentpu.v', 'w') as f:
    pyrtl.output_to_verilog(f)
