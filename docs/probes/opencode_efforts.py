#!/usr/bin/env python3
# For each Go model: session/set_config_option model, print the effort option values. No prompt is sent.
# Usage: opencode_efforts.py <cwd> <opencode-go/model>... (placeholder OPENCODE_API_KEY, Zen provider denied)
import json, subprocess, sys, os
cwd = sys.argv[1]
env = dict(os.environ, OPENCODE_API_KEY="sk-probe-invalid", OPENCODE_CONFIG_CONTENT=json.dumps({"policies":[{"action":"provider.use","resource":"opencode","effect":"deny"}]}))
p = subprocess.Popen(["opencode", "acp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=cwd, env=env, text=True)
n = [0]
def call(method, params):
    n[0] += 1; i = n[0]
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params}) + "\n"); p.stdin.flush()
    while True:
        msg = json.loads(p.stdout.readline())
        if msg.get("id") == i and "method" not in msg: return msg
call("initialize", {"protocolVersion": 1, "clientCapabilities": {}})
sid = call("session/new", {"cwd": cwd, "mcpServers": []})["result"]["sessionId"]
for m in sys.argv[2:]:
    r = call("session/set_config_option", {"sessionId": sid, "configId": "model", "value": m})
    opts = (r.get("result") or {}).get("configOptions") or []
    eff = [o for o in opts if o.get("category") == "thought_level"]
    print(m, "error" in r and r["error"] or "", [x["value"] for x in eff[0]["options"]] if eff else "no effort option", eff[0].get("currentValue") if eff else "")
p.stdin.close(); p.wait(timeout=10)
