# Builds the tier grid from AA Intelligence Index v5.0.1 per-effort scores (artificialanalysis.ai/models/<id>, read 2026-11-21, 2026-11-23 and 2026-11-24)
# and Epoch ECI 90% intervals (epoch.ai/data/eci_scores.csv, read 2026-11-24).
import json
E = ["low", "medium", "high", "xhigh", "max"]
REF = {1: [19, 25, 30, 35, 36], 2: [26, 31, 42, 50, 55], 3: [35, 48, 52, 57, 59], 4: [54, 56, 62, 62, 65]}
CLAUDE = {1: "haiku", 2: "sonnet", 3: "opus", 4: "fable"}
# Epoch ECI: the Claude anchor's interval low per tier, and each rated model's interval high. A model whose high is
# below the anchor's low is significantly weaker on Epoch, so it fails that tier whatever its AA score. Unrated: AA only.
ECI_FLOOR = {1: 158.18, 2: 163.92, 3: 165.92, 4: 170.04}
ECI_HIGH = {"gpt-6-luna": 158.48, "gpt-6.1-terra": 171.04, "gpt-6.2-astra": 176.94, "grok-4.7": 158.52,
            "gemini-4-carbon": 173.14, "gemini-4-hydrogen": 170.1, "gemini-4-argon": 169.47,
            "claude-opus-5-5": 171.96, "claude-sonnet-5-5": 169.61,
            "glm-5.3": 159.42, "deepseek-v4.1-flash": 161.91, "glm-5.3-flash": 155.78}
# lane -> model -> {effort offered on that lane: AA score or None (unmeasured)}
LANES = {
 "codex": {"gpt-6-luna": dict(low=10, medium=18, high=21, xhigh=23, max=28),
           "gpt-6.1-terra": dict(low=29, medium=38, high=42, xhigh=45, max=51),
           "gpt-6.2-sol": dict(low=41, medium=53, high=55, xhigh=56, max=57),
           "gpt-6.2-astra": dict(low=46, medium=57, high=60, xhigh=62, max=62)},
 "grok": {"grok-4.7": dict(low=31, medium=None, high=35, xhigh=35)},
 "agy-gemini": {"gemini-4-neon": dict(low=44, medium=55, high=60, xhigh=61),
                "gemini-4-carbon": dict(low=54, medium=58, high=60),
                "gemini-4-hydrogen": dict(low=27, medium=41, high=51, xhigh=54)},
 "agy-argon": {"gemini-4-argon": dict(low=None, medium=48, high=50)},
 "agy-3p": {"claude-opus-5-5": dict(low=35, medium=48, high=52),
            "claude-sonnet-5-5": dict(low=26, medium=31, high=42)},
 # open-weight Go models only (AA v5.0.2, read 2026-11-25); the list also carries every rated model Go offers (model-tiers.md §3)
 "opencode-go": {"glm-5.3": dict(low=23, high=None, max=32),
                 "deepseek-v4.1-flash": dict(low=None, high=29, max=32),
                 "glm-5.3-flash": dict(low=None, high=None, max=28)},
}
def lower_bound(eff):  # unmeasured effort takes the nearest lower measured score
    out, last = {}, None
    for e in E:
        if e in eff:
            last = eff[e] if eff[e] is not None else last
            if last is not None: out[e] = last
    return out
grid = {"claude": {str(t): {e: {"model": CLAUDE[t], "effort": e} for e in E} for t in REF}}
for lane, models in LANES.items():
    g = grid[lane] = {}
    for t in REF:
        g[str(t)] = {}
        for i, e in enumerate(E):
            # never below the requested effort, except that a missing effort clamps to the model's highest
            c = [(s, E.index(pe), m, pe) for m, eff in models.items()
                 if ECI_HIGH.get(m, ECI_FLOOR[t]) >= ECI_FLOOR[t]
                 for pe, s in lower_bound(eff).items()
                 if s >= REF[t][i] and E.index(pe) >= min(i, max(E.index(x) for x in eff))]
            g[str(t)][e] = ({"model": min(c)[2], "effort": min(c)[3]} if c else None)
def md(lane):
    rows = ["| tier \\ effort | " + " | ".join(E) + " |", "|---|" + "---|" * 5]
    for t in "1234":
        cells = [("—" if (x := grid[lane][t][e]) is None else f"{x['model']} / {x['effort']}") for e in E]
        rows.append(f"| {t} | " + " | ".join(cells) + " |")
    return "\n".join(rows)
for lane in grid: print("###", lane); print(md(lane)); print()
print(json.dumps(grid, indent=1))
