#!/usr/bin/env python3
"""Generate dynamic HTTP headers for a Claude Code MCP server."""

import json
import os
import sys


def require_environment_variable(name: str) -> str:
    """Return a required value without ever writing it to stderr."""
    value = os.environ.get(name)
    if value is None or not value.strip():
        print(f"Missing required environment variable: {name}", file=sys.stderr)
        raise SystemExit(2)
    return value


headers = {
    "X-W3-Name": require_environment_variable("W3_NAME"),
    "X-User-Key": require_environment_variable("USER_KEY"),
}

# headersHelper requires stdout to contain only one JSON object whose values
# are strings. Diagnostics must go to stderr so they cannot corrupt this JSON.
sys.stdout.write(json.dumps(headers, ensure_ascii=False, separators=(",", ":")))
