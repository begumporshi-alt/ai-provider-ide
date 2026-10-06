//! Agent-loop conformance scenarios, executed on the Rust gateway loop (2026-10-06).
//!
//! The scenarios live in one JSON file (`apps/desktop/conformance/loop-scenarios.json`) and are
//! executed by BOTH implementations of the agent protocol — the TypeScript loop
//! (`src/lib/tools/agentLoop.conformance.test.ts`) and this one — so the two are pinned to each
//! other by construction. The wire shape (`tool_calls` + `tool_call_id` pairing, synthesized
//! ids, `{}` for absent arguments), the conversation accumulation across rounds, the
//! refusal-as-result rule, and the iteration ceiling are shared facts, not conventions kept in
//! step by comments.
//!
//! Expectations are deliberately abstract where the loops intentionally differ: denial wording
//! (a user confirm on the client vs this loop's mutation-off refusal), empty-output handling,
//! and usage accounting. Everything the scenarios assert, both loops must satisfy identically.

use serde_json::{json, Value};

use super::{
    bridge_with, chat, delta_text, drain, Host, Scripted, ScriptedTurn, ToolCall,
    MAX_TOOL_ITERATIONS,
};

const SCENARIOS_JSON: &str = include_str!("../../../../../conformance/loop-scenarios.json");

/// The TypeScript loop's source. The TS suite already pins this file's
/// [`MAX_TOOL_ITERATIONS`] against the TS constant by parsing `bridge_policy.rs`; this is the
/// mirror image, so the number cannot move on either side alone.
const TS_LOOP: &str = include_str!("../../../../../src/lib/tools/agentLoop.ts");

fn scenarios() -> Vec<Value> {
    let parsed: Value = serde_json::from_str(SCENARIOS_JSON).expect("the scenario file parses");
    parsed
        .get("scenarios")
        .and_then(Value::as_array)
        .cloned()
        .expect("the scenario file declares scenarios")
}

/// One scripted model turn from a JSON step. Absent `id` and absent `args` are load-bearing:
/// they force the loop's own synthesis (`call_*` ids, `{}` arguments) in both implementations.
fn scripted_turn(step: &Value) -> ScriptedTurn {
    let text = step.get("text").and_then(Value::as_str).unwrap_or("");
    let mut turn = ScriptedTurn::saying(&[text]);
    if let Some(calls) = step.get("calls").and_then(Value::as_array) {
        turn = turn.calling(
            calls
                .iter()
                .map(|c| ToolCall {
                    id: c.get("id").and_then(Value::as_str).map(str::to_string),
                    name: Some(
                        c.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                    ),
                    arguments: c.get("args").map(|a| a.to_string()),
                    raw: None,
                })
                .collect(),
        );
    }
    turn
}

/// Split a conversation into rounds: each assistant turn carrying `tool_calls` opens a round and
/// collects the `role:"tool"` messages that follow it, in order — the same reader the TypeScript
/// driver uses, because the shape of a round is itself one of the shared facts.
fn rounds_of(seen: &[Value]) -> Vec<(Value, Vec<Value>)> {
    let mut rounds: Vec<(Value, Vec<Value>)> = Vec::new();
    for m in seen {
        if m.get("tool_calls").is_some() {
            rounds.push((m.clone(), Vec::new()));
        } else if m.get("role").and_then(Value::as_str) == Some("tool") {
            if let Some(open) = rounds.last_mut() {
                open.1.push(m.clone());
            }
        }
    }
    rounds
}

fn assert_conversation(seen: &[Value], expected: &Value, name: &str, call_n: usize) {
    let fail = |detail: String| format!("conformance scenario \"{name}\", model call {call_n}: {detail}");

    let rounds = rounds_of(seen);
    let expected_rounds = expected
        .get("rounds")
        .and_then(Value::as_array)
        .unwrap_or_else(|| panic!("{}", fail("rounds expectation missing".into())));
    assert_eq!(
        rounds.len(),
        expected_rounds.len(),
        "{}",
        fail(format!(
            "the model saw {} tool rounds, expected {}",
            rounds.len(),
            expected_rounds.len()
        ))
    );

    for (i, (round, want_round)) in rounds.iter().zip(expected_rounds).enumerate() {
        let (assistant, results) = round;
        let wire_calls = assistant
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let want_calls = want_round
            .get("assistantToolCalls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(
            wire_calls.len(),
            want_calls.len(),
            "{}",
            fail(format!("round {}: call count", i + 1))
        );

        for (j, (wire, want_call)) in wire_calls.iter().zip(&want_calls).enumerate() {
            assert_eq!(
                wire.pointer("/function/name").and_then(Value::as_str),
                want_call.get("name").and_then(Value::as_str),
                "{}",
                fail(format!("round {} call {}: name", i + 1, j + 1))
            );
            let args: Value = serde_json::from_str(
                wire.pointer("/function/arguments").and_then(Value::as_str).unwrap_or("null"),
            )
            .unwrap_or(Value::Null);
            assert_eq!(
                args,
                want_call.get("arguments").cloned().unwrap_or(json!({})),
                "{}",
                fail(format!("round {} call {}: arguments", i + 1, j + 1))
            );
        }

        let want_results = want_round
            .get("toolResults")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(
            results.len(),
            want_results.len(),
            "{}",
            fail(format!("round {}: result count", i + 1))
        );

        for (j, (result, want_result)) in results.iter().zip(&want_results).enumerate() {
            let id = result.get("tool_call_id").and_then(Value::as_str).unwrap_or_default();
            let declared = wire_calls
                .get(j)
                .and_then(|c| c.get("id"))
                .and_then(Value::as_str);
            assert_eq!(
                Some(id),
                declared,
                "{}",
                fail(format!("round {} result {}: pairs with call {}", i + 1, j + 1, j + 1))
            );
            if let Some(prefix) = want_result.get("idPrefix").and_then(Value::as_str) {
                assert!(
                    id.starts_with(prefix),
                    "{}",
                    fail(format!(
                        "round {} result {}: id {id:?} lacks the {prefix:?} prefix",
                        i + 1,
                        j + 1
                    ))
                );
            }
            if want_result.get("nonEmpty").and_then(Value::as_bool).unwrap_or(false) {
                assert!(
                    !result.get("content").and_then(Value::as_str).unwrap_or_default().trim().is_empty(),
                    "{}",
                    fail(format!("round {} result {}: content is empty", i + 1, j + 1))
                );
            }
        }
    }
}

async fn run_scenario(sc: &Value) {
    let name = sc.get("name").and_then(Value::as_str).unwrap_or("?").to_string();
    let fail = |detail: String| format!("conformance scenario \"{name}\": {detail}");

    let expect = sc.get("expect").cloned().unwrap_or(Value::Null);
    let model_calls = expect.get("modelCalls").and_then(Value::as_u64).unwrap_or(0) as usize;

    // Repeat the last scripted step the way the TypeScript fake model does, so a ceiling
    // scenario scripted with one step still has a turn for every call up to the ceiling.
    let steps = sc.get("steps").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut turns: Vec<ScriptedTurn> = steps.iter().map(scripted_turn).collect();
    while turns.len() < model_calls {
        let last = steps.last().cloned().expect("a scenario has at least one step");
        turns.push(scripted_turn(&last));
    }

    // The client brings no tools, so the gateway supplies its registry and owns the loop. Mutation
    // stays off: that is what makes the `write_file` scenario a refusal rather than an execution.
    let adapter = Scripted::text(turns);
    let bridge = bridge_with(adapter.clone(), Host::gateway_tools());
    let msgs = drain(&bridge, chat("m1")).await;

    assert_eq!(
        adapter.text_calls(),
        model_calls,
        "{}",
        fail(format!(
            "expected {model_calls} model calls, made {}",
            adapter.text_calls()
        ))
    );

    let final_text = delta_text(&msgs);
    if let Some(want) = expect.get("finalText").and_then(Value::as_str) {
        assert_eq!(final_text, want, "{}", fail(format!("final text was {final_text:?}")));
    }

    if let Some(turns_expect) = expect.get("turns").and_then(Value::as_array) {
        for (i, t) in turns_expect.iter().enumerate() {
            if t.is_null() {
                continue;
            }
            assert_conversation(&adapter.messages_seen(i), t, &name, i + 1);
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_conformance_scenario_holds_on_the_gateway_loop() {
    for sc in scenarios() {
        run_scenario(&sc).await;
    }
}

#[test]
fn the_typescript_loops_ceiling_is_the_same_number() {
    // One number, two loops, no comment keeping them in step: the TS suite parses
    // `MAX_TOOL_ITERATIONS` out of bridge_policy.rs, and this parses `DEFAULT_MAX_ITERATIONS`
    // out of agentLoop.ts.
    let line = TS_LOOP
        .lines()
        .find(|l| l.contains("DEFAULT_MAX_ITERATIONS ="))
        .expect("the TS loop declares DEFAULT_MAX_ITERATIONS");
    let value: usize = line
        .split('=')
        .nth(1)
        .and_then(|v| v.trim().trim_end_matches(';').trim().parse().ok())
        .expect("the TS ceiling is a plain number");
    assert_eq!(value, MAX_TOOL_ITERATIONS);
}
