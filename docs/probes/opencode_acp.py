#!/usr/bin/env python3
# Opens one ACP session on `opencode acp` and prints initialize + session/new; never sends session/prompt.
# Usage: opencode_acp.py <cwd> [OPENCODE_CONFIG_CONTENT json]
import json, subprocess, sys, os
cwd = sys.argv[1]
env = dict(os.environ)
if len(sys.argv) > 2: env["OPENCODE_CONFIG_CONTENT"] = sys.argv[2]
p = subprocess.Popen(["opencode", "acp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cwd, env=env, text=True)
def call(i, method, params):
    p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params}) + "\n"); p.stdin.flush()
    while True:
        line = p.stdout.readline()
        if not line: return {"eof": p.stderr.read()[-2000:]}
        msg = json.loads(line)
        if msg.get("id") == i and "method" not in msg: return msg
        print("NOTE", json.dumps(msg)[:300])
print(json.dumps(call(1, "initialize", {"protocolVersion": 1, "clientCapabilities": {}}))[:1500])
r = call(2, "session/new", {"cwd": cwd, "mcpServers": []})
res = r.get("result", r)
for o in (res.get("configOptions") or []):
    print("OPT", o["id"], o.get("category"), o.get("currentValue"), [x.get("value") for x in o.get("options", [])][:40])
print("NEW", json.dumps({k: v for k, v in res.items() if k != "configOptions"})[:800])
p.stdin.close(); p.wait(timeout=10)
