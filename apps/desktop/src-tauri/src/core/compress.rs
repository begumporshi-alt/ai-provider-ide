//! Auto context compression. The port of `context-compress.ts` (271 lines).
//!
//! A conversation eventually exceeds the model's window, and nothing trimmed it: the gateway
//! forwarded `messages` verbatim and the assistant replayed every prior turn, so a long session
//! failed *at the provider* with a context-length error — a failure that arrived as someone else's
//! error rather than as anything this app could have prevented.
//!
//! **Tier 1 is hard truncation.** It drops the oldest *complete turns* until the prompt fits.
//! **Tier 2** replaces the dropped turns with a summary, which preserves more of the conversation
//! at the cost of a model call on the request path. Tier 1 is the safety net; Tier 2 is the
//! improvement, and it degrades into Tier 1 rather than failing.
//!
//! Both callers converge here deliberately. The gateway (external clients, arbitrary message
//! arrays) and the assistant (history assembled from the transcript) both reach
//! `router.generate_text`, so one implementation covers both and the two cannot drift — the rule
//! this repo applies to every cross-cutting switch.
//!
//! # The three properties the drop order must preserve
//!
//! These are what make truncation *safe* rather than merely smaller. Each is pinned by a test,
//! and the tool-pairing one is checked across **every** budget rather than one hand-picked value,
//! because a bug that fires at one size is exactly what a single case misses.
//!
//! - **The system prefix survives.** Leading `system` turns carry the client's instructions and,
//!   on the gateway, the injected memory block. Dropping those changes what the model is being
//!   asked to do, not merely how much history it can see.
//! - **The newest turn survives.** It holds the question being asked right now. Dropping it to
//!   save tokens would answer a question the user did not ask.
//! - **A tool call and its results move together.** A turn boundary only ever falls on a `user`
//!   message, so an assistant `tool_calls` turn and the `tool` results answering it always land in
//!   the same turn. Providers reject a result whose originating call was dropped — and that
//!   arrives as a `400` from the provider rather than as anything visible here.
//!
//! # What this module deliberately does not share
//!
//! There is already a token estimator in `gateway::context_scope` for the memory-injection budget,
//! and the two are close enough that merging them is tempting. They are not the same estimate:
//!
//! | | memory injection | this module |
//! |---|---|---|
//! | chars per token | `MEMORY_CHARS_PER_TOKEN` = 3.5 | [`CHARS_PER_TOKEN`] = 4 |
//! | reserve fraction | `MEMORY_RESERVE_FRACTION` = 0.20 | [`RESERVE_FRACTION`] = 0.25 |
//! | content shape | string content only | multimodal parts, serialised when not a string |
//!
//! The memory estimator over-estimates on purpose (fewer chars per token means more tokens means
//! it under-injects, the safe direction). The compressor is not under the same pressure. And
//! `context_scope::MEMORY_FRACTION` is *also* 0.25 while meaning "share of the remaining window
//! memory may take" — a value collision with a different meaning, which is precisely why these
//! stay separate constants. The one genuinely shared fact is the per-message overhead, and it is
//! shared: [`crate::core::gateway::context_scope::MESSAGE_OVERHEAD_TOKENS`].
//!
//! # Two things the port cannot carry over literally
//!
//! - **`String::length` in JavaScript counts UTF-16 code units**, not Unicode scalar values and not
//!   bytes. [`estimate_message_tokens`] uses `encode_utf16().count()` to match it. Byte length
//!   would over-estimate every non-ASCII conversation (Bengali is 3 bytes per character) and drop
//!   history that fits; scalar values would under-count astral characters by half.
//! - **`new Set(final.messages)` in Tier 2 is *object identity*.** Rust values have no identity, so
//!   [`compress_with_summary`] counts occurrences instead. See `dropped_against` for why that is
//!   the faithful structural reading rather than an approximation.
//!
//! `compress_messages` takes `&[Value]`, so the TypeScript's "does not mutate the caller's array"
//! test has no counterpart here — the signature makes the mutation unrepresentable, and a test for
//! it could not fail.

use std::collections::HashMap;
use std::future::Future;

use serde_json::Value;

use crate::core::gateway::context_scope::{DEFAULT_WINDOW_TOKENS, MESSAGE_OVERHEAD_TOKENS};

/// Fallback window when the catalog published none.
///
/// **The same number as the host's `DEFAULT_WINDOW_TOKENS`, and that is the point rather than a
/// coincidence.** Both answer one question — *what window do we assume when nobody told us?* — and
/// the TypeScript says so in as many words: "Matches the host's `DEFAULT_WINDOW_TOKENS` so both
/// sides of the bridge plan against the same conservative number." Under-estimating is the correct
/// direction to fail: it costs some history, while over-estimating overflows.
///
/// Aliased rather than re-typed as `8192`, because two spellings of one number is how the two
/// answers come to differ. `the_fallback_window_is_the_hosts_own_constant` pins it.
pub const DEFAULT_CONTEXT_WINDOW: usize = DEFAULT_WINDOW_TOKENS;

/// Rough characters per token.
///
/// Deliberately crude — the estimate only has to be good enough to decide *whether* to drop, and a
/// request that lands 10% under the window is a success. See the module note for why this is not
/// `MEMORY_CHARS_PER_TOKEN`.
pub const CHARS_PER_TOKEN: f64 = 4.0;

/// Share of the window held back for the answer when the caller declared no `max_tokens`.
pub const RESERVE_FRACTION: f64 = 0.25;

/// Heading the summary block is published under.
///
/// Plain prose, no dialect-specific syntax — the same rule the memory block follows. A summary that
/// arrived as bare text would read as if the assistant had said it, which is a worse failure than
/// a summary nobody notices.
pub const SUMMARY_LABEL: &str = "Summary of the earlier part of this conversation:";

/// What one compression produced. The port of `CompressResult` (`context-compress.ts:50-66`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompressResult {
    /// The messages to send.
    pub messages: Vec<Value>,
    /// Messages removed. Zero when nothing needed dropping.
    pub dropped: usize,
    /// The messages that were removed, in their original order — what a summarizer is handed.
    ///
    /// **Carried rather than recomputed by the caller.** Which turns went is decided in exactly one
    /// place, and a second derivation of the same set is how two paths come to disagree about what
    /// "the earlier part of the conversation" means.
    pub dropped_messages: Vec<Value>,
    pub before_tokens: usize,
    pub after_tokens: usize,
    pub budget: usize,
    pub compressed: bool,
}

/// A message's role, if it has one. A message with no `role` is not a `system` and not a `user`,
/// which is what makes both scans below stop where the TypeScript's `!==` comparisons stop.
fn role_of(m: &Value) -> Option<&str> {
    m.get("role").and_then(Value::as_str)
}

fn serialize(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_default()
}

/// One content part, as an estimate-able string. The port of the array branch's `map` callback
/// (`context-compress.ts:82-91`).
fn part_text(part: &Value) -> String {
    match part {
        Value::String(s) => s.clone(),
        // `JSON.stringify(p ?? "")` — the TypeScript substitutes an empty string for a nullish
        // part *before* stringifying, so the result is the two characters `""` rather than the four
        // of `null`. Reachable: a content array with a hole in it.
        Value::Null => serialize(&Value::String(String::new())),
        _ => match part.get("text") {
            Some(Value::String(t)) => t.clone(),
            _ => serialize(part),
        },
    }
}

/// Text of one message, as an estimate-able string. The port of `contentText`
/// (`context-compress.ts:76-99`).
///
/// `ChatMessage.content` is typed `string`, but the gateway forwards a client's JSON verbatim and
/// multimodal requests send an *array* of content parts. Reading that as `""` would estimate zero
/// tokens for what is often the largest message in the request, so anything that is not a string is
/// measured by its serialised size instead.
///
/// **Key order is unobservable here.** `JSON.stringify` preserves insertion order where
/// `serde_json` sorts keys, so the two produce different bytes for the same object — but only the
/// *length* is read, and sorting does not change a length. That is why this port needs no note
/// about `serde_json`'s ordering, unlike every assertion elsewhere in this crate.
fn content_text(m: &Value) -> String {
    match m.get("content") {
        Some(Value::String(s)) => s.clone(),
        // A missing `content` and an explicit `null` are the same thing to `c == null`. Note this
        // differs from the array-part case above: here the answer is the empty string, not `""`.
        None | Some(Value::Null) => String::new(),
        Some(Value::Array(parts)) => parts.iter().map(part_text).collect::<Vec<_>>().join(" "),
        Some(other) => serialize(other),
    }
}

/// Tokens one message is estimated to cost, including its share of the wrapper.
///
/// `encode_utf16().count()` is `String::length` in JavaScript — see the module note.
pub fn estimate_message_tokens(m: &Value) -> usize {
    let chars = content_text(m).encode_utf16().count() as f64;
    (chars / CHARS_PER_TOKEN).ceil() as usize + MESSAGE_OVERHEAD_TOKENS
}

/// Tokens a whole conversation is estimated to cost.
pub fn estimate_tokens(messages: &[Value]) -> usize {
    messages.iter().map(estimate_message_tokens).sum()
}

/// Prompt-token budget: what the request may send, leaving room for the answer.
///
/// A declared `max_tokens` is honoured over the fraction, because that is the reservation the
/// caller actually asked for. Floored at zero rather than allowed to go negative — a window smaller
/// than its own reserve is pathological, and a negative budget would make every comparison in
/// [`compress_messages`] read as "fits", which is the one outcome that must not happen silently.
pub fn prompt_budget(window: usize, max_tokens: Option<u64>) -> usize {
    let declared = max_tokens.filter(|v| *v > 0).unwrap_or(0) as usize;
    let reserve = if declared > 0 {
        declared
    } else {
        // `Math.floor(window * RESERVE_FRACTION)`. The cast truncates toward zero, which is floor
        // for the non-negative window this is only ever called with.
        (window as f64 * RESERVE_FRACTION) as usize
    };
    window.saturating_sub(reserve)
}

/// Leading `system` turns, and everything after them.
fn split_system(messages: &[Value]) -> (&[Value], &[Value]) {
    let mut i = 0;
    while i < messages.len() && role_of(&messages[i]) == Some("system") {
        i += 1;
    }
    messages.split_at(i)
}

/// Group the non-system messages into turns. A new turn begins at every `user` message; anything
/// else joins the turn already open.
///
/// **That single rule is what keeps tool calls paired with their results.** A `tool` message never
/// starts a turn, so it always lands in the same turn as the assistant message whose `tool_calls`
/// it answers. The `turns.is_empty()` arm is what gives a conversation that does not begin with a
/// `user` message somewhere to put its first turn.
fn to_turns(rest: &[Value]) -> Vec<Vec<Value>> {
    let mut turns: Vec<Vec<Value>> = Vec::new();
    for m in rest {
        if role_of(m) == Some("user") || turns.is_empty() {
            turns.push(vec![m.clone()]);
        } else if let Some(last) = turns.last_mut() {
            last.push(m.clone());
        }
    }
    turns
}

/// Drop the oldest whole turns until the prompt fits `budget_tokens`. Tier 1.
///
/// Returns the input unchanged when it already fits, when it is empty, or when it is nothing but
/// system turns — in that last case there is no turn to drop, and a system-only request is worse
/// than an over-budget one.
pub fn compress_messages(messages: &[Value], budget_tokens: usize) -> CompressResult {
    let before_tokens = estimate_tokens(messages);
    let unchanged = || CompressResult {
        messages: messages.to_vec(),
        dropped: 0,
        dropped_messages: Vec::new(),
        before_tokens,
        after_tokens: before_tokens,
        budget: budget_tokens,
        compressed: false,
    };

    if messages.is_empty() || before_tokens <= budget_tokens {
        return unchanged();
    }

    let (system_prefix, rest) = split_system(messages);
    if rest.is_empty() {
        return unchanged();
    }

    let turns = to_turns(rest);
    let turn_tokens: Vec<usize> = turns.iter().map(|t| estimate_tokens(t)).collect();
    let mut total = estimate_tokens(system_prefix) + turn_tokens.iter().sum::<usize>();
    let mut start = 0;
    // **The bound is `turns.len() - 1`: the newest turn survives even when it alone exceeds the
    // budget**, because it carries the question being asked. Everything older is expendable.
    //
    // `saturating_sub` rather than `- 1` because `to_turns` is only non-empty for a non-empty
    // input, which the `rest.is_empty()` return above already guaranteed — but a subtraction that
    // can panic on a refactor is a subtraction worth spelling safely.
    while start < turns.len().saturating_sub(1) && total > budget_tokens {
        total -= turn_tokens[start];
        start += 1;
    }

    let dropped_turns: Vec<Value> = turns[..start].iter().flatten().cloned().collect();
    let mut kept: Vec<Value> = system_prefix.to_vec();
    kept.extend(turns[start..].iter().flatten().cloned());

    CompressResult {
        dropped: messages.len() - kept.len(),
        dropped_messages: dropped_turns,
        before_tokens,
        after_tokens: estimate_tokens(&kept),
        budget: budget_tokens,
        compressed: kept.len() < messages.len(),
        messages: kept,
    }
}

/// Which of `original` are absent from `kept`, in their original order.
///
/// **The TypeScript does this with object identity and Rust cannot, so the port counts
/// occurrences.** `new Set(final.messages)` holds references, and `messages.filter(m => !kept.has(m))`
/// is then an identity test — two *distinct* messages that happen to be structurally equal are both
/// kept, and neither is reported as dropped.
///
/// Rust values are compared structurally, so the equivalent question is "how many copies of this
/// value did `kept` retain?". Walking `original` and spending one unit of allowance per match gives
/// the same answer for distinct messages, and a *correct* answer for duplicates: with
/// `[A, A, B]` reduced to `[A, B]`, exactly one `A` is reported dropped, which is what identity
/// would say too. Reporting zero (a plain `contains`) or two (a plain "is any copy kept?") would
/// both be wrong, and the second is the one that looks right.
fn dropped_against(original: &[Value], kept: &[Value]) -> Vec<Value> {
    let mut allowance: HashMap<String, usize> = HashMap::new();
    for m in kept {
        *allowance.entry(serialize(m)).or_insert(0) += 1;
    }
    let mut dropped = Vec::new();
    for m in original {
        match allowance.get_mut(&serialize(m)) {
            Some(n) if *n > 0 => *n -= 1,
            _ => dropped.push(m.clone()),
        }
    }
    dropped
}

/// Tier 2: replace the dropped turns with a summary rather than discarding them.
///
/// # What is decided where
///
/// Which turns go is decided by [`compress_messages`] and nowhere else. This function only decides
/// how the dropped ones are *represented*. The split is deliberate: a second opinion on what counts
/// as "the earlier part of the conversation" is exactly the kind of divergence that leaves two
/// callers summarising different histories.
///
/// # Failure degrades, never propagates
///
/// A summarizer that fails, or returns nothing usable, yields Tier 1's answer — already a correct
/// solution to the same problem, merely one that keeps less. An added feature must not turn a
/// working request into a failed one. Note that `Err(_)` and a whitespace-only `Ok` are therefore
/// the *same* outcome, which is the TypeScript's behaviour and not a loss: its `catch` returns
/// `base` and its `text === ""` check returns `base`.
///
/// # The summary cannot be trimmed away
///
/// It is placed in the system prefix, which [`compress_messages`] preserves, so the re-fit below
/// may drop further *conversation* turns but never the summary itself.
pub async fn compress_with_summary<F, Fut, E>(
    messages: &[Value],
    budget_tokens: usize,
    summarize: F,
) -> CompressResult
where
    F: FnOnce(Vec<Value>) -> Fut,
    Fut: Future<Output = Result<String, E>>,
{
    let base = compress_messages(messages, budget_tokens);
    // Nothing dropped, so nothing to summarize — and paying for a model call to summarize zero
    // turns would be pure cost on the request path.
    if !base.compressed || base.dropped_messages.is_empty() {
        return base;
    }

    let Ok(summary) = summarize(base.dropped_messages.clone()).await else {
        return base;
    };
    let text = summary.trim();
    if text.is_empty() {
        return base;
    }

    let mut at = 0;
    while at < base.messages.len() && role_of(&base.messages[at]) == Some("system") {
        at += 1;
    }
    let summary_msg =
        serde_json::json!({ "role": "system", "content": format!("{SUMMARY_LABEL}\n{text}") });
    let mut with_summary: Vec<Value> = Vec::with_capacity(base.messages.len() + 1);
    with_summary.extend_from_slice(&base.messages[..at]);
    with_summary.push(summary_msg);
    with_summary.extend_from_slice(&base.messages[at..]);

    // The summary costs tokens too, so the result has to be re-fitted. This may drop further turns,
    // and those go without a second summary — the summary already covers the oldest material, and
    // recursing would put an unbounded number of model calls on the request path.
    let final_result = compress_messages(&with_summary, budget_tokens);

    // **Reported against the ORIGINAL conversation rather than the intermediate one**, so "what was
    // removed" does not change meaning depending on whether a summary happened to be produced. The
    // summary itself is an addition, so it never appears in the dropped set.
    let dropped_messages = dropped_against(messages, &final_result.messages);
    CompressResult {
        messages: final_result.messages,
        dropped: dropped_messages.len(),
        dropped_messages,
        before_tokens: base.before_tokens,
        after_tokens: final_result.after_tokens,
        budget: budget_tokens,
        compressed: true,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use serde_json::json;

    use super::*;

    fn msg(role: &str, content: &str) -> Value {
        json!({ "role": role, "content": content })
    }

    fn sized(role: &str, tokens: usize) -> Value {
        msg(role, &"x".repeat(tokens.saturating_mul(4)))
    }

    // ---------- prompt_budget ----------

    #[test]
    fn a_declared_max_tokens_is_reserved_rather_than_a_guessed_fraction() {
        assert_eq!(prompt_budget(100_000, Some(4_000)), 96_000);
    }

    #[test]
    fn the_reserve_falls_back_to_a_share_of_the_window_when_none_was_declared() {
        assert_eq!(prompt_budget(100_000, None), 75_000);
    }

    #[test]
    fn a_window_smaller_than_its_own_reserve_floors_at_zero_and_never_goes_negative() {
        // A negative budget would make every `total > budget` comparison in `compress_messages`
        // read as "fits", which is the one failure that would silently send an overflowing prompt.
        assert_eq!(prompt_budget(1_000, Some(5_000)), 0);
    }

    #[test]
    fn a_zero_or_negative_max_tokens_is_not_a_declared_reserve() {
        // `max_tokens > 0` in the source. Zero is "unspecified", not "reserve nothing".
        assert_eq!(prompt_budget(100_000, Some(0)), 75_000);
    }

    // ---------- estimation ----------

    #[test]
    fn a_multimodal_content_array_is_counted_rather_than_read_as_empty() {
        let array = json!({
            "role": "user",
            "content": [{ "type": "text", "text": "hello world" }],
        });
        assert!(
            estimate_tokens(&[array]) > estimate_tokens(&[msg("user", "")]),
            "the parts carry the tokens; reading the array as \"\" would estimate none of them"
        );
    }

    #[test]
    fn a_message_with_no_content_at_all_still_costs_its_overhead() {
        let bare = json!({ "role": "assistant" });
        assert_eq!(estimate_tokens(&[bare]), MESSAGE_OVERHEAD_TOKENS);
    }

    #[test]
    fn a_nullish_content_part_serialises_as_the_two_characters_the_source_produces() {
        // `JSON.stringify(p ?? "")` — the substitution happens before stringifying, so a hole in a
        // content array contributes `""` (2 chars), not `null` (4). Reachable: a content array with
        // a hole in it.
        //
        // **Asserted on the text, not on the token count, and that is deliberate.** At four chars
        // per token both 2 and 4 characters ceiling to the same single token, so a count-based
        // assertion here would pass against the wrong implementation — the exact shape of test this
        // crate has been bitten by before.
        let with_hole = json!({ "role": "user", "content": [Value::Null] });
        assert_eq!(content_text(&with_hole), "\"\"");
    }

    #[test]
    fn a_missing_content_and_an_explicit_null_content_both_read_as_empty() {
        // Distinct from the array-part case above: `c == null` returns the empty string here, not
        // the two characters `""`. A shared helper between the two would get one of them wrong.
        assert_eq!(content_text(&json!({ "role": "assistant" })), "");
        assert_eq!(content_text(&json!({ "role": "assistant", "content": Value::Null })), "");
    }

    #[test]
    fn the_estimate_counts_utf16_code_units_exactly_as_javascript_length_does() {
        // Four astral-plane characters: 8 UTF-16 code units (what JS sees), 4 scalar values, 16
        // bytes. Only the first agrees with the reference, and the three differ by 4x, so this
        // pins the choice rather than merely describing it.
        let emoji = msg("user", &"\u{1F600}".repeat(4));
        assert_eq!(estimate_message_tokens(&emoji), 2 + MESSAGE_OVERHEAD_TOKENS);

        // Four Bengali characters: 4 UTF-16 units, 4 scalar values, 12 bytes. This separates the
        // byte reading from both character readings — the case that matters for a user in Dhaka.
        let bengali = msg("user", &"\u{0995}".repeat(4));
        assert_eq!(estimate_message_tokens(&bengali), 1 + MESSAGE_OVERHEAD_TOKENS);
    }

    #[test]
    fn the_fallback_window_is_the_hosts_own_constant() {
        // Two answers to one question — "what window do we assume when nobody told us?" — must not
        // drift apart. The TypeScript states the agreement; this makes it load-bearing.
        //
        // **This cannot fail while `DEFAULT_CONTEXT_WINDOW` is an alias, and that is recorded
        // rather than hidden.** Its value is catching a future de-aliasing: the day someone writes
        // the literal `8192` back in and the host's constant later moves, this fails and says which
        // pair drifted. It is a guard on the *shape*, not on the number.
        assert_eq!(DEFAULT_CONTEXT_WINDOW, DEFAULT_WINDOW_TOKENS);
    }

    #[test]
    fn the_compressors_ratios_are_deliberately_not_the_memory_paths() {
        // A guard against the tidy-up that merges them: the memory estimator over-estimates on
        // purpose, and the two reserve fractions differ. If someone unifies these, the *memory*
        // path's behaviour moves, which is why the values are asserted rather than merely named.
        use crate::core::gateway::context_scope::{
            MEMORY_CHARS_PER_TOKEN, MEMORY_RESERVE_FRACTION,
        };
        assert_ne!(CHARS_PER_TOKEN, MEMORY_CHARS_PER_TOKEN);
        assert_ne!(RESERVE_FRACTION, MEMORY_RESERVE_FRACTION);
        assert_eq!(CHARS_PER_TOKEN, 4.0);
        assert_eq!(RESERVE_FRACTION, 0.25);
    }

    // ---------- compress_messages ----------

    #[test]
    fn messages_that_already_fit_come_back_untouched() {
        let all = vec![msg("system", "sys"), msg("user", "hi")];
        let r = compress_messages(&all, estimate_tokens(&all));
        assert!(!r.compressed);
        assert_eq!(r.dropped, 0);
        assert_eq!(r.messages, all);
        assert!(r.dropped_messages.is_empty());
    }

    #[test]
    fn an_empty_conversation_is_not_compressed() {
        let r = compress_messages(&[], 10);
        assert!(r.messages.is_empty());
        assert!(!r.compressed);
        assert_eq!(r.before_tokens, 0);
        assert_eq!(r.after_tokens, 0);
    }

    #[test]
    fn a_single_message_has_no_older_turn_to_drop() {
        // The loop's bound is `turns.len() - 1`, which is zero here: the newest turn is also the
        // oldest, and it survives an impossible budget.
        let only = vec![msg("user", "only")];
        let r = compress_messages(&only, 1);
        assert!(!r.compressed);
        assert_eq!(r.messages, only);
    }

    #[test]
    fn the_system_prefix_survives_because_dropping_it_changes_what_is_asked() {
        let system = msg("system", "you are a careful assistant");
        let r = compress_messages(&[system.clone(), msg("user", "old"), msg("user", "new")], 1);
        assert_eq!(r.messages[0], system);
    }

    #[test]
    fn the_oldest_turn_goes_first_and_the_loop_stops_as_soon_as_it_fits() {
        let system = msg("system", "sys");
        let old_q = msg("user", "old question");
        let old_a = msg("assistant", "old answer");
        let mid_q = sized("user", 50);
        let new_q = msg("user", "new question");
        // Exactly what is left after the oldest turn goes — so the loop must stop after one
        // iteration, with a whole turn still ahead of it that it must *not* take.
        let budget = estimate_tokens(&[system.clone(), mid_q.clone(), new_q.clone()]);

        let r = compress_messages(
            &[system.clone(), old_q, old_a, mid_q.clone(), new_q.clone()],
            budget,
        );
        assert!(r.compressed);
        assert_eq!(r.messages, vec![system, mid_q, new_q]);
        assert_eq!(r.dropped, 2, "the oldest turn went, and only that turn");
        assert!(r.after_tokens <= budget);

        // **Three turns, not two, and a falsification run is why.** With only two turns the bound
        // `turns.len() - 1` ends the loop after a single iteration whether or not the running total
        // was decremented — so the second half of this test's name was unverified, and deleting
        // `total -= turn_tokens[start]` left the test green. The third turn gives the loop somewhere
        // left to go, and only a decremented total stops it there.
    }

    #[test]
    fn the_newest_turn_survives_even_when_it_alone_exceeds_the_budget() {
        // Dropping it would answer a question the user did not ask, which is worse than overflow.
        let system = msg("system", "sys");
        let newest = sized("user", 5_000);
        let r = compress_messages(&[system.clone(), msg("user", "old"), newest.clone()], 1);
        assert_eq!(r.messages, vec![system, newest]);
    }

    #[test]
    fn a_system_only_request_is_never_stripped() {
        // There is no turn to drop, and a system-only request is worse than an over-budget one.
        let only_system = vec![sized("system", 4_000)];
        let r = compress_messages(&only_system, 1);
        assert!(!r.compressed);
        assert_eq!(r.messages, only_system);
    }

    #[test]
    fn a_tool_result_is_never_orphaned_from_its_call_at_any_budget() {
        // Every budget, not one hand-picked value: a bug that fires at one size is what a single
        // case misses. The provider's answer to an orphaned result is a 400, which would arrive
        // here as an unexplained provider failure.
        let convo = vec![
            msg("system", "sys"),
            msg("user", "q1"),
            json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "c1", "name": "read" }] }),
            json!({ "role": "tool", "content": "r1", "tool_call_id": "c1" }),
            msg("user", "q2"),
            json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "c2", "name": "write" }] }),
            json!({ "role": "tool", "content": "r2", "tool_call_id": "c2" }),
            msg("user", "q3"),
        ];

        for budget in 0..=(estimate_tokens(&convo) + 20) {
            let r = compress_messages(&convo, budget);
            let called: Vec<&str> = r
                .messages
                .iter()
                .filter(|m| role_of(m) == Some("assistant"))
                .filter_map(|m| m.get("tool_calls").and_then(Value::as_array))
                .flatten()
                .filter_map(|c| c.get("id").and_then(Value::as_str))
                .collect();
            for m in &r.messages {
                if role_of(m) == Some("tool") {
                    let id = m.get("tool_call_id").and_then(Value::as_str).unwrap_or("");
                    assert!(
                        called.contains(&id),
                        "budget {budget}: tool result {id} survived without its call"
                    );
                }
            }
            assert_eq!(
                r.messages.last().and_then(|m| m.get("content")).and_then(Value::as_str),
                Some("q3"),
                "budget {budget}: the newest turn must survive at every budget"
            );
        }
    }

    #[test]
    fn an_assistant_tool_call_turn_and_its_results_go_as_one_unit() {
        let system = msg("system", "sys");
        let old_q = msg("user", "q1");
        let call = json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "c1" }] });
        let result = json!({ "role": "tool", "content": "r1", "tool_call_id": "c1" });
        let new_q = msg("user", "q2");

        let budget = estimate_tokens(&[system.clone(), new_q.clone()]);
        let r = compress_messages(&[system.clone(), old_q, call, result, new_q.clone()], budget);
        // Neither the call nor its result is present, and the newest turn is.
        assert_eq!(r.messages, vec![system, new_q]);
        assert_eq!(r.dropped, 3, "the whole turn went, not just its first message");
    }

    #[test]
    fn a_kept_turn_brings_its_assistant_and_tool_messages_with_it() {
        // **The mirror of the orphan test, and it was missing until a mutation found the gap.** That
        // one proves a tool result never survives without its call; this one proves a kept turn does
        // not arrive stripped of its assistant and tool messages.
        //
        // Without it, an implementation that silently dropped every non-`user` message from the
        // turns passes this entire module — the orphan check included, because dropping the tool
        // messages leaves no orphan behind. The failure in production would be an assistant that
        // cannot see what it previously said, which reads as a model problem rather than as one here.
        let system = msg("system", "sys");
        let q1 = msg("user", "q1");
        let q2 = msg("user", "q2");
        let call = json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "c1" }] });
        let result = json!({ "role": "tool", "content": "r1", "tool_call_id": "c1" });

        let budget = estimate_tokens(&[system.clone(), q2.clone(), call.clone(), result.clone()]);
        let r = compress_messages(
            &[system.clone(), q1, q2.clone(), call.clone(), result.clone()],
            budget,
        );

        assert_eq!(r.messages, vec![system, q2, call, result]);
        assert_eq!(r.dropped, 1, "only the oldest turn went");
    }

    #[test]
    fn the_result_reports_the_budget_it_was_given_and_what_it_achieved() {
        let all = vec![msg("user", "a"), msg("user", "b")];
        let r = compress_messages(&all, 5);
        assert_eq!(r.budget, 5);
        assert_eq!(r.before_tokens, estimate_tokens(&all));
        assert_eq!(r.after_tokens, estimate_tokens(&r.messages));
        assert!(r.after_tokens <= r.budget);
    }

    #[test]
    fn the_dropped_messages_are_the_ones_that_went_in_their_original_order() {
        // What a summarizer is handed. A second derivation of this set is how two callers come to
        // summarise different histories.
        let system = msg("system", "sys");
        let q1 = msg("user", "q1");
        let q2 = msg("user", "q2");
        let q3 = msg("user", "q3");
        let budget = estimate_tokens(&[system.clone(), q3.clone()]);
        let r = compress_messages(&[system, q1.clone(), q2.clone(), q3], budget);
        assert_eq!(r.dropped_messages, vec![q1, q2]);
    }

    #[test]
    fn a_summary_in_the_system_prefix_is_never_trimmed_away() {
        // The property Tier 2 depends on: the summary is stored as a leading system turn, and
        // leading system turns survive every later trim.
        let system = msg("system", "sys");
        let summary = msg("system", &format!("{SUMMARY_LABEL}\n earlier stuff"));
        let q1 = msg("user", "q1");
        let q2 = msg("user", "q2");
        let budget = estimate_tokens(&[system.clone(), summary.clone(), q2.clone()]);
        let r = compress_messages(&[system, summary.clone(), q1, q2], budget);
        assert!(r.messages.contains(&summary));
    }

    // ---------- compress_with_summary ----------

    fn tight_budget(system: &Value, newest: &Value) -> usize {
        estimate_tokens(&[system.clone(), newest.clone()])
    }

    #[tokio::test]
    async fn a_dropped_turn_becomes_a_summary_rather_than_vanishing() {
        let system = msg("system", "sys");
        let old_q = msg("user", "old question");
        let new_q = msg("user", "new question");
        let r = compress_with_summary(
            &[system.clone(), old_q, new_q.clone()],
            tight_budget(&system, &new_q),
            |_| async { Ok::<String, String>("They asked something earlier.".to_string()) },
        )
        .await;

        assert!(r.compressed);
        assert!(r.messages.contains(&system));
        assert!(r.messages.contains(&new_q));
        let summary = r
            .messages
            .iter()
            .find(|m| role_of(m) == Some("system") && content_text(m).contains(SUMMARY_LABEL))
            .expect("a summary message was inserted");
        assert!(content_text(summary).contains("They asked something earlier."));
    }

    #[tokio::test]
    async fn the_summarizer_is_handed_exactly_the_messages_that_were_dropped() {
        let system = msg("system", "sys");
        let old_q = msg("user", "old question");
        let new_q = msg("user", "new question");
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = seen.clone();

        let _ = compress_with_summary(
            &[system.clone(), old_q.clone(), new_q.clone()],
            tight_budget(&system, &new_q),
            move |dropped| {
                *sink.lock().unwrap() = dropped;
                async { Ok::<String, String>("s".to_string()) }
            },
        )
        .await;

        assert_eq!(*seen.lock().unwrap(), vec![old_q]);
    }

    #[tokio::test]
    async fn a_summarizer_that_fails_degrades_to_plain_truncation() {
        // An added feature must never turn a working request into a failed one.
        let system = msg("system", "sys");
        let old_q = msg("user", "old question");
        let new_q = msg("user", "new question");
        let r = compress_with_summary(
            &[system.clone(), old_q, new_q.clone()],
            tight_budget(&system, &new_q),
            |_| async { Err::<String, String>("summarizer unavailable".to_string()) },
        )
        .await;

        assert_eq!(r.messages, vec![system, new_q]);
        assert!(!r.messages.iter().any(|m| content_text(m).contains(SUMMARY_LABEL)));
    }

    #[tokio::test]
    async fn a_summarizer_that_returns_only_whitespace_is_the_same_as_failing() {
        let system = msg("system", "sys");
        let old_q = msg("user", "old question");
        let new_q = msg("user", "new question");
        let r = compress_with_summary(
            &[system.clone(), old_q, new_q.clone()],
            tight_budget(&system, &new_q),
            |_| async { Ok::<String, String>("   ".to_string()) },
        )
        .await;

        assert_eq!(r.messages, vec![system, new_q]);
    }

    #[tokio::test]
    async fn the_summarizer_is_not_called_when_nothing_was_dropped() {
        // Paying for a model call to summarize zero turns would be pure cost on the request path.
        let system = msg("system", "sys");
        let new_q = msg("user", "new question");
        let all = vec![system.clone(), new_q.clone()];
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();

        let _ = compress_with_summary(&all, estimate_tokens(&all), move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            async { Ok::<String, String>("s".to_string()) }
        })
        .await;

        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn the_summary_sits_ahead_of_the_conversation_in_the_system_prefix() {
        // Sized so the budget is genuinely tight: it forces `q1` out, yet still leaves room for the
        // summary beside the newest turn. With one-word turns nothing would be dropped, no summary
        // would be produced, and the assertions would run against a case that never happened.
        let system = msg("system", "sys");
        let q1 = sized("user", 50);
        let q2 = msg("user", "q2");
        let budget = estimate_tokens(&[system.clone(), q1.clone(), q2.clone()])
            - estimate_tokens(std::slice::from_ref(&q1))
            + 40;

        let r = compress_with_summary(&[system, q1, q2.clone()], budget, |_| async {
            Ok::<String, String>("summary text".to_string())
        })
        .await;

        let summary_idx = r
            .messages
            .iter()
            .position(|m| role_of(m) == Some("system") && content_text(m).contains(SUMMARY_LABEL))
            .expect("a summary was produced");
        let last_idx = r.messages.iter().position(|m| m == &q2).expect("q2 survived");
        assert!(summary_idx < last_idx);
    }

    #[tokio::test]
    async fn the_result_still_fits_after_the_summary_is_added_because_the_refit_may_drop_more() {
        // The summary itself costs tokens, so adding it can push the result back over budget and
        // cost a further turn. The newest turn must survive that too.
        let system = msg("system", "sys");
        let q1 = sized("user", 50);
        let q2 = sized("user", 50);
        let q3 = msg("user", "q3");
        let budget = estimate_tokens(&[system.clone(), q3.clone()]) + 60;

        let r = compress_with_summary(&[system, q1, q2, q3.clone()], budget, |_| async {
            Ok::<String, String>("a compact summary".to_string())
        })
        .await;

        assert!(r.compressed);
        assert!(r.after_tokens <= budget);
        assert_eq!(r.messages.last(), Some(&q3));
        assert!(
            r.messages.iter().any(|m| content_text(m).contains(SUMMARY_LABEL)),
            "the summary survived the re-fit that removed q2"
        );
    }

    #[tokio::test]
    async fn the_dropped_set_is_reported_against_the_original_and_counts_duplicates() {
        // The port's one structural divergence: the TypeScript uses object identity, so two
        // structurally-equal messages are two different objects and only the one that actually went
        // is reported. Counting occurrences reproduces that; a plain `contains` would report zero
        // dropped and a plain "is any copy kept?" would report both.
        let system = msg("system", "sys");
        let same = sized("user", 50);
        let q3 = msg("user", "q3");
        let budget = estimate_tokens(&[system.clone(), q3.clone()]);

        let r = compress_with_summary(
            &[system, same.clone(), same.clone(), q3.clone()],
            budget,
            |_| async { Ok::<String, String>("s".to_string()) },
        )
        .await;

        assert_eq!(
            r.dropped, 2,
            "both copies went, and the count is against the original conversation"
        );
        assert_eq!(r.dropped_messages, vec![same.clone(), same]);
        assert!(r.messages.contains(&q3));
    }

    #[test]
    fn the_dropped_set_spends_one_unit_of_allowance_per_kept_copy() {
        // **The assertion that actually pins the counting rule**, and it is made directly rather
        // than through a budget, because a budget that keeps one copy and drops its twin is fiddly
        // to hit from the outside.
        //
        // The TypeScript compares object identity: with `[A, A, B]` reduced to `[A, B]`, exactly
        // one `A` went — the other object survived. Both of the plausible wrong readings give zero:
        // a `contains` membership test sees `A` present and reports nothing dropped, and an "is any
        // copy kept?" test does the same. Only spending one unit of allowance per kept copy gives
        // the right answer, and only a partially-kept duplicate can tell them apart.
        let a = msg("user", "a");
        let b = msg("user", "b");

        assert_eq!(
            dropped_against(&[a.clone(), a.clone(), b.clone()], &[a.clone(), b.clone()]),
            vec![a.clone()],
            "one of the two identical messages went; the other is still in `kept`"
        );
        assert!(
            dropped_against(&[a.clone(), b.clone()], &[a.clone(), b.clone()]).is_empty(),
            "nothing went, so nothing is reported"
        );
    }

    #[tokio::test]
    async fn the_summary_itself_is_never_counted_as_dropped() {
        // It is an addition, not a removal. Reporting it would inflate the count with a message the
        // caller never sent.
        let system = msg("system", "sys");
        let old_q = sized("user", 50);
        let new_q = msg("user", "new");
        let budget = estimate_tokens(&[system.clone(), new_q.clone()]) + 30;

        let r = compress_with_summary(&[system, old_q, new_q], budget, |_| async {
            Ok::<String, String>("a summary".to_string())
        })
        .await;

        assert!(
            !r.dropped_messages.iter().any(|m| content_text(m).contains(SUMMARY_LABEL)),
            "the summary is not one of the caller's messages"
        );
    }
}
