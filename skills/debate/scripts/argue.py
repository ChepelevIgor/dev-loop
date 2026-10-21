#!/usr/bin/env python3
"""Aggregate an evidence-based council round.

  argue.py COUNCIL_DIR --round K [--tags ui,state] [--roles-dir ../roles] [--weights weights.json]

Roles come from the library (--roles-dir, default ../roles) and from COUNCIL_DIR/roles/*.md — roles written for
this topic; a topic role with the same name replaces the library one.

Reads round_1..K/<role>.json and writes state_K.json plus state.json.
Convergence compares against state_{K-1}.json, so rerunning a round is safe.
Weights come from --weights or the highest matching role frontmatter tag,
falling back to weight.default.

Computes the grounded attack-graph extension, weighted log-odds support,
Borda ranks and weighted option preferences. Attacks below p=0.5 do not
create edges; low-confidence moves contribute zero rather than reversing
support. Partial moves update an existing ID, preserving other fields.
Convergence considers confidence, content, graph and preference changes.
The resulting scores are heuristics, not calibrated probabilities.
"""
import json, math, argparse, re, sys
from pathlib import Path

def logit(p): p = min(max(float(p), 1e-3), 1 - 1e-3); return math.log(p / (1 - p))
def sigm(x):
    z = math.exp(-abs(x))
    return 1 / (1 + z) if x >= 0 else z / (1 + z)
def warn(s): print("warn: " + s, file=sys.stderr)

def grounded(args, attacks):
    attackers = {a: {x for x, y in attacks if y == a} for a in args}
    S = set()
    while True:
        new = {a for a in args if all(any((y, x) in attacks for y in S) for x in attackers[a])}
        if new == S: return S
        S = new

def role_weights(roles_dirs, tags):
    w = {}
    files = {f.stem: f for d in roles_dirs for f in sorted(Path(d).glob("*.md"))}  # later dirs win: topic roles
    for f in files.values():
        m = re.search(r"^weight:\s*(\{.*\})", f.read_text(), re.M)
        if not m: continue
        d = dict(re.findall(r"(\w+):\s*([\d.]+)", m.group(1)))
        d = {k: float(v) for k, v in d.items()}
        vals = [d[t] for t in tags if t in d]
        w[f.stem] = max(vals) if vals else d.get("default", 1.0)
    return w

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("dir"); ap.add_argument("--round", type=int, required=True)
    ap.add_argument("--tags", default=""); ap.add_argument("--roles-dir", default=str(Path(__file__).parent.parent / "roles")); ap.add_argument("--weights")
    ns = ap.parse_args(); d = Path(ns.dir); K = ns.round
    if K < 1: ap.error("round must be positive")
    tags = [t for t in ns.tags.split(",") if t]
    w = json.loads(Path(ns.weights).read_text()) if ns.weights else role_weights([ns.roles_dir, d / "roles"], tags)

    if not isinstance(w, dict) or any(type(v) not in (int, float) or not math.isfinite(v) or v <= 0 for v in w.values()):
        ap.error("weights must be finite and positive")
    moves, options = {}, {}
    for k in range(1, K + 1):
        rd = d / f"round_{k}"
        if not rd.exists() or not list(rd.glob("*.json")): ap.error(f"{rd}: missing or empty round")
        for f in sorted(rd.glob("*.json")):
            j = json.loads(f.read_text()); role = j.get("role", f.stem)
            if not isinstance(role, str) or not role: ap.error(f"{f}: invalid role")
            if j.get("round") != k: ap.error(f"{f}: wrong round number")
            for m in j.get("moves", []):
                if not isinstance(m.get("id"), str) or not m["id"].startswith(role + "."):
                    ap.error(f"{f}: move id must belong to its role")
                if "p" in m and (type(m["p"]) not in (int, float) or not math.isfinite(m["p"]) or not 0 <= m["p"] <= 1):
                    ap.error(f"{f}: p must be finite and in [0,1]")
                m["role"] = role
                if m["id"] in moves: moves[m["id"]].update({k2: v for k2, v in m.items() if v is not None})
                else:
                    if m.get("type") not in {"claim", "attack", "support", "question"}: ap.error(f"{f}: invalid new move type")
                    moves[m["id"]] = m
            if j.get("options"):
                dist = j["options"]
                if (not isinstance(dist, dict) or any(type(v) not in (int, float) or not math.isfinite(v) or not 0 <= v <= 1 for v in dist.values())
                        or not math.isclose(sum(dist.values()), 1.0, abs_tol=1e-6)):
                    ap.error(f"{f}: options must sum to 1 with finite probabilities")
                options[role] = dist

    # p=0 explicitly retracts a move (including its attack/support edges).
    moves = {i: m for i, m in moves.items() if m.get("p", 0.5) != 0}
    for m in moves.values():
        if m.get("type") not in {"claim", "attack", "support", "question"}: ap.error("invalid move type")
        if m["type"] == "claim" and m.get("p", 0.5) > 0.5 and not m.get("evidence"):
            ap.error(f"{m['id']}: confident claim needs evidence")

    claims = {i for i, m in moves.items() if m["type"] == "claim"}
    attacks = set()
    for i, m in moves.items():
        if m["type"] != "attack": continue
        t = m.get("target")
        if t not in moves: warn(f"{i}: attack on unknown target {t}"); continue
        if moves[t]["type"] not in ("claim", "attack"): warn(f"{i}: attack on {moves[t]['type']} ignored"); continue
        if m.get("p", 0.5) < 0.5: warn(f"{i}: attack with p<0.5 not an edge"); continue
        attacks.add((i, t))
    ext = grounded(claims | {i for i, _ in attacks} | {t for _, t in attacks}, attacks)

    probs = {}
    for c in claims:
        L = 0.0
        for i, m in moves.items():
            wr = w.get(m["role"], 1.0); s = max(0.0, logit(m.get("p", 0.5)))
            if i == c: L += wr * s
            elif m.get("target") == c and m["type"] == "support": L += 0.6 * wr * s
            elif m.get("target") == c and m["type"] == "attack": L -= wr * s
        probs[c] = round(sigm(L), 3)

    opt_ids = sorted({o for r in options.values() for o in r})
    if any(set(dist) != set(opt_ids) for dist in options.values()): ap.error("all roles must rank the same options")
    borda = {o: 0.0 for o in opt_ids}; mean = {o: 0.0 for o in opt_ids}; W = sum(w.get(r, 1.0) for r in options) or 1
    for r, dist in options.items():
        wr = w.get(r, 1.0); order = sorted(dist, key=dist.get, reverse=True)
        for o in order:
            lower = sum(dist[other] < dist[o] for other in order)
            tied = sum(dist[other] == dist[o] for other in order) - 1
            borda[o] += wr * (lower + tied / 2)
        for o, p in dist.items(): mean[o] += wr * float(p) / W
    bmax = max(borda.values(), default=0) or 1
    score = {o: round(0.5 * borda[o] / bmax + 0.5 * mean[o], 3) for o in opt_ids}
    ranking = sorted(opt_ids, key=score.get, reverse=True)
    tie = len(ranking) > 1 and score[ranking[0]] == score[ranking[1]]

    prev_f = d / f"state_{K-1}.json"
    previous = json.loads(prev_f.read_text()) if prev_f.exists() else {}
    prev_p = previous.get("claim_probs", {})
    new_claims = claims - set(prev_p)
    dmax = max([abs(probs[c] - prev_p[c]) for c in claims & set(prev_p)] or [0])
    options_delta = max((abs(score[o] - previous.get("option_scores", {}).get(o, 0)) for o in score), default=0)
    signature = {i: {key: value for key, value in m.items() if key != "p"} for i, m in moves.items()}
    converged = (K > 1 and bool(previous) and set(probs) == set(prev_p) and dmax < 0.15
                 and previous.get("move_signature") == signature and previous.get("options") == options
                 and previous.get("grounded") == sorted(i for i in ext if i in claims))

    state = {"round": K, "tags": tags, "weights": w, "grounded": sorted(i for i in ext if i in claims), "claim_probs": probs,
             "option_scores": score, "ranking": ranking, "decision": ranking[0] if ranking and not tie else None, "tie": tie,
             "options": options, "move_signature": signature, "max_option_delta": round(options_delta, 3),
             "new_claims": sorted(new_claims), "max_delta": round(dmax, 3), "converged": converged,
             "open_questions": [m for m in moves.values() if m["type"] == "question"],
             "claims": {c: {"text": moves[c].get("text"), "role": moves[c]["role"], "p": moves[c].get("p"), "evidence": moves[c].get("evidence", [])} for c in claims}}
    s = json.dumps(state, ensure_ascii=False, indent=2)
    (d / f"state_{K}.json").write_text(s); (d / "state.json").write_text(s)
    print(json.dumps({k: state[k] for k in ("round", "decision", "tie", "ranking", "grounded", "converged", "max_delta")}, ensure_ascii=False))

if __name__ == "__main__": main()
