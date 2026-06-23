"""Embeddable WebSocket bridge for server-to-client commands and client events.

Install dependency:
    pip install websockets

Typical usage from another Python application's main():
    from websocket_bridge import WebSocketBridge

    def main():
        bridge = WebSocketBridge(host="127.0.0.1", port=8765).start()
        bridge.broadcast("show_message", {"text": "hello"})
        ...
        bridge.stop()
"""

from __future__ import annotations

import asyncio
import inspect
import json
import queue
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable
from urllib.parse import parse_qs, urlparse

try:
    import websockets
except ImportError as exc:  # pragma: no cover - helpful runtime message
    raise RuntimeError("Missing dependency: run `pip install websockets` first.") from exc


JsonDict = dict[str, Any]
EventHandler = Callable[["ClientEvent"], Any | Awaitable[Any]]


@dataclass(frozen=True)
class ClientEvent:
    """A behavior/event message received from a connected client."""

    client_id: str
    action: str
    payload: JsonDict = field(default_factory=dict)
    message_id: str | None = None
    raw: JsonDict = field(default_factory=dict)
    received_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass
class _ClientSession:
    client_id: str
    websocket: Any


class WebSocketBridge:
    """Small WebSocket server that can be embedded into another Python app.

    Message protocol:
      client -> server:
        {"type": "event", "action": "button_clicked", "payload": {...}, "id": "..."}

      server -> client:
        {"type": "command", "action": "open_panel", "payload": {...}, "id": "..."}
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 8765) -> None:
        self.host = host
        self.port = port

        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._server: Any | None = None
        self._started = threading.Event()
        self._start_error: BaseException | None = None

        self._clients: dict[str, _ClientSession] = {}
        self._handlers: dict[str, EventHandler] = {}
        self._default_handler: EventHandler | None = None
        self._events: queue.Queue[ClientEvent] = queue.Queue()

    @property
    def url(self) -> str:
        return f"ws://{self.host}:{self.port}"

    def on(self, action: str, handler: EventHandler) -> None:
        """Register a callback for a client event action."""

        self._handlers[action] = handler

    def on_any(self, handler: EventHandler) -> None:
        """Register a fallback callback for events with no specific handler."""

        self._default_handler = handler

    def start(self, timeout: float = 5.0) -> "WebSocketBridge":
        """Start the WebSocket server in a background thread.

        This is the easiest API for embedding into a normal synchronous main().
        """

        if self._thread and self._thread.is_alive():
            return self

        self._started.clear()
        self._start_error = None
        self._thread = threading.Thread(
            target=self._run_loop,
            name="websocket-bridge",
            daemon=True,
        )
        self._thread.start()

        if not self._started.wait(timeout):
            raise TimeoutError(f"WebSocket server did not start within {timeout} seconds.")
        if self._start_error:
            raise RuntimeError("WebSocket server failed to start.") from self._start_error
        return self

    async def start_async(self) -> "WebSocketBridge":
        """Start inside an existing asyncio application."""

        if self._server:
            return self

        self._loop = asyncio.get_running_loop()
        self._server = await websockets.serve(self._handle_client, self.host, self.port)
        return self

    def stop(self, timeout: float = 5.0) -> None:
        """Stop a background-thread server."""

        if not self._loop:
            return

        future = asyncio.run_coroutine_threadsafe(self.stop_async(), self._loop)
        future.result(timeout=timeout)

        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=timeout)

    async def stop_async(self) -> None:
        """Stop the WebSocket server and close all client connections."""

        for client in list(self._clients.values()):
            await client.websocket.close()
        self._clients.clear()

        if self._server:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

        loop = self._loop
        if loop and loop.is_running() and threading.current_thread() is self._thread:
            loop.call_soon(loop.stop)

    def send(
        self,
        client_id: str,
        action: str,
        payload: JsonDict | None = None,
        timeout: float = 5.0,
    ) -> str:
        """Send one command to a specific client from synchronous code."""

        future = asyncio.run_coroutine_threadsafe(
            self.send_async(client_id, action, payload),
            self._require_loop(),
        )
        return future.result(timeout=timeout)

    async def send_async(
        self,
        client_id: str,
        action: str,
        payload: JsonDict | None = None,
    ) -> str:
        """Send one command to a specific client from async code."""

        client = self._clients.get(client_id)
        if not client:
            raise KeyError(f"Client not connected: {client_id}")

        message_id = str(uuid.uuid4())
        await client.websocket.send(
            json.dumps(
                {
                    "type": "command",
                    "action": action,
                    "payload": payload or {},
                    "id": message_id,
                },
                ensure_ascii=False,
            )
        )
        return message_id

    def broadcast(
        self,
        action: str,
        payload: JsonDict | None = None,
        timeout: float = 5.0,
    ) -> list[str]:
        """Send one command to all connected clients from synchronous code."""

        future = asyncio.run_coroutine_threadsafe(
            self.broadcast_async(action, payload),
            self._require_loop(),
        )
        return future.result(timeout=timeout)

    async def broadcast_async(self, action: str, payload: JsonDict | None = None) -> list[str]:
        """Send one command to all connected clients from async code."""

        message_ids: list[str] = []
        for client_id in list(self._clients):
            try:
                message_ids.append(await self.send_async(client_id, action, payload))
            except KeyError:
                continue
        return message_ids

    def connected_clients(self, timeout: float = 5.0) -> list[str]:
        """Return connected client ids."""

        async def _get_client_ids() -> list[str]:
            return list(self._clients)

        future = asyncio.run_coroutine_threadsafe(_get_client_ids(), self._require_loop())
        return future.result(timeout=timeout)

    def get_event(self, timeout: float | None = None) -> ClientEvent:
        """Block until the next client event arrives.

        This is useful when you prefer polling/consuming events in your own main loop
        instead of registering callbacks with on()/on_any().
        """

        return self._events.get(timeout=timeout)

    def try_get_event(self) -> ClientEvent | None:
        """Return the next client event if available, otherwise None."""

        try:
            return self._events.get_nowait()
        except queue.Empty:
            return None

    async def _handle_client(self, websocket: Any, path: str | None = None) -> None:
        client_id = self._client_id_from_path(websocket, path)
        self._clients[client_id] = _ClientSession(client_id=client_id, websocket=websocket)

        await websocket.send(
            json.dumps(
                {
                    "type": "system",
                    "action": "connected",
                    "payload": {"client_id": client_id},
                    "id": str(uuid.uuid4()),
                },
                ensure_ascii=False,
            )
        )

        try:
            async for raw_message in websocket:
                await self._handle_raw_message(client_id, raw_message)
        finally:
            self._clients.pop(client_id, None)

    async def _handle_raw_message(self, client_id: str, raw_message: str) -> None:
        try:
            data = json.loads(raw_message)
        except json.JSONDecodeError:
            await self.send_async(
                client_id,
                "error",
                {"message": "Message must be valid JSON.", "raw": raw_message},
            )
            return

        action = str(data.get("action") or "")
        if not action:
            await self.send_async(
                client_id,
                "error",
                {"message": "Message requires an `action` field.", "raw": data},
            )
            return

        event = ClientEvent(
            client_id=client_id,
            action=action,
            payload=data.get("payload") or {},
            message_id=data.get("id"),
            raw=data,
        )
        self._events.put(event)

        handler = self._handlers.get(action) or self._default_handler
        if handler:
            await self._call_handler(handler, event)

    async def _call_handler(self, handler: EventHandler, event: ClientEvent) -> None:
        result = handler(event)
        if inspect.isawaitable(result):
            await result

    def _run_loop(self) -> None:
        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)

        async def _start() -> None:
            self._server = await websockets.serve(self._handle_client, self.host, self.port)

        try:
            loop.run_until_complete(_start())
        except BaseException as exc:
            self._start_error = exc
            self._started.set()
            return

        self._started.set()
        try:
            loop.run_forever()
        finally:
            if self._server:
                self._server.close()
                loop.run_until_complete(self._server.wait_closed())
            loop.close()
            self._loop = None

    def _require_loop(self) -> asyncio.AbstractEventLoop:
        if not self._loop:
            raise RuntimeError("WebSocketBridge is not running. Call start() first.")
        return self._loop

    def _client_id_from_path(self, websocket: Any, path: str | None) -> str:
        request_path = path or getattr(websocket, "path", None)
        if request_path is None:
            request = getattr(websocket, "request", None)
            request_path = getattr(request, "path", None)

        if request_path:
            query = parse_qs(urlparse(request_path).query)
            requested_id = query.get("client_id", [None])[0]
            if requested_id:
                return requested_id

        return str(uuid.uuid4())


if __name__ == "__main__":
    bridge = WebSocketBridge().start()
    print(f"WebSocket bridge running at {bridge.url}")
    print("Connect with: ws://127.0.0.1:8765?client_id=demo")
    print("Press Ctrl+C to stop.")

    try:
        while True:
            try:
                event = bridge.get_event(timeout=1.0)
            except queue.Empty:
                continue
            print(f"client={event.client_id} action={event.action} payload={event.payload}")
    except KeyboardInterrupt:
        bridge.stop()
