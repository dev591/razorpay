"""In-process pub/sub with replay, backing the console's live stream.

The problem it solves: `POST /sessions` blocks for 10-20s of real OpenAI
round-trips and then returns everything at once. Every interesting thing —
each vendor's counter-offer, each ledger append, the winner being picked —
already happens in that window, and all of it was being thrown away. The
UI had no way to show a negotiation *happening*, only that one had finished.

Structure:

  * **Ring buffer per topic** — `deque(maxlen=replay_size)`. Bounded by
    construction, so a long-running process can't leak memory through the
    event log, and a client that connects mid-negotiation can be replayed
    the last N events instead of joining blind.
  * **Fan-out queues** — each subscriber gets its own `queue.Queue`, so a
    slow consumer applies backpressure to itself alone. Publishing never
    blocks on a subscriber: a full queue drops that subscriber's oldest
    event rather than stalling the negotiation thread that is publishing.

Every event is also mirrored onto a global firehose topic so the console can
show cross-session activity without opening one connection per session.
"""

import itertools
import queue
import threading
import time
from collections import deque
from typing import Any, Iterator

FIREHOSE = "*"


class EventBus:
    def __init__(self, replay_size: int = 200, subscriber_queue_size: int = 500) -> None:
        self._lock = threading.RLock()
        self._buffers: dict[str, deque[dict[str, Any]]] = {}
        self._subscribers: dict[str, list[queue.Queue]] = {}
        self._replay_size = replay_size
        self._queue_size = subscriber_queue_size
        self._seq = itertools.count(1)

    def publish(self, topic: str, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        event = {
            "seq": next(self._seq),
            "topic": topic,
            "type": event_type,
            "at": time.time(),
            "payload": payload,
        }
        for channel in (topic, FIREHOSE):
            with self._lock:
                buffer = self._buffers.setdefault(
                    channel, deque(maxlen=self._replay_size)
                )
                buffer.append(event)
                subscribers = list(self._subscribers.get(channel, ()))

            for subscriber in subscribers:
                try:
                    subscriber.put_nowait(event)
                except queue.Full:
                    # Never let a stalled browser tab block a negotiation
                    # thread. Drop this subscriber's oldest event and retry
                    # once; if it is still full the client is gone and the
                    # SSE loop will reap it on its next heartbeat.
                    try:
                        subscriber.get_nowait()
                        subscriber.put_nowait(event)
                    except (queue.Empty, queue.Full):
                        pass
        return event

    def history(self, topic: str, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock:
            buffer = self._buffers.get(topic)
            return list(buffer)[-limit:] if buffer else []

    def subscribe(self, topic: str, replay: bool = True) -> tuple[queue.Queue, list[dict[str, Any]]]:
        subscriber: queue.Queue = queue.Queue(maxsize=self._queue_size)
        with self._lock:
            self._subscribers.setdefault(topic, []).append(subscriber)
            backlog = list(self._buffers.get(topic, ())) if replay else []
        return subscriber, backlog

    def unsubscribe(self, topic: str, subscriber: queue.Queue) -> None:
        with self._lock:
            subscribers = self._subscribers.get(topic)
            if not subscribers:
                return
            try:
                subscribers.remove(subscriber)
            except ValueError:
                pass
            if not subscribers:
                self._subscribers.pop(topic, None)

    def stream(
        self,
        topic: str,
        heartbeat_seconds: float = 15.0,
        replay: bool = True,
    ) -> Iterator[dict[str, Any] | None]:
        """Yields events for one subscriber, or `None` as a keepalive tick.

        The caller is responsible for formatting SSE frames; this stays a
        plain iterator of events so it is testable without a web server. The
        `finally` is what actually reaps the subscriber when a browser tab
        closes — FastAPI closes the generator, which raises `GeneratorExit`
        here.
        """
        subscriber, backlog = self.subscribe(topic, replay=replay)
        try:
            for event in backlog:
                yield event
            while True:
                try:
                    yield subscriber.get(timeout=heartbeat_seconds)
                except queue.Empty:
                    yield None
        finally:
            self.unsubscribe(topic, subscriber)

    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {
                "topics": len(self._buffers),
                "subscribers": sum(len(s) for s in self._subscribers.values()),
                "buffered_events": sum(len(b) for b in self._buffers.values()),
                "replay_capacity": self._replay_size,
            }


bus = EventBus()
