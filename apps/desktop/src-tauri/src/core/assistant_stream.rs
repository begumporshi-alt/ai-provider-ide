//! The in-band tool-call parser — the port of `assistant-stream.ts` (171 lines).
//!
//! Why it exists (2026-09-17, the mercury-2.5 incident): the router forwards `tools` only when a
//! caller supplies them, and Assistant supplies none. A model trained on agentic transcripts but
//! handed a toolless request will often *role-play* a tool call instead, emitting a pseudo-token
//! dialect inline:
//!
//! ```text
//! <|tool_call_start|> <function=Bash> <parameter=command> mkdir -p … </parameter> <|tool_call_end|>
//! ```
//!
//! That is model text, not an OpenAI `tool_calls` object, so nothing upstream intercepts it and it
//! used to land verbatim in the transcript. This module splits it back out: prose for the
//! transcript, tool calls for the sandbox.
//!
//! # The one structural subtlety: literals versus regexes
//!
//! The reference matches two different ways, and conflating them would be a behaviour change.
//!
//! - The seven **start/end marker pairs** are matched as **literal substrings** — `String.indexOf`,
//!   case-**sensitive**. So `<|tool_call_start|>` is a marker and `<|tool_call_start>` is not; it is
//!   ordinary text.
//! - The **`function=` and `parameter=` tags** are matched by **regex**, case-**insensitive**, and
//!   tolerate an optional leading `|` and optional whitespace: `<function=Bash>`, `<| function = Bash |>`.
//!
//! The port keeps the split: [`literal_index_of`] serves the markers, [`match_marker_at`] serves the
//! tags.
//!
//! # Three divergences, each with its reason
//!
//! 1. **The three regexes are hand-rolled.** This crate has no `regex` in its *runtime* graph — the
//!    same constraint that deferred `modality.rs` and forced the hand-rolled `parse_glm_version` in
//!    `gateway_normalizer.rs`. `/<\ |?\s*function\s*=\s*([^\s>|]+)\s*\|?>/i` and its two siblings are a
//!    fixed grammar over a short string, so they are matched directly rather than by adding a
//!    dependency. `the_hand_rolled_tags_match_the_reference_grammar` pins the grammar, including the
//!    inputs where the regex does **not** match.
//! 2. **Indices are by Unicode scalar, not UTF-16 code unit.** The reference slices by code unit;
//!    the port collects `char`s. Identical for ASCII, which is every marker and every tool name.
//! 3. **`params` is a `BTreeMap`, so key order is not preserved.** The reference builds a plain
//!    object, whose iteration order is the order of appearance. Nothing reads a parameter by
//!    position, and the only consumer serialises them as JSON for the sandbox to parse — where key
//!    order is not observable. Same divergence, and the same reason, as `gateway_normalizer`'s.
//!
//! `\s` is JavaScript's, not Unicode's: the two disagree on `\u{feff}`, which JS counts as
//! whitespace and `char::is_whitespace` does not. [`is_js_space`] is the JS set.

use std::collections::BTreeMap;

/// Marker families seen across models that imitate tool calls in-band.
///
/// **The order is *not* load-bearing, and that was measured rather than assumed.** The reference's
/// tie-break is "when two markers begin at the same offset, the earlier array entry wins" (`at <
/// startIdx`, a strict comparison). Two families can tie at one offset only if one start token is a
/// prefix of the other, and **no start token here is a prefix of any other** — 0 prefix pairs across
/// all 7, measured. A tie is therefore unreachable and `at <= s` behaves identically. The order is
/// kept because it documents the families; it decides nothing. This is not left as prose:
/// `the_marker_order_is_not_load_bearing` asserts the prefix-freeness, so adding a family that
/// *can* tie reddens it and the tie-break becomes live again — at which point this comment is wrong
/// and must be rewritten.
const MARKERS: &[(&str, &str)] = &[
    ("<|tool_call_start|>", "<|tool_call_end|>"),
    ("<|tool_calls_section_start|>", "<|tool_calls_section_end|>"),
    ("<|tool_call|>", "</|tool_call|>"),
    ("<tool_call>", "</tool_call>"),
    ("<|function_call|>", "</|function_call|>"),
    ("<function_call>", "</function_call>"),
    ("<|tool_call_begin|>", "<|tool_call_end|>"),
];

/// JavaScript's `\s`.
///
/// Not `char::is_whitespace`: that follows Unicode's `White_Space` property, which excludes
/// `U+FEFF` — a character JavaScript's `\s` includes, and the exact one a BOM-corrupted stream
/// would carry.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        ' ' | '\t'
            | '\n'
            | '\r'
            | '\u{0b}'
            | '\u{0c}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    ) || ('\u{2000}'..='\u{200a}').contains(&c)
}

/// Case-sensitive literal search — `String.prototype.indexOf`.
fn literal_index_of(hay: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    let last = hay.len() - needle.len();
    let mut i = from;
    while i <= last {
        if hay[i..i + needle.len()] == *needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Match `<|? \s* KEYWORD \s* = \s* NAME \s* |? >` at `chars[i..]`, folding case on `KEYWORD` only.
///
/// Returns the index just past the match and the captured `NAME` (`[^\s>|]+`, so at least one
/// character). A near miss returns `None` rather than a partial match, which is what the regex's
/// backtracking amounts to: `<parameter=abc|def>` matches nothing at all, because after the name
/// stops at `|` the only route to `>` is closed.
fn match_marker_at(chars: &[char], mut i: usize, keyword: &str) -> Option<(usize, String)> {
    let n = chars.len();
    if chars.get(i) != Some(&'<') {
        return None;
    }
    i += 1;
    if chars.get(i) == Some(&'|') {
        i += 1;
    }
    while i < n && is_js_space(chars[i]) {
        i += 1;
    }
    for k in keyword.chars() {
        if !chars.get(i).map(|c| c.eq_ignore_ascii_case(&k)).unwrap_or(false) {
            return None;
        }
        i += 1;
    }
    while i < n && is_js_space(chars[i]) {
        i += 1;
    }
    if chars.get(i) != Some(&'=') {
        return None;
    }
    i += 1;
    while i < n && is_js_space(chars[i]) {
        i += 1;
    }
    let name_start = i;
    while i < n && !is_js_space(chars[i]) && chars[i] != '>' && chars[i] != '|' {
        i += 1;
    }
    if i == name_start {
        return None;
    }
    let name: String = chars[name_start..i].iter().collect();
    while i < n && is_js_space(chars[i]) {
        i += 1;
    }
    if chars.get(i) == Some(&'|') {
        i += 1;
    }
    if chars.get(i) != Some(&'>') {
        return None;
    }
    Some((i + 1, name))
}

/// Every non-overlapping `parameter=` tag, left to right — the reference's global `PARAM_OPEN_RE`.
/// Returns `(start, end, name)` per match.
fn find_all_param_opens(chars: &[char]) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '<' {
            i += 1;
            continue;
        }
        match match_marker_at(chars, i, "parameter") {
            Some((end, name)) => {
                out.push((i, end, name));
                // A global regex resumes at the end of the match, not one past its start.
                i = end;
            }
            None => i += 1,
        }
    }
    out
}

/// Remove a trailing `</ parameter >` plus any whitespace after it — `PARAM_CLOSE_RE`, which is
/// anchored at the end of the string (`$`, without `m`, matches only the very end in JavaScript).
fn strip_trailing_param_close(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    for start in 0..chars.len() {
        if chars[start] != '<' {
            continue;
        }
        if let Some(end) = match_param_close_to_end(&chars, start) {
            debug_assert_eq!(end, chars.len());
            return chars[..start].iter().collect();
        }
    }
    s.to_string()
}

/// `</ \s* parameter \s* > \s*` from `start`, requiring the match to consume to the end.
fn match_param_close_to_end(chars: &[char], start: usize) -> Option<usize> {
    let n = chars.len();
    let mut i = start;
    if chars.get(i) != Some(&'<') {
        return None;
    }
    i += 1;
    if chars.get(i) != Some(&'/') {
        return None;
    }
    i += 1;
    while i < n && is_js_space(chars[i]) {
        i += 1;
    }
    for k in "parameter".chars() {
        if !chars.get(i).map(|c| c.eq_ignore_ascii_case(&k)).unwrap_or(false) {
            return None;
        }
        i += 1;
    }
    while i < n && is_js_space(chars[i]) {
        i += 1;
    }
    if chars.get(i) != Some(&'>') {
        return None;
    }
    i += 1;
    while i < n && is_js_space(chars[i]) {
        i += 1;
    }
    if i == n {
        Some(i)
    } else {
        None
    }
}

/// The first `function=` tag's name — `FUNCTION_RE.exec(body)`.
fn find_function_name(chars: &[char]) -> Option<String> {
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '<' {
            if let Some((_, name)) = match_marker_at(chars, i, "function") {
                return Some(name);
            }
        }
        i += 1;
    }
    None
}

/// Best-effort recovery of the function name and parameters from an in-band block.
///
/// Two dialects occur in the wild. Well-formed blocks close each parameter:
/// `<parameter=command>ls</parameter>`. The mercury-2.5 output did not — a parameter simply runs
/// until the next `<parameter=` (or the end of the block), so a closing tag must **not** be
/// required.
fn parse_block(body: &[char]) -> (Option<String>, BTreeMap<String, String>) {
    let opens = find_all_param_opens(body);
    let mut params: BTreeMap<String, String> = BTreeMap::new();
    for (idx, (_, end, name)) in opens.iter().enumerate() {
        let value_end = opens.get(idx + 1).map(|(start, _, _)| *start).unwrap_or(body.len());
        let value: String = body[*end..value_end].iter().collect();
        params.insert(name.clone(), strip_trailing_param_close(&value).trim().to_string());
    }
    (find_function_name(body), params)
}

/// A run of prose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextSegment {
    pub text: String,
}

/// A recovered in-band tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolSegment {
    /// The function name, when it could be recovered from the block.
    pub name: Option<String>,
    /// Recovered parameters, keyed by name. Values are raw strings.
    pub params: BTreeMap<String, String>,
    /// `false` while the closing marker has not arrived yet.
    pub complete: bool,
    /// The verbatim block body, kept for a future execution layer.
    pub raw: String,
}

/// One piece of a parsed assistant stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    Text(TextSegment),
    Tool(ToolSegment),
}

impl Segment {
    pub fn kind(&self) -> &'static str {
        match self {
            Segment::Text(_) => "text",
            Segment::Tool(_) => "tool",
        }
    }

    pub fn as_text(&self) -> Option<&TextSegment> {
        match self {
            Segment::Text(t) => Some(t),
            Segment::Tool(_) => None,
        }
    }

    pub fn as_tool(&self) -> Option<&ToolSegment> {
        match self {
            Segment::Tool(t) => Some(t),
            Segment::Text(_) => None,
        }
    }
}

/// The longest marker prefix the string ends with, if any.
///
/// The floor is **2**, so a lone `<` in prose (`a < b`) survives; the ceiling is `len - 1`, so a
/// *complete* start token is never held back — by the time this runs such a token has already been
/// consumed as a marker, and a token that is genuinely complete is not a partial one.
fn partial_marker_tail_length(chars: &[char]) -> usize {
    let mut best = 0;
    for (start, _) in MARKERS {
        let token: Vec<char> = start.chars().collect();
        let mut n = (token.len() - 1).min(chars.len());
        while n >= 2 {
            if chars.ends_with(&token[..n]) {
                best = best.max(n);
                break;
            }
            n -= 1;
        }
    }
    best
}

/// Split raw assistant output into prose and tool-call segments.
///
/// Streaming-safe: an unterminated block yields `complete: false` and is the last segment, so
/// callers can hide it until the closing marker arrives. A half-typed marker at the very end is
/// held back rather than painted.
pub fn parse_assistant_stream(src: &str) -> Vec<Segment> {
    let chars: Vec<char> = src.chars().collect();
    let mut out: Vec<Segment> = Vec::new();
    let mut i = 0usize;
    let mut text = String::new();

    while i < chars.len() {
        // The earliest start marker at or after the cursor. A tie would go to the earlier
        // `MARKERS` entry, but no two start tokens can tie — see `MARKERS`.
        let mut found: Option<(usize, usize, &'static str)> = None;
        for (start, end) in MARKERS {
            let token: Vec<char> = start.chars().collect();
            if let Some(at) = literal_index_of(&chars, &token, i) {
                if found.map(|(s, _, _)| at < s).unwrap_or(true) {
                    found = Some((at, token.len(), end));
                }
            }
        }

        let (start_idx, start_len, end_token) = match found {
            Some(v) => v,
            None => {
                text.extend(&chars[i..]);
                break;
            }
        };

        text.extend(&chars[i..start_idx]);
        if !text.is_empty() {
            out.push(Segment::Text(TextSegment { text: std::mem::take(&mut text) }));
        }

        let body_start = start_idx + start_len;
        let end_token_chars: Vec<char> = end_token.chars().collect();
        match literal_index_of(&chars, &end_token_chars, body_start) {
            None => {
                let raw: String = chars[body_start..].iter().collect();
                let (name, params) = parse_block(&chars[body_start..]);
                out.push(Segment::Tool(ToolSegment { name, params, complete: false, raw }));
                i = chars.len();
            }
            Some(end_idx) => {
                let raw: String = chars[body_start..end_idx].iter().collect();
                let (name, params) = parse_block(&chars[body_start..end_idx]);
                out.push(Segment::Tool(ToolSegment { name, params, complete: true, raw }));
                i = end_idx + end_token_chars.len();
            }
        }
    }

    if !text.is_empty() {
        out.push(Segment::Text(TextSegment { text }));
    }

    // Hold back a half-typed marker at the very end of the stream.
    let mut pop_last = false;
    if let Some(Segment::Text(last)) = out.last_mut() {
        let tail: Vec<char> = last.text.chars().collect();
        let n = partial_marker_tail_length(&tail);
        if n > 0 {
            let kept: String = tail[..tail.len() - n].iter().collect();
            if kept.is_empty() {
                pop_last = true;
            } else {
                last.text = kept;
            }
        }
    }
    if pop_last {
        out.pop();
    }

    out
}

/// Prose only: what belongs in the transcript.
pub fn visible_text(src: &str) -> String {
    parse_assistant_stream(src)
        .into_iter()
        .filter_map(|s| match s {
            Segment::Text(t) => Some(t.text),
            Segment::Tool(_) => None,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

/// Every recognised tool call, complete or not.
pub fn tool_segments(src: &str) -> Vec<ToolSegment> {
    parse_assistant_stream(src)
        .into_iter()
        .filter_map(|s| match s {
            Segment::Tool(t) => Some(t),
            Segment::Text(_) => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The verbatim failure from the 2026-09-17 mercury-2.5 report.
    const MERCURY: &str = "<|tool_call_start|> <function=Bash> <parameter=command> mkdir -p /Users/tushershikder/.zcode/skills/ai-provider-router-guide <parameter=description> Create skill directory <|tool_call_end|>";

    fn kinds(src: &str) -> Vec<&'static str> {
        parse_assistant_stream(src).iter().map(Segment::kind).collect()
    }

    #[test]
    fn leaves_ordinary_prose_untouched() {
        let src = "Here is a plain answer. 2 < 3, so it holds.";
        assert_eq!(
            parse_assistant_stream(src),
            vec![Segment::Text(TextSegment { text: src.to_string() })]
        );
    }

    #[test]
    fn extracts_a_complete_tool_call_and_keeps_the_prose_around_it() {
        let segs = parse_assistant_stream(&format!("I'll set that up. {MERCURY} Done."));
        assert_eq!(
            segs.iter().map(Segment::kind).collect::<Vec<_>>(),
            vec!["text", "tool", "text"]
        );
        let tool = segs[1].as_tool().expect("second segment is a tool call");
        assert_eq!(tool.name.as_deref(), Some("Bash"));
        assert!(tool.complete);
        assert_eq!(
            tool.params.get("command").map(String::as_str),
            Some("mkdir -p /Users/tushershikder/.zcode/skills/ai-provider-router-guide")
        );
    }

    /// The mercury dialect does not close its parameters: `description` runs to the end of the block,
    /// and `command` runs to the next `<parameter=`. Requiring a closing tag would lose both.
    #[test]
    fn recovers_the_unclosed_parameter_dialect() {
        let segs = parse_assistant_stream(MERCURY);
        let tool = segs[0].as_tool().expect("a tool segment");
        assert_eq!(
            tool.params.get("description").map(String::as_str),
            Some("Create skill directory")
        );
        assert_eq!(tool.params.len(), 2, "exactly the two declared parameters");
    }

    /// A parameter *is* trimmed when the block closes it, and the closing tag is not part of the value.
    #[test]
    fn strips_a_closing_parameter_tag_from_the_value() {
        let src = "<|tool_call_start|> <function=Write> <parameter=path> /tmp/a.md </parameter> <|tool_call_end|>";
        let tool = tool_segments(src).remove(0);
        assert_eq!(tool.params.get("path").map(String::as_str), Some("/tmp/a.md"));
    }

    #[test]
    fn marks_an_unterminated_block_incomplete_mid_stream() {
        let partial = "<|tool_call_start|> <function=Bash> <parameter=command> mkdir -p /tmp/x";
        let segs = parse_assistant_stream(partial);
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].kind(), "tool");
        assert!(!segs[0].as_tool().expect("a tool segment").complete);
        assert_eq!(visible_text(partial), "");
    }

    #[test]
    fn holds_back_a_half_typed_marker_so_it_is_never_painted() {
        assert_eq!(visible_text("Sure — <|tool_call_st"), "Sure —");
        assert_eq!(visible_text("Sure — <|tool_call"), "Sure —");
    }

    /// The floor on the held-back tail is two characters, so a bare `<|` is held but a lone `<` is not.
    #[test]
    fn holds_back_two_characters_but_never_one() {
        assert_eq!(visible_text("a <|"), "a");
        assert_eq!(visible_text("a <"), "a <");
        // A two-character tail that is not a marker prefix is left alone.
        assert_eq!(visible_text("a <x"), "a <x");
    }

    #[test]
    fn does_not_eat_a_lone_angle_bracket_in_prose() {
        assert_eq!(visible_text("a < b"), "a < b");
    }

    #[test]
    fn handles_several_blocks_in_one_response() {
        let src = format!(
            "{MERCURY} <|tool_call_start|> <function=Write> <parameter=path> /tmp/a.md </parameter> <|tool_call_end|> tail"
        );
        assert_eq!(
            tool_segments(&src).iter().map(|s| s.name.clone()).collect::<Vec<_>>(),
            vec![Some("Bash".to_string()), Some("Write".to_string())]
        );
        assert_eq!(visible_text(&src), "tail");
    }

    #[test]
    fn never_leaks_a_marker_into_visible_text() {
        assert_eq!(visible_text(MERCURY), "");
        assert!(!visible_text(MERCURY).contains("tool_call"));
        assert!(!visible_text(MERCURY).contains("function="));
    }

    /// The markers are matched as **literals**, case-sensitively. `<|tool_call_start>` — one `|`
    /// short — is not a marker, so the whole line is prose.
    #[test]
    fn a_near_miss_marker_is_not_a_marker() {
        let src = "<|tool_call_start> <function=Bash> <|tool_call_end|>";
        assert_eq!(kinds(src), vec!["text"]);
        assert_eq!(visible_text(src), src);
    }

    /// The tags are matched by regex, case-insensitively, and tolerate an optional `|` and spaces.
    #[test]
    fn the_tags_are_case_insensitive_and_tolerate_spacing() {
        let src =
            "<|tool_call_start|> <FUNCTION = Bash> <| PARAMETER = command |> ls <|tool_call_end|>";
        let tool = tool_segments(src).remove(0);
        assert_eq!(tool.name.as_deref(), Some("Bash"));
        assert_eq!(tool.params.get("command").map(String::as_str), Some("ls"));
    }

    /// The hand-rolled grammar has to agree with the reference's regexes, including where they do
    /// **not** match. `<parameter=abc|def>` matches nothing: the name stops at `|`, and the only
    /// route to `>` is then closed.
    #[test]
    fn the_hand_rolled_tags_match_the_reference_grammar() {
        let at = |s: &str| {
            let chars: Vec<char> = s.chars().collect();
            match_marker_at(&chars, 0, "parameter")
        };
        assert_eq!(at("<parameter=command>").map(|(_, n)| n), Some("command".to_string()));
        assert_eq!(at("<|parameter=command|>").map(|(_, n)| n), Some("command".to_string()));
        assert_eq!(at("<| parameter = command |>").map(|(_, n)| n), Some("command".to_string()));
        assert_eq!(at("<PARAMETER=x>").map(|(_, n)| n), Some("x".to_string()));
        assert_eq!(at("<parameter=abc|def>"), None);
        assert_eq!(at("<parameter=>"), None, "the name needs at least one character");
        assert_eq!(at("<parameter=x"), None, "an unclosed tag is not a tag");
        assert_eq!(at("<parameters=x>"), None, "the keyword must be followed by `=`");
        assert_eq!(at("parameter=x>"), None, "a missing `<` is not a tag");
    }

    /// A `function=` tag inside the body does not have to be the first tag, and a `parameter=` tag
    /// does not satisfy it.
    #[test]
    fn the_function_tag_is_found_wherever_it_sits() {
        let chars: Vec<char> = "<parameter=a>1<function=Bash>".chars().collect();
        assert_eq!(find_function_name(&chars), Some("Bash".to_string()));
        let none: Vec<char> = "<parameter=a>1".chars().collect();
        assert_eq!(find_function_name(&none), None);
    }

    /// The tail is only ever held back at the **end**, and the cap is `token.len() - 1`, so a
    /// complete marker sitting in the middle of the text is never trimmed.
    #[test]
    fn only_the_tail_is_held_back() {
        let chars: Vec<char> = "text <|tool_call_st".chars().collect();
        assert_eq!(partial_marker_tail_length(&chars), 14);
        let complete: Vec<char> = "text <|tool_call_start|>".chars().collect();
        // A complete token is not a *partial* one; the main loop consumes it before this runs.
        assert_eq!(partial_marker_tail_length(&complete), 0);
    }

    /// `raw` is the verbatim body, so a future execution layer can act on exactly what the model said.
    #[test]
    fn raw_is_the_verbatim_body() {
        let tool = tool_segments(MERCURY).remove(0);
        assert!(tool.raw.starts_with(" <function=Bash>"));
        assert!(tool.raw.ends_with("Create skill directory "));
        assert!(!tool.raw.contains("tool_call_start"));
    }

    /// JavaScript's `\s` includes `U+FEFF`, which `char::is_whitespace` does not.
    #[test]
    fn js_space_includes_the_bom_character() {
        assert!(is_js_space('\u{feff}'));
        assert!(!('\u{feff}').is_whitespace());
        assert!(is_js_space('\u{00a0}'));
        assert!(is_js_space('\u{2003}'));
        assert!(!is_js_space('x'));
    }

    /// [`MARKERS`]' order is documented as not load-bearing. That holds only while no start token
    /// is a prefix of another, because a tie needs two families to match at one offset. This is a
    /// test rather than a comment so that the day the claim stops holding is the day the build says
    /// so.
    #[test]
    fn the_marker_order_is_not_load_bearing() {
        for (i, (a, _)) in MARKERS.iter().enumerate() {
            for (j, (b, _)) in MARKERS.iter().enumerate() {
                if i == j {
                    continue;
                }
                assert!(
                    !b.starts_with(a),
                    "`{b}` starts with `{a}`, so the two can tie at one offset and the MARKERS \
                     order now decides which family is reported"
                );
            }
        }
    }
}
