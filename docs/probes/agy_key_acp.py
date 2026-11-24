#!/usr/bin/env python3
"""Probe PA and owner check PG: agy acp in Gemini API key mode with a scratch --gemini-dir.

Usage: agy_key_acp.py <new scratch dir> [agy bin]           free, fake key (PA)
       agy_key_acp.py --live <new scratch dir> [agy bin]    owner check PG, real key
--live spends three tiny prompts (gemini-3.8-flash, thought_level low) on $GEMINI_API_KEY.
PG: first note the benefits page, the Cloud credits page and the AI Studio prepaid balance;
run --live; recheck all three at 10 min, 1 h and 24 h.

Free cases: noauth (session/new without authenticate), abs (absolute --gemini-dir),
abs-provider (abs plus antigravity-cli/settings.json {"modelProvider":"gemini"}),
rel (--gemini-dir relative to $HOME), nokey (authenticate with GEMINI_API_KEY unset).
Prints the auth agy's log says it used, authMethods, config options, the fake prompt's
failure, where files landed, then J1 (invalid-key error), J2 (~/.gemini unchanged by
path, mtime, size; listings in <scratch>-gemini-{before,after}.txt), J3 (no scratch file
contains the key).
--live aborts before any prompt unless session/new lists exactly R43's key-mode models,
or if agy's log (polled 5 s) shows the keyring login. It prints per prompt the stopReason, reply length
and last line, then the session/update kinds and _meta keys seen. Emails are redacted;
the key is never printed or written by this script.
"""
import json, os, queue, re, signal, subprocess, sys, threading, time

FAKE_KEY = "AIzaFAKEschmearProbeKeyNotReal0000000000"
KEY_MODE_MODELS = ["gemini-4-neon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-argon",
                   "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.1-pro"]  # R43
args = sys.argv[1:]
if not args or args[0] in ("-h", "--help") or args == ["--live"]:
    print(__doc__); sys.exit(0 if args and args[0] in ("-h", "--help") else 2)
live = args[0] == "--live"
if live:
    args = args[1:]
    KEY = os.environ.get("GEMINI_API_KEY", "")
    if not KEY.strip():
        sys.exit("--live needs a real key in GEMINI_API_KEY; it is unset or empty")
else:
    KEY = FAKE_KEY
root = os.path.abspath(args[0])
agy = args[1] if len(args) > 1 else "agy"
home = os.path.expanduser("~")
user_gemini = os.path.join(home, ".gemini")
os.makedirs(root)  # must be new: J3 reads every file under it, --live reads only its own log
t0 = time.time()
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")

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
        self.label, self.inbox, self.id, self.kinds, self.meta = label, queue.Queue(), 0, set(), set()
        # --live drops agy's stderr so this script never writes anything that might echo the key.
        self.proc = subprocess.Popen([agy, "acp", "--gemini-dir", gemini_dir], cwd=cwd, env=env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL if live else open(os.path.join(root, f"{label}.stderr"), "w"),
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
            for part in (m.get("params"), (m.get("params") or {}).get("update"), m.get("result")):
                if isinstance(part, dict) and isinstance(part.get("_meta"), dict):
                    self.meta.update(part["_meta"])
            if m.get("id") == self.id and "method" not in m:
                return m, notes
            if m.get("method") == "session/update":
                u = m["params"]["update"]
                self.kinds.add(u.get("sessionUpdate"))
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

def redact(text):
    return EMAIL.sub("<email>", text.replace(KEY, "<KEY>"))

def auth_seen(gd):
    log = "".join(open(p, errors="replace").read() for p in snapshot(gd) if re.search(r"/log/acp-server-[^/]*\.log$", p))
    return (sorted(set(re.findall(r"ChainedAuth: authenticated via (\w+)", log))),
            sorted(set(re.findall(r"cliDir=\"[^\"]*\", mode=([\w-]+)\)", log))))

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
        # The log names the signed-in email; print only the auth path and mode.
        out(label, "agy log: authenticated via %s, mode %s" % auth_seen(gd))
        out(label, "top entries in %s: %s; cwd entries: %s" % (gd, landed, os.listdir(cwd)))
        with open(os.path.join(root, f"{label}.stderr")) as f:
            tail = f.read()[-600:].replace(FAKE_KEY, "<KEY>")
        out(label, "stderr tail: %r" % tail)

def free():
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

def live_pg():
    cwd, gd = os.path.join(root, "ws"), os.path.join(root, "gd")
    os.makedirs(cwd)
    a = Agent("live", gd, cwd, True)
    try:
        r, _ = a.request("initialize", {"protocolVersion": 1, "clientInfo": {"name": "schmear-probe", "version": "0"},
                                        "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False}})
        if "error" in r:
            return out("initialize ERROR", redact(err(r)))
        r, _ = a.request("authenticate", {"methodId": "gemini-api-key"})
        if "error" in r:
            return out("ABORT: authenticate failed:", redact(err(r)))
        r, _ = a.request("session/new", {"cwd": cwd, "mcpServers": []})
        if "error" in r:
            return out("ABORT: session/new failed:", redact(err(r)))
        sid = r["result"]["sessionId"]
        models = next(([x.get("value") for x in o.get("options", []) if "value" in x] or
                       [y.get("value") for g in o.get("options", []) for y in g.get("options", [])]
                       for o in r["result"].get("configOptions") or [] if o.get("id") == "model"), None)
        ok = models == KEY_MODE_MODELS
        out("model list %s R43's key-mode list: %s" % ("matches" if ok else "does NOT match", models))
        if not ok:
            return out("ABORT: not in Gemini API key mode; no prompt sent")
        # agy may only flush its log on exit, so the log is a second check, not the gate.
        deadline, seen = time.time() + 5, ([], [])
        while seen == ([], []) and time.time() < deadline:
            time.sleep(1); seen = auth_seen(gd)
        out(redact("agy log: authenticated via %s, mode %s" % seen) if seen != ([], []) else "agy log: no auth line yet")
        if "keyring" in seen[0] or "ccpa" in seen[1]:
            return out("ABORT: agy log shows the keyring login; no prompt sent")
        for cid, value in (("thought_level", "low"), ("model", "gemini-3.8-flash")):
            r, _ = a.request("session/set_config_option", {"sessionId": sid, "configId": cid, "value": value})
            cur = [o.get("currentValue") for o in (r.get("result") or {}).get("configOptions", []) if o.get("id") == cid]
            if "error" in r or cur != [value]:
                return out("ABORT: could not set %s=%s: %s; no prompt sent" % (cid, value, redact(err(r)) if "error" in r else cur))
            out("set %s=%s" % (cid, value))
        for n in range(1, 4):
            r, chunks = a.request("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": "Reply with the single word OK."}]}, 180)
            if "error" in r:
                out("prompt %d ERROR %s" % (n, redact(err(r)))); continue
            reply = "".join(chunks).strip()
            last = reply.splitlines()[-1] if reply else ""
            out("prompt %d stopReason=%s length=%d last line=%r" % (n, r["result"].get("stopReason"), len(reply), redact(last)[:200]))
    finally:
        a.kill()
        out("session/update kinds=%s _meta keys=%s" % (sorted(map(str, a.kinds)), sorted(a.meta)))
        stray = subprocess.run(["pgrep", "-f", "agy acp --gemini-dir " + re.escape(root)], capture_output=True, text=True).stdout.split()
        out("agy processes left from this probe:", stray or "none")

live_pg() if live else free()
