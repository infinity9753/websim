# cocotb-compatible testbench API for WebSim (#46).
# A clean-room implementation of the publicly documented cocotb user API (tests, tasks, triggers,
# handles, values, clocks), driving the WebSim kernel through the _websim bridge instead of VPI/GPI.
import sys, logging, traceback, inspect, collections, time as _time
import _websim as _w

# ------------------------------------------------------------------ time
_UNITS = {'fs': 1, 'ps': 10**3, 'ns': 10**6, 'us': 10**9, 'ms': 10**12, 'sec': 10**15, 's': 10**15}


def _unit(unit, units):
    u = units if units is not None else unit
    return 'step' if u is None else u


def _to_fs(t, unit):
    if unit == 'step':
        return int(round(t * _w.precision()))
    if unit not in _UNITS:
        raise ValueError(f"invalid time unit {unit!r}")
    v = t * _UNITS[unit]
    if v != int(round(v)) and abs(v - round(v)) > 1e-6:
        raise ValueError(f"time {t} {unit} is not a whole number of fs")
    return int(round(v))


def get_sim_time(unit='step', units=None):
    unit = _unit(unit, units)
    fs = _w.now()
    if unit == 'step':
        return fs // _w.precision()
    return fs / _UNITS[unit]


# ------------------------------------------------------------------ values
_BITCH = set('01xzuwlhXZUWLH-')


class Logic:
    """A single 4/9-state bit."""
    __slots__ = ('_c',)

    def __init__(self, v='0'):
        if isinstance(v, Logic):
            v = v._c
        elif isinstance(v, bool) or isinstance(v, int):
            if v not in (0, 1):
                raise ValueError(f"{v!r} is not a valid Logic value")
            v = '1' if v else '0'
        if not isinstance(v, str) or len(v) != 1 or v not in _BITCH:
            raise ValueError(f"{v!r} is not a valid Logic value")
        self._c = v.upper() if v in 'xzuwlh' else v

    def is_resolvable(self):
        return self._c in '01LH'
    is_resolvable = property(is_resolvable)

    def __int__(self):
        if self._c in '1H':
            return 1
        if self._c in '0L':
            return 0
        raise ValueError(f"Cannot convert Logic {self._c!r} to int")
    __index__ = __int__

    def __bool__(self):
        return bool(int(self))

    def __str__(self):
        return self._c

    def __repr__(self):
        return f"Logic({self._c!r})"

    def __eq__(self, o):
        if isinstance(o, Logic):
            return self._c == o._c
        if isinstance(o, LogicArray):
            return len(o) == 1 and o._bits == self._c
        if isinstance(o, str):
            return o.upper() == self._c if len(o) == 1 else False
        if isinstance(o, (int, bool)):
            return self.is_resolvable and int(self) == int(o)
        return NotImplemented

    def __hash__(self):
        return hash(self._c)

    def __and__(self, o): return Logic(int(self) & int(Logic(o)))
    def __or__(self, o): return Logic(int(self) | int(Logic(o)))
    def __xor__(self, o): return Logic(int(self) ^ int(Logic(o)))
    def __invert__(self): return Logic(1 - int(self))


class Range:
    """An HDL index range such as 7 downto 0."""

    def __init__(self, left, direction='downto', right=None):
        if right is None:
            right, direction = direction, ('downto' if left >= direction else 'to')
        self.left, self.direction, self.right = left, direction, right

    def __len__(self):
        return abs(self.left - self.right) + 1

    def __iter__(self):
        step = -1 if self.direction == 'downto' else 1
        return iter(range(self.left, self.right + step, step))

    def index(self, i):
        """Position of index i counted from the left (MSB) end."""
        p = (self.left - i) if self.direction == 'downto' else (i - self.left)
        if not 0 <= p < len(self):
            raise IndexError(f"index {i} out of range {self!r}")
        return p

    def __eq__(self, o):
        return isinstance(o, Range) and (self.left, self.direction, self.right) == (o.left, o.direction, o.right)

    def __repr__(self):
        return f"Range({self.left}, {self.direction!r}, {self.right})"


class LogicArray:
    """An array of bits, MSB first (also usable like cocotb 1.x BinaryValue)."""
    __slots__ = ('_bits', 'range')

    def __init__(self, value, range=None):
        n = len(range) if isinstance(range, Range) else range
        if isinstance(value, LogicArray):
            bits = value._bits
        elif isinstance(value, Logic):
            bits = value._c
        elif isinstance(value, str):
            if not value or any(c not in _BITCH for c in value):
                raise ValueError(f"{value!r} is not a valid binary string")
            bits = ''.join(c.upper() if c in 'xzuwlh' else c for c in value)
        elif isinstance(value, (int, bool)):
            if n is None:
                raise TypeError("LogicArray(int) needs a width or range")
            bits = _int_bits(int(value), n)
        elif hasattr(value, '__iter__'):
            bits = ''.join(str(Logic(x)) for x in value)
        else:
            raise TypeError(f"cannot make a LogicArray from {type(value).__name__}")
        if n is not None and len(bits) != n:
            raise ValueError(f"value has {len(bits)} bits, range has {n}")
        self._bits = bits
        self.range = range if isinstance(range, Range) else Range(len(bits) - 1, 'downto', 0)

    @classmethod
    def from_unsigned(cls, v, width):
        if v < 0:
            raise OverflowError(f"{v} is negative")
        return cls(v, width)

    @classmethod
    def from_signed(cls, v, width):
        return cls(v, width)

    def __len__(self):
        return len(self._bits)

    @property
    def binstr(self):
        return self._bits

    @property
    def is_resolvable(self):
        return all(c in '01LH' for c in self._bits)

    def to_unsigned(self):
        if not self.is_resolvable:
            raise ValueError(f"Unresolvable bit in binary string: {self._bits!r}")
        return int(self._bits.replace('L', '0').replace('H', '1'), 2)

    def to_signed(self):
        v = self.to_unsigned()
        return v - (1 << len(self)) if self._bits and self._bits[0] in '1H' else v

    integer = property(to_unsigned)
    signed_integer = property(to_signed)
    __int__ = to_unsigned
    __index__ = to_unsigned

    def __bool__(self):
        return self.to_unsigned() != 0

    def __str__(self):
        return self._bits

    def __repr__(self):
        return f"LogicArray({self._bits!r})"

    def __iter__(self):
        return (Logic(c) for c in self._bits)

    def __getitem__(self, i):
        if isinstance(i, slice):
            a, b = self.range.index(i.start), self.range.index(i.stop)
            if a > b:
                raise IndexError("slice direction does not match the range")
            return LogicArray(self._bits[a:b + 1], Range(i.start, self.range.direction, i.stop))
        return Logic(self._bits[self.range.index(i)])

    def _cmp_int(self):
        return self.to_unsigned() if self.is_resolvable else None

    def __eq__(self, o):
        if isinstance(o, LogicArray):
            return self._bits == o._bits
        if isinstance(o, Logic):
            return len(self) == 1 and self._bits == o._c
        if isinstance(o, str):
            return self._bits == o.upper() if all(c in _BITCH for c in o) else False
        if isinstance(o, (int, bool)):
            if not self.is_resolvable:
                return False
            return (self.to_signed() if o < 0 else self.to_unsigned()) == o
        return NotImplemented

    def __hash__(self):
        return hash(self._bits)

    def __lt__(self, o): return int(self) < int(o)
    def __le__(self, o): return int(self) <= int(o)
    def __gt__(self, o): return int(self) > int(o)
    def __ge__(self, o): return int(self) >= int(o)
    def __add__(self, o): return int(self) + int(o)
    __radd__ = __add__
    def __sub__(self, o): return int(self) - int(o)
    def __rsub__(self, o): return int(o) - int(self)
    def __mul__(self, o): return int(self) * int(o)
    __rmul__ = __mul__
    def __and__(self, o): return int(self) & int(o)
    def __or__(self, o): return int(self) | int(o)
    def __xor__(self, o): return int(self) ^ int(o)
    def __lshift__(self, n): return int(self) << n
    def __rshift__(self, n): return int(self) >> n
    def __invert__(self): return LogicArray(''.join({'0': '1', '1': '0'}.get(c, 'X') for c in self._bits))


BinaryValue = LogicArray


def _int_bits(v, n):
    if not -(1 << (n - 1) if n else 0) <= v < (1 << n):
        raise OverflowError(f"value {v} does not fit in {n} bits")
    return format(v & ((1 << n) - 1), f'0{n}b') if n else ''


# ------------------------------------------------------------------ handles
class Deposit:
    _action = 0

    def __init__(self, value):
        self.value = value


class Force(Deposit):
    _action = 1


class Release(Deposit):
    _action = 2

    def __init__(self):
        self.value = None


class Freeze(Deposit):
    _action = 3

    def __init__(self):
        self.value = None


Immediate = Deposit


class SimHandleBase:
    def __init__(self, hid, name, path):
        self._handle, self._name, self._path = hid, name, path

    def __repr__(self):
        return f"{type(self).__name__}({self._path})"

    def __hash__(self):
        return hash(self._path)

    def __eq__(self, o):
        return isinstance(o, SimHandleBase) and o._path == self._path

    @property
    def _log(self):
        return logging.getLogger(f"cocotb.{self._path.replace('/', '.').strip('.')}")


def _make(info, name, path):
    k = info.kind
    if k == 'scope':
        return HierarchyObject(info.id, name, path)
    if k == 'genarray':
        return HierarchyArrayObject(info.id, name, path)
    if k == 'mem':
        return ArrayObject(info.id, name, path, info.w, info.lo, info.hi)
    return LogicObject(info.id, name, path, info.w, bool(info.signed), k)


class HierarchyObject(SimHandleBase):
    def __init__(self, hid, name, path):
        super().__init__(hid, name, path)
        self._sub = {}

    def _id(self, name, extended=True):
        h = self._sub.get(name)
        if h is None:
            info = _w.lookup(self._handle, name)
            if info is None:
                raise AttributeError(f"{self._path} contains no object named {name}")
            h = self._sub[name] = _make(info, name, f"{self._path}/{name}")
        return h

    def __getattr__(self, name):
        if name.startswith('__') or name.startswith('_'):
            raise AttributeError(name)
        return self._id(name)

    def __getitem__(self, name):
        return self._id(name)

    def __iter__(self):
        return (self._id(n) for n in _w.names(self._handle).to_py())

    def __dir__(self):
        return list(_w.names(self._handle).to_py())


class HierarchyArrayObject(SimHandleBase):
    """Generate-block instances name[0], name[1], ..."""

    def __getitem__(self, i):
        parent = self._handle
        for n in (f"{self._name}[{i}]", f"{self._name}({i})"):
            info = _w.lookup(parent, n)
            if info is not None:
                return _make(info, n, self._path.rsplit('/', 1)[0] + '/' + n)
        raise IndexError(f"{self._path} has no element {i}")

    def __len__(self):
        return sum(1 for n in _w.names(self._handle).to_py() if n.startswith(self._name + '[') or n.startswith(self._name + '('))


class ValueObjectBase(SimHandleBase):
    _idx = -1

    def _read(self):
        return _w.get(self._handle, self._idx)

    @property
    def value(self):
        bits = self._read()
        if self._kind == 'int':
            v = int(bits, 2) if all(c in '01' for c in bits) else 0
            return v - (1 << len(bits)) if bits[0] == '1' else v
        return Logic(bits) if self._kind == 'bit' else LogicArray(bits)

    @value.setter
    def value(self, v):
        _sched.write(self, v)

    def setimmediatevalue(self, v):
        action, bits = self._convert(v)
        _w.put(self._handle, self._idx, bits, action)

    def set(self, v):
        self.value = v

    def get(self):
        return self.value

    def __len__(self):
        return self._w

    def _convert(self, v):
        action = 0
        if isinstance(v, Deposit):
            action, v = v._action, v.value
            if v is None:
                return action, ''
        n = self._w
        if isinstance(v, (Logic, LogicArray)):
            bits = str(v)
            if len(bits) < n:
                bits = '0' * (n - len(bits)) + bits
        elif isinstance(v, (bool, int)):
            bits = _int_bits(int(v), n)
        elif isinstance(v, str) and v and all(c in _BITCH for c in v):
            bits = v
        else:
            raise TypeError(f"cannot assign {v!r} to {self._path}")
        if len(bits) != n:
            raise ValueError(f"cannot assign {len(bits)} bits to {self._path} ({n} bits)")
        return action, bits


class LogicObject(ValueObjectBase):
    def __init__(self, hid, name, path, w, signed, kind):
        super().__init__(hid, name, path)
        self._w, self._signed, self._kind = w, signed, kind

    def __getitem__(self, i):
        raise TypeError(f"{self._path}: index the value instead ({self._name}.value[{i}])")


class ArrayObject(SimHandleBase):
    """A memory (unpacked array); elements are writable handles."""

    def __init__(self, hid, name, path, w, lo, hi):
        super().__init__(hid, name, path)
        self._w, self._lo, self._hi = w, lo, hi
        self.range = Range(lo, 'to', hi)

    def __len__(self):
        return self._hi - self._lo + 1

    def __getitem__(self, i):
        if not self._lo <= i <= self._hi:
            raise IndexError(f"{self._path}[{i}] is out of range {self._lo}..{self._hi}")
        e = _MemElem(self._handle, f"{self._name}[{i}]", f"{self._path}[{i}]")
        e._idx, e._w, e._kind = i, self._w, 'vec'
        return e

    def __iter__(self):
        return (self[i] for i in range(self._lo, self._hi + 1))

    @property
    def value(self):
        return [e.value for e in self]


class _MemElem(ValueObjectBase):
    pass


# ------------------------------------------------------------------ triggers
_toks = {}
_next_tok = [0]


def _tok(obj):
    _next_tok[0] += 1
    _toks[_next_tok[0]] = obj
    return _next_tok[0]


class Trigger:
    """Something a coroutine can await. Callbacks run once when it fires."""

    def __init__(self):
        self._cbs = []
        self._armed = False

    def _arm(self, cb):
        self._cbs.append(cb)
        if not self._armed:
            self._armed = True
            self._prime()

    def _disarm(self, cb):
        if cb in self._cbs:
            self._cbs.remove(cb)
        if not self._cbs and self._armed:
            self._armed = False
            self._unprime()

    def _fire(self, result=None):
        self._armed = False
        cbs, self._cbs = self._cbs, []
        for cb in cbs:
            cb(self if result is None else result)

    def _prime(self):
        pass

    def _unprime(self):
        pass

    def __await__(self):
        r = yield self
        return r


class _GpiTrigger(Trigger):
    _tok = None

    def _prime(self):
        self._tok = _tok(self)
        self._register(self._tok)

    def _unprime(self):
        if self._tok is not None:
            _w.cancel(self._tok)
            _toks.pop(self._tok, None)
            self._tok = None


class Timer(_GpiTrigger):
    def __init__(self, time=None, unit='step', units=None, round_mode=None, time_ps=None):
        super().__init__()
        if time is None:
            time, unit = time_ps, 'ps'
        self._fs = _to_fs(time, _unit(unit, units))
        if self._fs < 0:
            raise ValueError("Timer value must be >= 0")

    def _register(self, tok):
        _w.timer(self._fs, tok)

    def __repr__(self):
        return f"Timer({self._fs / 1e6}ns)"


class _EdgeBase(_GpiTrigger):
    _kind = 0

    def __init__(self, signal):
        super().__init__()
        if not isinstance(signal, ValueObjectBase):
            raise TypeError(f"{type(self).__name__} needs a signal, got {signal!r}")
        self.signal = signal

    def _register(self, tok):
        _w.edge(self.signal._handle, self.signal._idx, self._kind, tok)

    def __repr__(self):
        return f"{type(self).__name__}({self.signal._path})"


class Edge(_EdgeBase):
    _kind = 0


ValueChange = Edge


class RisingEdge(_EdgeBase):
    _kind = 1


class FallingEdge(_EdgeBase):
    _kind = 2


class ReadWrite(_GpiTrigger):
    def _register(self, tok):
        if _sched.readonly:
            raise RuntimeError("Attempted to await ReadWrite during the ReadOnly phase")
        _w.rw(tok)


class ReadOnly(_GpiTrigger):
    def _register(self, tok):
        _w.ro(tok)


class NextTimeStep(_GpiTrigger):
    def _register(self, tok):
        _w.next(tok)


class NullTrigger(_GpiTrigger):
    def __init__(self, name=None, outcome=None):
        super().__init__()

    def _register(self, tok):
        _w.soon(tok)


class _Now(Trigger):
    """Resume after the tasks that are already ready (used by cocotb.start)."""

    def _prime(self):
        _sched.ready.append((self._fire, None))


class ClockCycles(Trigger):
    def __init__(self, signal, num_cycles, rising=True, edge_type=None):
        super().__init__()
        if edge_type is not None:
            rising = edge_type is RisingEdge
        self.signal, self.num_cycles = signal, num_cycles
        self._edge = (RisingEdge if rising else FallingEdge)(signal)

    def _prime(self):
        self._n = 0
        if self.num_cycles <= 0:
            _sched.ready.append((self._fire, None))
        else:
            self._edge._arm(self._step)

    def _step(self, _):
        self._n += 1
        if self._n >= self.num_cycles:
            self._fire()
        else:
            self._edge._arm(self._step)

    def _unprime(self):
        self._edge._disarm(self._step)


def _as_trigger(x):
    if isinstance(x, Trigger):
        return x
    if isinstance(x, Task):
        return x.complete
    if inspect.iscoroutine(x):
        return start_soon(x).complete
    raise TypeError(f"{x!r} is not a trigger, task or coroutine")


class First(Trigger):
    def __init__(self, *triggers):
        super().__init__()
        self.triggers = [_as_trigger(t) for t in triggers]

    def _prime(self):
        for t in self.triggers:
            t._arm(self._hit)

    def _hit(self, r):
        for t in self.triggers:
            t._disarm(self._hit)
        self._fire(r)

    def _unprime(self):
        for t in self.triggers:
            t._disarm(self._hit)

    def __await__(self):
        r = yield self
        if isinstance(r, _TaskDone):
            return r.task.result()
        return r


class Combine(Trigger):
    def __init__(self, *triggers):
        super().__init__()
        self.triggers = [_as_trigger(t) for t in triggers]

    def _prime(self):
        self._left, self._hits = set(range(len(self.triggers))), {}
        for i, t in enumerate(self.triggers):
            t._arm(self._hitter(i))

    def _hitter(self, i):
        def hit(_):
            self._left.discard(i)
            if not self._left:
                self._fire()
        self._hits[i] = hit
        return hit

    def _unprime(self):
        for i, t in enumerate(self.triggers):
            if i in self._hits:
                t._disarm(self._hits[i])


class _TaskDone(Trigger):
    def __init__(self, task):
        super().__init__()
        self.task = task

    def _prime(self):
        if self.task.done():
            _sched.ready.append((self._fire, None))

    def __await__(self):
        r = yield self
        return r


Join = lambda task: task.complete  # noqa: E731  (cocotb 1.x spelling)


class Event:
    def __init__(self, name=None):
        self.name, self.data, self._set, self._waiters = name, None, False, []

    def set(self, data=None):
        self._set, self.data = True, data
        w, self._waiters = self._waiters, []
        for t in w:
            if t._armed:
                t._fire()

    def clear(self):
        self._set = False

    def is_set(self):
        return self._set

    def wait(self):
        return _EventWait(self)


class _EventWait(Trigger):
    def __init__(self, ev):
        super().__init__()
        self.event = ev

    def _prime(self):
        if self.event._set:
            _sched.ready.append((self._fire, None))
        else:
            self.event._waiters.append(self)

    def _unprime(self):
        if self in self.event._waiters:
            self.event._waiters.remove(self)


class Lock:
    def __init__(self, name=None):
        self.locked, self._q = False, []

    async def acquire(self):
        while self.locked:
            e = Event()
            self._q.append(e)
            await e.wait()
        self.locked = True

    def release(self):
        self.locked = False
        if self._q:
            self._q.pop(0).set()

    async def __aenter__(self):
        await self.acquire()
        return self

    async def __aexit__(self, *a):
        self.release()


class SimTimeoutError(TimeoutError):
    pass


async def with_timeout(trigger, timeout_time, timeout_unit='step', round_mode=None):
    t = Timer(timeout_time, timeout_unit)
    trig = _as_trigger(trigger)
    r = await First(trig, t)
    if r is t:
        if isinstance(trig, _TaskDone):
            trig.task.cancel()
        raise SimTimeoutError(f"timed out after {timeout_time} {timeout_unit}")
    return r


# ------------------------------------------------------------------ tasks
class TestFailure(AssertionError):
    pass


class TestSuccess(Exception):
    pass


class Task:
    _ids = 0

    def __init__(self, coro, name=None):
        if not inspect.iscoroutine(coro):
            raise TypeError(f"{coro!r} is not a coroutine (call the async function: f(...))")
        Task._ids += 1
        self._coro, self._name = coro, name or getattr(coro, '__qualname__', 'task')
        self._done, self._cancelled, self._result, self._exc = False, False, None, None
        self._trigger = self._cb = None
        self._started = False
        self.complete = _TaskDone(self)

    def __repr__(self):
        return f"<Task {self._name}{' done' if self._done else ''}>"

    def _advance(self, val=None, exc=None):
        self._started = True
        self._trigger = None
        prev, _sched.current = _sched.current, self
        try:
            t = self._coro.throw(exc) if exc is not None else self._coro.send(val)
        except StopIteration as e:
            self._finish(e.value, None)
            return
        except BaseException as e:  # noqa: BLE001 - reported as a test failure
            self._finish(None, e)
            return
        finally:
            _sched.current = prev
        if isinstance(t, Trigger):
            self._trigger, self._cb = t, (lambda r: _sched.ready.append((self, r)))
            t._arm(self._cb)
        else:
            _sched.ready.append((self, TypeError(f"coroutine yielded {t!r}, which is not a trigger")))

    def _finish(self, result, exc):
        self._done, self._result, self._exc = True, result, exc
        awaited = bool(self.complete._cbs)
        if self.complete._armed:
            self.complete._fire()
        # an exception nobody awaits fails the test (an awaiting task gets it from result())
        if exc is not None and (not awaited or self is _reg.main):
            _reg.task_failed(self, exc)

    def kill(self):
        if self._done:
            return
        if self._trigger is not None:
            self._trigger._disarm(self._cb)
            self._trigger = None
        self._coro.close()
        self._done, self._cancelled = True, True
        if self.complete._armed:
            self.complete._fire()

    def cancel(self, msg=None):
        self.kill()

    def done(self):
        return self._done

    def cancelled(self):
        return self._cancelled

    def result(self):
        if self._cancelled:
            raise RuntimeError(f"{self._name} was cancelled")
        if self._exc is not None:
            raise self._exc
        return self._result

    def exception(self):
        return self._exc

    def join(self):
        return self.complete

    def __await__(self):
        if not self._done:
            yield self.complete
        return self.result()


class _Scheduler:
    def __init__(self):
        self.ready = collections.deque()
        self.writes = {}
        self.current = None
        self.readonly = False

    def write(self, handle, v):
        if self.readonly:
            raise RuntimeError(f"Write to {handle._path} during the ReadOnly phase")
        self.writes[handle._path] = (handle, handle._convert(v))

    def run(self):
        while self.ready:
            who, val = self.ready.popleft()
            if isinstance(who, Task):
                if not who._done:
                    if isinstance(val, BaseException):
                        who._advance(None, val)
                    else:
                        who._advance(val)
            else:
                who()
        if self.writes:
            w, self.writes = self.writes, {}
            for h, (action, bits) in w.values():
                _w.put(h._handle, h._idx, bits, action)


_sched = _Scheduler()


def start_soon(coro, *, name=None):
    if isinstance(coro, Task):
        t = coro
    else:
        t = Task(coro, name)
    if not t._started and not t._done:
        t._started = True
        _sched.ready.append((t, None))
        _reg.tasks.append(t)
    return t


async def start(coro, *, name=None):
    t = start_soon(coro, name=name)
    await _Now()
    return t


def create_task(coro, *, name=None):
    return Task(coro, name)


fork = start_soon


# ------------------------------------------------------------------ clock
class Clock:
    def __init__(self, signal, period, unit='step', units=None, impl=None):
        self.signal, self.unit = signal, _unit(unit, units)
        self.period = _to_fs(period, self.unit)
        if self.period < 2:
            raise ValueError("Clock period is too short")
        self._task = None

    def start(self, start_high=True, cycles=None):
        """Starts toggling the signal (in the simulator kernel) and returns a running task."""
        clk = self

        async def run():
            tok = _tok(None)
            _w.clock(clk.signal._handle, clk.period, clk.period // 2, bool(start_high), tok)
            try:
                if cycles is None:
                    await Event().wait()
                else:
                    await Timer(cycles * clk.period, 'fs')
            finally:
                _w.cancel(tok)
                _toks.pop(tok, None)

        self._task = start_soon(run(), name=f"Clock({self.signal._name})")
        return self._task

    def stop(self):
        if self._task:
            self._task.kill()


# ------------------------------------------------------------------ logging
class _SimFormatter(logging.Formatter):
    def format(self, r):
        t = _w.now() / 1e6
        msg = r.getMessage()
        if r.exc_info:
            msg += '\n' + ''.join(traceback.format_exception(*r.exc_info)).rstrip()
        return '\n'.join(f"{t:>12.2f}ns {r.levelname:<8} {r.name[-34:]:<34} {line}" if i == 0 else f"{'':>57}{line}" for i, line in enumerate(msg.split('\n')))


class _SimHandler(logging.Handler):
    def emit(self, r):
        kind = 'err' if r.levelno >= logging.ERROR else 'warn' if r.levelno >= logging.WARNING else 'out'
        _w.log(self.format(r), kind)


log = logging.getLogger('cocotb')
log.propagate = False
log.handlers[:] = [_SimHandler()]
log.handlers[0].setFormatter(_SimFormatter())
log.setLevel(logging.INFO)


# ------------------------------------------------------------------ tests and regression
class _Test:
    def __init__(self, f, timeout_time=None, timeout_unit='step', expect_fail=False, expect_error=(), skip=False, stage=0, name=None, **kw):
        if not inspect.iscoroutinefunction(f):
            raise TypeError(f"@cocotb.test can only decorate async functions, not {f!r}")
        self.func, self.name = f, name or f.__name__
        self.timeout = None if timeout_time is None else _to_fs(timeout_time, timeout_unit)
        self.expect_fail, self.skip, self.stage = expect_fail, skip, stage
        self.expect_error = expect_error if isinstance(expect_error, tuple) else (expect_error,) if expect_error else ()
        self.__doc__ = f.__doc__

    def __call__(self, *a, **k):
        return self.func(*a, **k)


def test(_func=None, **kw):
    if _func is not None:
        return _Test(_func)
    return lambda f: _Test(f, **kw)


class _Regression:
    def __init__(self):
        self.tests, self.results, self.tasks = [], [], []
        self.index, self.main, self.module, self.done = -1, None, '', False
        self.timeout_trig = None

    def _out(self, msg, kind='out'):
        _w.log(msg, kind)

    def start(self):
        self.t0 = _time.time()
        self.next()

    def next(self):
        self.index += 1
        while self.index < len(self.tests) and self.tests[self.index].skip:
            t = self.tests[self.index]
            log.getChild('regression').info(f"skipping {self.module}.{t.name} ({self.index + 1}/{len(self.tests)})")
            self.results.append((t.name, 'SKIP', 0, 0.0))
            self.index += 1
        if self.index >= len(self.tests):
            self.finish()
            return
        t = self.tests[self.index]
        log.getChild('regression').info(f"running {self.module}.{t.name} ({self.index + 1}/{len(self.tests)})")
        self.test_t0, self.test_sim0 = _time.time(), _w.now()
        self.tasks = []
        try:
            coro = t.func(top)
        except BaseException as e:  # noqa: BLE001
            self.end(e)
            return
        self.main = start_soon(coro, name=t.name)
        if t.timeout is not None:
            self.timeout_trig = Timer(t.timeout, 'fs')
            self.timeout_trig._arm(self._timeout)

    def _timeout(self, _):
        self.end(SimTimeoutError(f"test timed out after {self.tests[self.index].timeout / 1e6} ns"))

    def task_failed(self, task, exc):
        if self.main is None or self.done:
            return
        self.end(exc)

    def check(self):
        """Called after each scheduler run: did the test's main task finish?"""
        if self.main is not None and self.main._done and self.main._exc is None:
            self.end(None)

    def end(self, exc):
        t = self.tests[self.index]
        main, self.main = self.main, None
        if self.timeout_trig is not None:
            self.timeout_trig._disarm(self._timeout)
            self.timeout_trig = None
        for task in self.tasks:
            if task is not main:
                task.kill()
        _sched.ready.clear()
        if isinstance(exc, TestSuccess):
            exc = None
        passed = exc is None
        if t.expect_error and exc is not None and isinstance(exc, t.expect_error):
            passed, exc = True, None
        elif t.expect_fail:
            passed = not passed
        sim = _w.now() - self.test_sim0
        status = 'PASS' if passed else 'FAIL'
        rl = log.getChild('regression')
        if exc is not None and not passed:
            self._report(exc)
        if passed:
            rl.info(f"{self.module}.{t.name} {'failed as expected' if t.expect_fail and exc is not None else 'passed'}")
        else:
            rl.error(f"{self.module}.{t.name} failed" + ('' if exc is not None else ' (expected to fail)'))
        self.results.append((t.name, status, sim, _time.time() - self.test_t0))
        _sched.writes.clear()
        _w.soon(_tok(_Call(self.next)))

    def _report(self, exc):
        tb = traceback.extract_tb(exc.__traceback__)
        frames = [f for f in tb if '/websim_py/' not in f.filename]
        lines = (['Traceback (most recent call last):'] if frames else []) + [l.rstrip('\n') for l in traceback.format_list(frames)]
        lines += [l.rstrip('\n') for l in traceback.format_exception_only(type(exc), exc)]
        for l in '\n'.join(lines).split('\n'):
            self._out(l, 'err')

    def sim_ended(self, reason):
        if self.done:
            return
        if self.main is not None:
            self.end(RuntimeError(f"the simulation {reason} before the test finished"))
        # the remaining tests cannot run
        while self.index + 1 < len(self.tests):
            self.index += 1
            self.results.append((self.tests[self.index].name, 'FAIL', 0, 0.0))
        self.finish(stop=False)

    def finish(self, stop=True):
        if self.done:
            return
        self.done = True
        n = len(self.results)
        npass = sum(1 for r in self.results if r[1] == 'PASS')
        nfail = sum(1 for r in self.results if r[1] == 'FAIL')
        w = max([len(f"{self.module}.{r[0]}") for r in self.results] + [4])
        self._out(f"** cocotb: {'TEST':<{w}}  STATUS  SIM TIME (ns)  REAL TIME (s)")
        for name, st, sim, real in self.results:
            self._out(f"**         {self.module + '.' + name:<{w}}  {st:<6}  {sim / 1e6:>13.2f}  {real:>13.2f}", 'out' if st != 'FAIL' else 'err')
        self._out(f"** cocotb: TESTS={n} PASS={npass} FAIL={nfail} SKIP={n - npass - nfail}", 'err' if nfail else 'note')
        _w.done(nfail)
        if stop:
            _w.finish()


class _Call(Trigger):
    def __init__(self, f):
        super().__init__()
        self.f = f


_reg = _Regression()
top = None


def _dispatch(tok, phase):
    obj = _toks.pop(tok, None)
    if obj is None:
        return
    _sched.readonly = phase == 'ro'
    try:
        if isinstance(obj, _Call):
            obj.f()
        else:
            obj._tok = None
            obj._fire()
        _sched.run()
        _reg.check()
    finally:
        _sched.readonly = False


def _start_token():
    return _tok(_Call(_reg.start))


def _sim_ended(reason):
    _reg.sim_ended(reason)
    _sched.ready.clear()
    _sched.writes.clear()


def _init(module, top_info, testcases):
    global top
    top = HierarchyObject(top_info.id, top_info.name, top_info.path)
    mod = __import__(module)
    for part in module.split('.')[1:]:
        mod = getattr(mod, part)
    tests = [v for v in vars(mod).values() if isinstance(v, _Test)]
    if testcases:
        names = set(testcases)
        missing = names - {t.name for t in tests}
        if missing:
            raise ValueError(f"no test named {', '.join(sorted(missing))} in {module}")
        tests = [t for t in tests if t.name in names]
    tests.sort(key=lambda t: t.stage)
    _reg.tests, _reg.module = tests, module.split('.')[-1]
    return len(tests)
