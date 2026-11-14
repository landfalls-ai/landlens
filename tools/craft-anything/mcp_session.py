#!/usr/bin/env python3
"""Run a sequence of Craft Anything tools in one MCP session (one browser, one target).

Usage: mcp_session.py <craft-anything-cli> <steps.json> [--deep] [--allow-run]
steps.json: [{"tool": "web_site_open", "args": {...}}, ...]; {"tool": "__list__"} prints the current tool list
Prints each tool's result as JSON lines on stdout.
"""
import json
import subprocess
import sys


def main() -> int:
    cli, steps_path, *flags = sys.argv[1:]
    steps = json.load(open(steps_path))
    proc = subprocess.Popen([cli, *flags, "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    next_id = 0

    def call(method, params=None, notify=False):
        nonlocal next_id
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        if not notify:
            next_id += 1
            msg["id"] = next_id
        proc.stdin.write(json.dumps(msg) + "\n")
        proc.stdin.flush()
        if notify:
            return None
        while True:
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError("MCP server closed")
            reply = json.loads(line)
            if reply.get("id") == next_id:
                return reply

    call("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                        "clientInfo": {"name": "landlens-driver", "version": "0.1"}})
    call("notifications/initialized", notify=True)
    if steps == "list":
        print(json.dumps(call("tools/list")))
        return 0
    for step in steps:
        if step["tool"] == "__list__":
            print(json.dumps({"tool": "__list__", "reply": call("tools/list")}), flush=True)
            continue
        reply = call("tools/call", {"name": step["tool"], "arguments": step.get("args", {})})
        print(json.dumps({"tool": step["tool"], "reply": reply}), flush=True)
    proc.stdin.close()
    proc.wait(timeout=30)
    return 0


if __name__ == "__main__":
    sys.exit(main())
