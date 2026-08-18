#!/usr/bin/env python3
"""validate_decision.py — L0 structural gate for DecisionRecord.

STRUCTURE-ONLY: checks load-bearing invariants of the conductor's own
gate-crossing ledger (schema: ../schemas/decision-record.json). Does NOT
judge whether the gate calls themselves were the RIGHT calls — that is the
battery's job. Python 3 stdlib only.

Invariants enforced (see --selftest for the exhaustive, self-proving list):
  1. gates[]: any entry with verdict=="pass" must have non-empty
     options_rejected (O2: a pass with no rejected options is un-thought).
  2. MACHINE-FACTORY INVARIANT: a gate with adjudicator=="machine" requires
     capability_level in {O-L3, O-L4}. A machine-adjudicated gate may NOT sit
     under a human-judged level (O-L0/O-L1/O-L2) — the level would claim
     "human judged this gate" while a machine did. Human-adjudicated records
     stay valid at every level (the heritage human-run path is not broken for
     a hypothetical human run). After the executor's 0.1.6 mechanical stamp
     every record born by the pipeline is O-L3 + all-machine, so this passes
     DETERMINISTICALLY; the rule only ever fires on a record that recombines a
     machine gate with a human-judged level (the R2 O-L0/machine deadlock
     class this whole change kills).
  3. acceptance: the min-fold cap.
     - battery_verdict in {breaches_found, not_run} => effective_verdict must
       NOT be "industrial" (capped at "candidate" or lower).
     - "industrial" is allowed only when battery_verdict=="clean".
     - effective_verdict must equal min(re_audit_verdict, battery_cap) under
       the ordering draft < candidate < industrial.
     - battery_independence_tier=="none" is valid ONLY paired with
       battery_verdict=="not_run" (no battery ran, so no tier applies). If
       "none" appears alongside a battery that actually ran (clean or
       breaches_found), that is a fail.
  4. final_verdict in {done, stopped_unmet}; stopped_unmet => blocking_gaps
     non-empty.
  5. learning_record.destinations.{checklist_entry, gotcha_backfill,
     kb_revision} all non-empty.

Usage:
  validate_decision.py <record.json>
  validate_decision.py --selftest
"""
from __future__ import annotations

import json
import sys

VERDICT_ORDER = {"draft": 0, "candidate": 1, "industrial": 2}

# Levels that assert "every gate was human-judged". A machine adjudicator is
# illegal under any of these (machine-factory invariant, O7): a machine gate
# requires O-L3+ where the battery auto-executes and the human veto is merely
# reserved. O-L3/O-L4 permit BOTH machine and human adjudicators.
HUMAN_JUDGED_LEVELS = {"O-L0", "O-L1", "O-L2"}


def is_blank(value) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    if isinstance(value, (list, dict)):
        return len(value) == 0
    return False


def battery_cap(battery_verdict: str) -> str:
    """The highest effective_verdict the battery result permits."""
    if battery_verdict == "clean":
        return "industrial"
    # breaches_found or not_run: capped at candidate (never industrial)
    return "candidate"


def validate(data: dict) -> list:
    v = []

    capability_level = data.get("capability_level")
    gates = data.get("gates") or []

    for i, g in enumerate(gates):
        if not isinstance(g, dict):
            continue
        stage = g.get("stage", "?")
        if g.get("verdict") == "pass" and is_blank(g.get("options_rejected")):
            v.append(f"gates[{i}] (stage={stage}) verdict==pass but options_rejected is empty (un-thought signal)")
        if g.get("adjudicator") == "machine" and capability_level in HUMAN_JUDGED_LEVELS:
            v.append(
                f"gates[{i}] (stage={stage}) adjudicator=='machine' requires capability_level O-L3+ "
                f"(machine factory: a machine-adjudicated gate cannot sit under a human-judged level), "
                f"got capability_level={capability_level!r}"
            )

    acceptance = data.get("acceptance") or {}
    battery_verdict = acceptance.get("battery_verdict")
    re_audit_verdict = acceptance.get("re_audit_verdict")
    effective_verdict = acceptance.get("effective_verdict")
    battery_independence_tier = acceptance.get("battery_independence_tier")

    if battery_independence_tier == "none" and battery_verdict != "not_run":
        v.append(
            f"acceptance.battery_independence_tier=='none' is only valid when "
            f"battery_verdict=='not_run', got battery_verdict={battery_verdict!r}"
        )

    if battery_verdict in ("breaches_found", "not_run") and effective_verdict == "industrial":
        v.append(
            f"acceptance.effective_verdict=='industrial' is not allowed when battery_verdict=={battery_verdict!r} "
            f"(min-fold cap: industrial requires battery_verdict==clean)"
        )

    if re_audit_verdict in VERDICT_ORDER and battery_verdict in ("clean", "breaches_found", "not_run"):
        cap = battery_cap(battery_verdict)
        expected = min(re_audit_verdict, cap, key=lambda x: VERDICT_ORDER[x])
        if effective_verdict != expected:
            v.append(
                f"acceptance.effective_verdict={effective_verdict!r} but expected min(re_audit_verdict="
                f"{re_audit_verdict!r}, battery_cap={cap!r}) == {expected!r}"
            )
    elif effective_verdict not in VERDICT_ORDER:
        v.append(f"acceptance.effective_verdict must be one of draft/candidate/industrial, got {effective_verdict!r}")

    final_verdict = data.get("final_verdict")
    if final_verdict not in ("done", "stopped_unmet"):
        v.append(f"final_verdict must be 'done' or 'stopped_unmet', got {final_verdict!r}")
    if final_verdict == "stopped_unmet" and is_blank(data.get("blocking_gaps")):
        v.append("blocking_gaps must be non-empty when final_verdict==stopped_unmet")

    learning_record = data.get("learning_record") or {}
    destinations = learning_record.get("destinations") or {}
    for f in ("checklist_entry", "gotcha_backfill", "kb_revision"):
        if is_blank(destinations.get(f)):
            v.append(f"learning_record.destinations.{f} must be non-empty")

    return v


# --------------------------------------------------------------------------
# --selftest fixtures
# --------------------------------------------------------------------------

def _gate(stage="engineer", verdict="pass", adjudicator="human", options_rejected=None):
    return {
        "stage": stage, "iteration": 1, "artifact_ref": f"{stage}.json#entry1",
        "leverage": "routine", "question": "does this pass?",
        "evidence": ["entry1"], "options_considered": ["A", "B"],
        "options_rejected": options_rejected if options_rejected is not None else [{"option": "B", "why": "weaker evidence"}],
        "uncertainty": "low", "adjudicator": adjudicator, "verdict": verdict,
        "routing_hypothesis": "n/a", "remediation_path": "n/a",
    }


def _green_fixture() -> dict:
    return {
        "schema_version": "1.0",
        "artifact_type": "decision_record",
        "target": "example-skill",
        "produced_by_role": "conductor",
        "capability_level": "O-L0",
        "gates": [_gate()],
        "acceptance": {
            "re_audit_verdict": "industrial",
            "battery_verdict": "clean",
            "battery_independence_tier": "model",
            "battery_stop_reason": "2 consecutive rounds no new P1/P2 (E9 pre-registered)",
            "effective_verdict": "industrial",
        },
        "final_verdict": "done",
        "blocking_gaps": [],
        "learning_record": {
            "results": "shipped industrial", "failures": "none blocking",
            "root_cause_routing_verified": "yes, min() held",
            "evaluator_audit_findings": "none",
            "battery_breaches": "none",
            "destinations": {
                "checklist_entry": "added to O4 checklist", "gotcha_backfill": "added S6 entry",
                "kb_revision": "no KB change needed this cycle",
            },
        },
    }


def _traps() -> list:
    traps = []

    d = _green_fixture()
    d["gates"][0]["options_rejected"] = []
    traps.append(("gate verdict==pass with empty options_rejected", d))

    # Machine-factory invariant: a machine adjudicator under O-L0 (the R2
    # deadlock class) must be caught.
    d = _green_fixture()
    d["gates"][0]["adjudicator"] = "machine"
    traps.append(("machine adjudicator under a human-judged level O-L0 (R2 deadlock class)", d))

    # ...and under O-L2 (still a human-judged level): machine is illegal there too.
    d = _green_fixture()
    d["capability_level"] = "O-L2"
    d["gates"][0]["adjudicator"] = "machine"
    traps.append(("machine adjudicator under a human-judged level O-L2", d))

    d = _green_fixture()
    d["acceptance"]["battery_verdict"] = "breaches_found"
    d["acceptance"]["effective_verdict"] = "industrial"
    traps.append(("industrial effective_verdict despite battery_verdict==breaches_found", d))

    d = _green_fixture()
    d["acceptance"]["battery_verdict"] = "not_run"
    d["acceptance"]["effective_verdict"] = "industrial"
    traps.append(("industrial effective_verdict despite battery_verdict==not_run", d))

    d = _green_fixture()
    d["acceptance"]["re_audit_verdict"] = "candidate"
    d["acceptance"]["battery_verdict"] = "clean"
    d["acceptance"]["effective_verdict"] = "industrial"
    traps.append(("effective_verdict higher than min(re_audit, battery_cap)", d))

    d = _green_fixture()
    d["final_verdict"] = "maybe"
    traps.append(("final_verdict not in done/stopped_unmet", d))

    d = _green_fixture()
    d["final_verdict"] = "stopped_unmet"
    d["blocking_gaps"] = []
    traps.append(("stopped_unmet with empty blocking_gaps", d))

    d = _green_fixture()
    d["learning_record"]["destinations"]["kb_revision"] = ""
    traps.append(("learning_record.destinations.kb_revision blank", d))

    d = _green_fixture()
    d["acceptance"]["battery_independence_tier"] = "none"
    # battery_verdict stays "clean" (a battery that actually ran) => "none" tier is a lie
    traps.append(("battery_independence_tier=='none' with a battery that ran (clean)", d))

    return traps


def run_selftest() -> int:
    ok = True
    green = _green_fixture()
    green_violations = validate(green)
    if green_violations:
        ok = False
        print("SELFTEST FAIL: green fixture unexpectedly flagged:")
        for x in green_violations:
            print(f"  - {x}")
    else:
        print("selftest: green fixture ok (0 violations)")

    # sanity-pass: battery_independence_tier=='none' is legal with not_run
    d = _green_fixture()
    d["acceptance"]["battery_verdict"] = "not_run"
    d["acceptance"]["battery_independence_tier"] = "none"
    d["acceptance"]["effective_verdict"] = "candidate"  # not_run caps at candidate
    sane = validate(d)
    if sane:
        ok = False
        print(f"SELFTEST FAIL: 'none' tier with battery not_run expected to PASS but got: {sane}")
    else:
        print("selftest: sanity-pass 'battery_independence_tier==none with not_run' ok")

    # sanity-pass: the machine factory's OWN record — O-L3 + every gate
    # machine-adjudicated — is exactly what the executor's 0.1.6 stamp writes,
    # and it must validate green (this is the post-stamp deterministic path).
    mf = _green_fixture()
    mf["capability_level"] = "O-L3"
    for g in mf["gates"]:
        g["adjudicator"] = "machine"
    mf_violations = validate(mf)
    if mf_violations:
        ok = False
        print(f"SELFTEST FAIL: machine-factory record (O-L3 + machine gates) expected to PASS but got: {mf_violations}")
    else:
        print("selftest: sanity-pass 'machine factory O-L3 + machine adjudicators' ok")

    # sanity-pass (heritage): a human-adjudicated record stays valid at O-L0 —
    # the green fixture above already proves this; asserted explicitly so a
    # future rule change that breaks the human-run path is caught here too.
    heritage = _green_fixture()  # O-L0 + human adjudicator
    heritage_violations = validate(heritage)
    if heritage_violations:
        ok = False
        print(f"SELFTEST FAIL: heritage human-run record (O-L0 + human gates) expected to PASS but got: {heritage_violations}")
    else:
        print("selftest: sanity-pass 'heritage O-L0 + human adjudicators' ok")

    caught = 0
    traps = _traps()
    total = len(traps)
    for name, fixture in traps:
        violations = validate(fixture)
        if violations:
            caught += 1
        else:
            ok = False
            print(f"SELFTEST FAIL: trap '{name}' was NOT caught")

    print(f"selftest: 1 green ok, {caught}/{total} traps caught")
    return 0 if ok and caught == total else 1


def main() -> int:
    if len(sys.argv) == 2 and sys.argv[1] == "--selftest":
        return run_selftest()
    if len(sys.argv) != 2:
        print("usage: validate_decision.py <record.json> | --selftest", file=sys.stderr)
        return 2
    path = sys.argv[1]
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"FAIL: could not read/parse {path}: {e}")
        return 1
    violations = validate(data)
    if violations:
        for x in violations:
            print(x)
        return 1
    print(f"PASS: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
