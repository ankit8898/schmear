#!/usr/bin/env python3
# Probe PA: agy acp in Gemini API key mode with a fake key and a scratch --gemini-dir.
# Usage: agy_key_acp.py <new scratch dir> [agy bin]
# Cases: noauth (session/new without authenticate), abs (absolute --gemini-dir),
#   abs-provider (abs plus antigravity-cli/settings.json {"modelProvider":"gemini"}),
#   rel (--gemini-dir relative to $HOME), nokey (authenticate with GEMINI_API_KEY unset).
#   Prints the auth agy's log says it used, authMethods, config options, the fake
#   prompt's failure, where files landed, then J1 (invalid-key error), J2 (~/.gemini
#   unchanged by path, mtime, size; listings in <scratch>-gemini-{before,after}.txt), J3 (no scratch file contains the key).
import json, os, queue, re, signal, subprocess, sys, threading, time

KEY = "AIzaFAKEschmearProbeKeyNotReal0000000000"
root = os.path.abspath(sys.argv[1])
agy = sys.argv[2] if len(sys.argv) > 2 else "agy"
home = os.path.expanduser("~")
user_gemini = os.path.join(home, ".gemini")
os.makedirs(root)  # must be new: J3 reads every file under it
t0 = time.time()

def out(*a):
    print(f"[+{time.time()-t0:6.1f}s]", *a, flush=True)

def snapshot(top):
    snap = {}
    for d, dirs, files in os.walk(top):
        for n in dirs + files:
            p = os.path.join(d, n)
            st = os.lstat(p)
            snap[p] = (st.st_mtime_ns, st.st_size)
    return snap

class Agent:
    def __init__(self, label, gemini_dir, cwd, key):
        env = {k: v for k, v in os.environ.items() if k not in ("GEMINI_API_KEY", "GOOGLE_API_KEY")}
        env.update(AGY_CLI_DISABLE_AUTO_UPDATE="true", **({"GEMINI_API_KEY": KEY} if key else {}))
        self.label, self.inbox, self.id = label, queue.Queue(), 0
        self.proc = subprocess.Popen([agy, "acp", "--gemini-dir", gemini_dir], cwd=cwd, env=env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=open(os.path.join(root, f"{label}.stderr"), "w"),
                                     text=True, bufsize=1, start_new_session=True)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            try:
                self.inbox.put(json.loads(line))
            except ValueError:
                pass
        self.inbox.put(None)

    def request(self, method, params, timeout=120):
        self.id += 1
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.id, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        deadline, notes = time.time() + timeout, []
        while time.time() < deadline:
            try:
                m = self.inbox.get(timeout=1)
            except queue.Empty:
                continue
            if m is None:
                return {"error": {"message": "agent closed stdout"}}, notes
            if m.get("id") == self.id and "method" not in m:
                return m, notes
            if m.get("method") == "session/update":
                u = m["params"]["update"]
                if u.get("sessionUpdate") == "agent_message_chunk":
                    notes.append(u.get("content", {}).get("text", ""))
            elif "id" in m and m.get("method"):
                self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32601, "message": "Method not found"}}) + "\n")
                self.proc.stdin.flush()
        return {"error": {"message": f"{method} timed out after {timeout}s"}}, notes

    def kill(self):
        try:
            os.killpg(self.proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.proc.wait()

def err(r):
    e = r.get("error") or {}
    return "code=%s message=%r data=%s" % (e.get("code"), str(e.get("message"))[:400], json.dumps(e.get("data"))[:400])

def run(label, gemini_dir, settings=None, auth=True, prompt=True, key=True):
    cwd = os.path.join(root, f"ws-{label}")
    os.makedirs(cwd)
    gd = gemini_dir if os.path.isabs(gemini_dir) else os.path.join(home, gemini_dir)
    if settings is not None:
        os.makedirs(os.path.join(gd, "antigravity-cli"))
        with open(os.path.join(gd, "antigravity-cli", "settings.json"), "w") as f:
            json.dump(settings, f)
    a, res = Agent(label, gemini_dir, cwd, key), {"label": label}
    try:
        r, _ = a.request("initialize", {"protocolVersion": 1, "clientInfo": {"name": "schmear-probe", "version": "0"},
                                        "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False}})
        if "error" in r:
            out(label, "initialize ERROR", err(r)); return res
        res["authMethods"] = [m.get("id") for m in r["result"].get("authMethods", [])]
        out(label, "authMethods=%s" % res["authMethods"])
        if auth:
            r, _ = a.request("authenticate", {"methodId": "gemini-api-key"})
            res["authenticate"] = "ok" if "error" not in r else err(r)
            out(label, "authenticate(gemini-api-key):", res["authenticate"])
        r, _ = a.request("session/new", {"cwd": cwd, "mcpServers": []})
        if "error" in r:
            res["session_new"] = err(r); out(label, "session/new ERROR", res["session_new"]); return res
        res["session_new"] = "ok"
        out(label, "session/new ok")
        for o in r["result"].get("configOptions") or []:
            vals = [x.get("value") for x in o.get("options", []) if "value" in x] or \
                   [y.get("value") for g in o.get("options", []) for y in g.get("options", [])]
            out(label, "configOption id=%s current=%s values=%s" % (o.get("id"), o.get("currentValue"), vals))
        if prompt:
            r, chunks = a.request("session/prompt", {"sessionId": r["result"]["sessionId"],
                                                     "prompt": [{"type": "text", "text": "Hi"}]}, 180)
            res["prompt"] = err(r) if "error" in r else "stopReason=%s reply=%r" % (r["result"].get("stopReason"), "".join(chunks)[:300])
            out(label, "prompt:", res["prompt"])
        return res
    finally:
        a.kill()
        landed = sorted(os.path.relpath(p, gd) for p in snapshot(gd) if os.path.relpath(p, gd).count(os.sep) < 1)
        log = "".join(open(p).read() for p in snapshot(gd) if re.search(r"/log/acp-server-[^/]*\.log$", p))
        # The log names the signed-in email; print only the auth path and mode.
        out(label, "agy log: authenticated via %s, mode %s" % (
            sorted(set(re.findall(r"ChainedAuth: authenticated via (\w+)", log))) or "nothing",
            sorted(set(re.findall(r"cliDir=\"[^\"]*\", mode=([\w-]+)\)", log)))))
        out(label, "top entries in %s: %s; cwd entries: %s" % (gd, landed, os.listdir(cwd)))
        with open(os.path.join(root, f"{label}.stderr")) as f:
            tail = f.read()[-600:].replace(KEY, "<KEY>")
        out(label, "stderr tail: %r" % tail)

before = snapshot(user_gemini)
results = [
    run("noauth", os.path.join(root, "gd-noauth"), auth=False, prompt=False),
    run("abs", os.path.join(root, "gd-abs")),
    run("abs-provider", os.path.join(root, "gd-abs-provider"), settings={"modelProvider": "gemini"}),
    run("rel", os.path.relpath(os.path.join(root, "gd-rel"), home)),
    run("nokey", os.path.join(root, "gd-nokey"), key=False, prompt=False),
]
after = snapshot(user_gemini)
for name, snap in (("before", before), ("after", after)):
    with open(f"{root}-gemini-{name}.txt", "w") as f:
        f.writelines("%d %d %s\n" % (m, n, p) for p, (m, n) in sorted(snap.items()))

stray = subprocess.run(["pgrep", "-f", "agy acp --gemini-dir " + re.escape(root)], capture_output=True, text=True).stdout.split()
out("agy processes left from this probe:", stray or "none")

j1 = {r["label"]: bool(re.search(r"API key not valid|API_KEY_INVALID|invalid api key", r.get("prompt", ""), re.I))
      and not re.search(r"authentication required", r.get("prompt", ""), re.I) for r in results if "prompt" in r}
out("J1 prompt fails with the invalid-key error:", j1)
changed = sorted(p for p in set(before) | set(after) if before.get(p) != after.get(p))
out("J2 ~/.gemini entries before=%d after=%d created/modified/removed=%d %s" % (len(before), len(after), len(changed), changed[:20]))
leaks = []
for p in snapshot(root):
    if os.path.isfile(p) and not os.path.islink(p):
        with open(p, "rb") as f:
            if KEY.encode() in f.read():
                leaks.append(os.path.relpath(p, root))
out("J3 scratch files containing the key:", leaks or "none")
out("PASS" if all(j1.values()) and j1 and not changed and not leaks and not stray else "FAIL")
