# cocotb-compatible API for WebSim; see _core.py.
from ._core import (test, start_soon, start, create_task, fork, Task, log, get_sim_time,  # noqa: F401
                    Clock, Timer, RisingEdge, FallingEdge, Edge, ReadOnly, ReadWrite, First, Combine)
from . import _core, triggers, clock, handle, types, result, utils, task, queue, binary  # noqa: F401

SIM_NAME = 'WebSim'
SIM_VERSION = '1'
RANDOM_SEED = 0
plusargs = {}
argv = []
is_simulation = True


def __getattr__(name):
    # cocotb.top is set when the tests start
    if name == 'top':
        return _core.top
    raise AttributeError(name)
