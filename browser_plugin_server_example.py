"""Server-side example for a browser extension client.

Expected flow:
1. The extension opens ws://127.0.0.1:8765?client_id=<client-id>.
2. After the watched page button is clicked, the extension sends:
   {"type": "event", "action": "button_triggered", "payload": {...}}
3. This server builds data and sends "process_data" back to that client.
4. The extension handles the data and sends "process_done" back.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from websocket_bridge import ClientEvent, WebSocketBridge


bridge = WebSocketBridge(host="127.0.0.1", port=8765)


def build_data(payload: dict[str, Any]) -> dict[str, Any]:
    """Build the payload that should be sent back to the extension."""

    return {
        "source_url": payload.get("url"),
        "page_title": payload.get("title"),
        "created_at": time.time(),
        "items": [
            {"id": "item-1", "label": "First generated item"},
            {"id": "item-2", "label": "Second generated item"},
        ],
    }


async def on_button_triggered(event: ClientEvent) -> None:
    """Handle the browser extension's button click event."""

    job_id = event.payload.get("job_id") or f"job-{int(time.time() * 1000)}"

    try:
        data = await asyncio.to_thread(build_data, event.payload)
    except Exception as exc:
        await bridge.send_async(
            event.client_id,
            "process_error",
            {"job_id": job_id, "error": str(exc)},
        )
        return

    await bridge.send_async(
        event.client_id,
        "process_data",
        {
            "job_id": job_id,
            "data": data,
        },
    )


def on_process_done(event: ClientEvent) -> None:
    """Handle the extension's completion callback."""

    job_id = event.payload.get("job_id")
    ok = bool(event.payload.get("ok"))

    if ok:
        print(f"[done] client={event.client_id} job_id={job_id}")
    else:
        print(
            f"[failed] client={event.client_id} "
            f"job_id={job_id} error={event.payload.get('error')}"
        )


def main() -> None:
    bridge.on("button_triggered", on_button_triggered)
    bridge.on("process_done", on_process_done)
    bridge.start()

    print(f"WebSocket server started: {bridge.url}")
    print("Extension URL example: ws://127.0.0.1:8765?client_id=extension-1")
    print("Press Ctrl+C to stop.")

    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        bridge.stop()


if __name__ == "__main__":
    main()
