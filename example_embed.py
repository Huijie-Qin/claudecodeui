"""Example: embed WebSocketBridge into another Python main()."""

from __future__ import annotations

import queue
import time

from websocket_bridge import ClientEvent, WebSocketBridge


def handle_client_event(event: ClientEvent) -> None:
    print(f"[client event] {event.client_id}: {event.action} {event.payload}")


def main() -> None:
    bridge = WebSocketBridge(host="127.0.0.1", port=8765)
    bridge.on_any(handle_client_event)
    bridge.start()

    print(f"WebSocket server started: {bridge.url}")
    print("Client URL example: ws://127.0.0.1:8765?client_id=browser-1")

    try:
        while True:
            clients = bridge.connected_clients()
            if clients:
                bridge.broadcast("set_status", {"text": "server is alive"})

            try:
                event = bridge.get_event(timeout=1.0)
            except queue.Empty:
                event = None

            if event and event.action == "request_time":
                bridge.send(event.client_id, "show_time", {"timestamp": time.time()})

            time.sleep(1.0)
    except KeyboardInterrupt:
        bridge.stop()


if __name__ == "__main__":
    main()
