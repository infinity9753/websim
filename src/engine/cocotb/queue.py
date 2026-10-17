import collections
from ._core import Event


class QueueEmpty(Exception):
    pass


class QueueFull(Exception):
    pass


class Queue:
    def __init__(self, maxsize=0):
        self.maxsize, self._q, self._get, self._put = maxsize, collections.deque(), [], []

    def qsize(self): return len(self._q)
    def empty(self): return not self._q
    def full(self): return 0 < self.maxsize <= len(self._q)

    def put_nowait(self, item):
        if self.full():
            raise QueueFull()
        self._q.append(item)
        if self._get:
            self._get.pop(0).set()

    def get_nowait(self):
        if not self._q:
            raise QueueEmpty()
        item = self._q.popleft()
        if self._put:
            self._put.pop(0).set()
        return item

    async def put(self, item):
        while self.full():
            e = Event()
            self._put.append(e)
            await e.wait()
        self.put_nowait(item)

    async def get(self):
        while self.empty():
            e = Event()
            self._get.append(e)
            await e.wait()
        return self.get_nowait()
