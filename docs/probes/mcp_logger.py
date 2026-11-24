#!/usr/bin/env python3
# Minimal stdio MCP server for probes: logs the host's initialize handshake and
# each probe_sleep call (start/end timestamps) as JSON lines to argv[1].
# Each tools/call runs on its own thread so host-side concurrency is observable.
# Optional argv[2] == "ro" marks the tool readOnlyHint=true (tests host scheduling rules).
# probe_elicit sends `count` concurrent form elicitation/create requests mid-call (a single titled
# enum each, as schmear would for ACP permission requests from parallel workers), logs each
# answer and its wait, then sleeps `seconds`.
# Every received message is logged as `recv` (method, id, and the 2026-07-28 _meta protocolVersion/clientInfo).
# Optional argv[3] == "modern" makes this a 2026-07-28-only server: server/discover answers, initialize is
# rejected (-32022), and probe_elicit runs multi-round-trip prompts (input_required rounds, one prompt per
# round, requestState = next round) instead of pushing elicitation/create; each round is logged as `mrtr_round`.
import json, sys, threading, time

log_path = sys.argv[1]
modern = sys.argv[3:4] == ["modern"]
META = "io.modelcontextprotocol/"
answers = []  # modern mode: every inputResponses value received, in order
last_round = [None]  # time of the previous mrtr_round
lock = threading.Lock()
pending = {}  # elicitation request id -> [Event, response]

def log(event, **kw):
    with lock, open(log_path, "a") as f:
        f.write(json.dumps({"t": round(time.time(), 3), "event": event, **kw}) + "\n")

def send(msg):
    with lock:
        sys.stdout.write(json.dumps(msg) + "\n")
        sys.stdout.flush()

TOOLS = [{
    "name": "probe_sleep",
    "description": "Sleeps for the given number of seconds, then returns 'slept N'.",
    "inputSchema": {"type": "object", "properties": {"seconds": {"type": "number"}, "tag": {"type": "string"}},
                    "required": ["seconds"]},
}, {
    "name": "probe_elicit",
    "description": "Asks the user to choose allow or reject (count times at once), sleeps the given seconds, then returns the answers.",
    "inputSchema": {"type": "object", "properties": {"seconds": {"type": "number"}, "count": {"type": "number"}}},
}]
if sys.argv[2:3] == ["ro"]:
    TOOLS[0]["annotations"] = {"readOnlyHint": True}

def form(n):
    return {
        "mode": "form", "message": f"probe worker on 'Probe task {n}' asks: Write ../outside.txt (edit: ../outside.txt)",
        "requestedSchema": {"type": "object", "required": ["option"], "properties": {"option": {
            "type": "string", "title": "Permission",
            "oneOf": [{"const": "allow_once", "title": "Allow"}, {"const": "reject_once", "title": "Reject"}]}}}}

def reply(msg, result):
    if modern:
        result = {"resultType": "complete", **result}
    send({"jsonrpc": "2.0", "id": msg["id"], "result": result})

def ask(msg, n, t0, out):
    eid = f"e{msg['id']}-{n}"; pending[eid] = [threading.Event(), None]
    send({"jsonrpc": "2.0", "id": eid, "method": "elicitation/create", "params": form(n)})
    pending[eid][0].wait()
    r = pending[eid][1]; out[n] = r.get("result", r.get("error"))
    log("elicit_answer", id=msg["id"], n=n, waited=round(time.time() - t0, 1), response=out[n])

def mrtr(msg, s, count):
    p = msg["params"]; meta = p.get("_meta") or {}
    rnd = int(p.get("requestState") or 0)
    now = time.time(); prev, last_round[0] = last_round[0], now
    resp = p.get("inputResponses")
    log("mrtr_round", round=rnd, id=msg["id"], inputResponses=resp, clientInfo=meta.get(META + "clientInfo"),
        elicitation=(meta.get(META + "clientCapabilities") or {}).get("elicitation"),
        since_prev=None if prev is None else round(now - prev, 3))
    answers.extend((resp or {}).values())
    if rnd < count:
        return send({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "resultType": "input_required", "inputRequests": {f"p{rnd}": {"method": "elicitation/create", "params": form(rnd)}},
            "requestState": str(rnd + 1)}})
    time.sleep(s)
    log("call_end", id=msg["id"], tool="probe_elicit")
    reply(msg, {"content": [{"type": "text", "text": "elicit " + json.dumps(answers)}]})

def elicit(msg):
    args = msg["params"].get("arguments") or {}
    s, count = float(args.get("seconds", 0)), int(args.get("count", 1))
    if modern:
        return mrtr(msg, s, count)
    log("call_start", id=msg["id"], tool="probe_elicit", count=count)
    t0, out = time.time(), {}
    ts = [threading.Thread(target=ask, args=(msg, n, t0, out)) for n in range(count)]
    for t in ts: t.start()
    for t in ts: t.join()
    time.sleep(s)
    log("call_end", id=msg["id"], tool="probe_elicit")
    reply(msg, {"content": [{"type": "text", "text": "elicit " + json.dumps(list(out.values()))}]})

def call(msg):
    if msg["params"].get("name") == "probe_elicit":
        return elicit(msg)
    args = msg["params"].get("arguments") or {}
    s, tag = float(args.get("seconds", 1)), args.get("tag", "")
    log("call_start", id=msg["id"], seconds=s, tag=tag)
    time.sleep(s)
    log("call_end", id=msg["id"], seconds=s, tag=tag)
    reply(msg, {"content": [{"type": "text", "text": f"slept {s:g} {tag}"}]})

for line in sys.stdin:
    if not line.strip():
        continue
    msg = json.loads(line)
    m = msg.get("method")
    meta = (msg.get("params") or {}).get("_meta") or {}
    log("recv", method=m, id=msg.get("id"), protocolVersion=meta.get(META + "protocolVersion"),
        clientInfo=meta.get(META + "clientInfo"))
    if m is None and msg.get("id") in pending:
        pending[msg["id"]][1] = msg; pending[msg["id"]][0].set()
    elif modern and m == "server/discover":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "resultType": "complete", "supportedVersions": ["2026-07-28"], "capabilities": {"tools": {}},
            "_meta": {META + "serverInfo": {"name": "probe", "version": "0"}}, "ttlMs": 0, "cacheScope": "private"}})
    elif modern and m == "initialize":
        send({"jsonrpc": "2.0", "id": msg["id"], "error": {
            "code": -32022, "message": "Unsupported protocol version",
            "data": {"supported": ["2026-07-28"], "requested": (msg.get("params") or {}).get("protocolVersion")}}})
    elif m == "initialize":
        p = msg.get("params", {})
        import os
        log("initialize", clientInfo=p.get("clientInfo"), protocolVersion=p.get("protocolVersion"),
            capabilities=sorted((p.get("capabilities") or {}).keys()), elicitation=(p.get("capabilities") or {}).get("elicitation"),
            inherited_marker=os.environ.get("BROKER_PROBE_MARK"), cwd=os.getcwd())
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "protocolVersion": p.get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {}}, "serverInfo": {"name": "probe", "version": "0"}}})
    elif m == "tools/list":
        log("tools_list")
        reply(msg, {"tools": TOOLS, **({"ttlMs": 0, "cacheScope": "private"} if modern else {})})
    elif m == "tools/call":
        threading.Thread(target=call, args=(msg,), daemon=True).start()
    elif m == "ping":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {}})
    elif "id" in msg and m:
        send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": "Method not found"}})
    elif m == "notifications/cancelled":
        log("cancelled", params=msg.get("params"))
log("stdin_closed")
