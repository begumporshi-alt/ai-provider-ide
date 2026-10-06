//! The image loop — the plan walked to one image (D98 phase 4). The D22 asymmetry (image
//! attempts cannot re-classify, so the loop treats a refusal differently from the text loop)
//! moves untouched. Depends on the taxonomy, the attempt vocabulary, and the adapter's ImageArgs.
use crate::core::adapter::{AdapterFactory, Cancel, ImageArgs};
use crate::core::limiter::ProviderLimiter;
use crate::core::planner::Candidate;

use super::attempt::{labelled, saturated_outcome, attempt_budget, AttemptOutcome};
use super::health::HealthTracker;
use super::taxonomy::{classify, reason_from_body, BodyHint, ErrorClass};
use super::{transport_outcome, AllAttemptsFailed};

/// What one image request is asked to do. The Rust port of `executeImage`'s argument
/// (`execution-engine.ts:154-161`).
///
/// The plan is taken **by value**, where the TypeScript borrows its array: the serving candidate is
/// returned to the caller, and moving it out of the plan is how that is done without cloning three
/// rows. The plan is not reused after a request either way.
pub struct ExecuteImageArgs {
    pub plan: Vec<Candidate>,
    pub prompt: String,
    /// The model the caller asked for, as the caller named it — carried only so a failure can name
    /// it. The candidate's own `model.native_id` is what is actually sent.
    pub model: String,
    pub size: Option<String>,
    pub max_attempts: Option<usize>,
}

/// A served image request. The TypeScript returns this shape inline (`execution-engine.ts:161`).
#[derive(Debug)]
pub struct ImageSuccess {
    /// The candidate that served it.
    pub candidate: Candidate,
    pub base64: Option<String>,
    pub url: Option<String>,
    /// Every attempt that failed before this one succeeded, in the order they were tried.
    pub attempts: Vec<AttemptOutcome>,
}

/// Try each candidate in the plan until one returns an image. The Rust port of `executeImage`
/// (`execution-engine.ts:154-194`).
///
/// **`Err` is the whole-failure case, and an empty plan is one of them.** The TypeScript falls out
/// of the loop and throws unconditionally (`:193`), so a plan of zero candidates is a failure
/// rather than an empty success. [`attempt_budget`] is what turns `None` into
/// [`MAX_ATTEMPTS_DEFAULT`] and `Some(0)` into *zero* — the distinction that function exists to
/// keep, and the one a `||` would silently lose.
///
/// **Cancellation is checked before the cap** (`:165` then `:167`). The order is observable: a
/// cancelled request must not take a limiter slot on its way out.
///
/// **A saturation skip is recorded, not merely skipped.** [`saturated_outcome`] supplies the
/// `RATE_LIMITED`/`429` the TypeScript pushes at `:169`, even though the provider was never
/// contacted — `core::limiter` carries the argument for keeping that class.
///
/// **`Err` from the adapter is always `Network`, whatever it carries — and that is asymmetric with
/// the text path.** `executeText` classifies a thrown `ManifestHttpError` by its status (`:113`,
/// `:117-121`); `executeImage`'s `catch {}` (`:186`) discards the error and names no class but
/// `NETWORK`. The two agree today only because `generateImage` **returns** a refusal as
/// `{ok: false, status}` (`manifest-interpreter.ts:461`) rather than throwing it, so a
/// status-bearing error never reaches that arm. The port keeps the image path's behaviour, and
/// `a_status_bearing_adapter_error_still_records_network` is what pins it. Recorded as D22.
///
/// **A refusal cools its key by the tracker's floor, never by the provider's own wait.** That
/// follows from the same place: `ImageAttemptResult` is `{ok, status, errorBody?}`
/// (`manifest-interpreter.ts:57-60`) and has **nowhere to put** a `Retry-After`, so `:184-185`
/// records an outcome with no `retry_after_ms` and `recordResult` falls through to
/// [`COOLDOWN_FLOOR_MS`]. A `429 Retry-After: 30` on the image path therefore retries after one
/// second — the exact failure the text path's fix describes at `:126-128`, one path away. Recorded
/// as D22; `an_image_refusal_cools_its_key_by_the_floor_not_the_named_wait` pins it.
pub async fn execute_image(
    adapters: &dyn AdapterFactory,
    health: &HealthTracker,
    limiter: Option<&ProviderLimiter>,
    args: ExecuteImageArgs,
    cancel: &Cancel,
) -> Result<ImageSuccess, AllAttemptsFailed> {
    let mut attempts: Vec<AttemptOutcome> = Vec::new();
    let budget = attempt_budget(args.plan.len(), args.max_attempts);

    for candidate in args.plan.into_iter().take(budget) {
        // `:165`, before the cap so a cancelled request takes no slot.
        if cancel.is_cancelled() {
            break;
        }
        // `:167-171`. `acquire` is the check *and* the increment; asking `has_capacity` first would
        // reintroduce the race `limiter.rs` exists to remove. `None` from `acquire` is a saturated
        // provider, and `None` from `limiter` is no limiter at all — which is why the two are told
        // apart by `limiter.is_some()` rather than by the `Option` alone.
        let release = limiter.and_then(|l| l.acquire(&candidate.provider.id));
        if limiter.is_some() && release.is_none() {
            attempts.push(labelled(saturated_outcome(), &candidate));
            continue;
        }

        // `:174-178`. Owned rather than borrowed, so one is built per attempt; the TypeScript
        // builds a fresh object literal per call too.
        let image_args = ImageArgs {
            model: candidate.model.native_id.clone(),
            prompt: args.prompt.clone(),
            size: args.size.clone(),
        };

        // `:172-188`, with the factory rejection and the adapter rejection collapsed into the one
        // `catch {}` the TypeScript has — both are `Network`/`0` there.
        let outcome = match adapters.for_provider(&candidate.provider.id).await {
            Err(_) => labelled(transport_outcome(), &candidate),
            Ok(adapter) => {
                match adapter.generate_image(&candidate.key.secret_ref, image_args, cancel).await {
                    Err(_) => labelled(transport_outcome(), &candidate),
                    // `:179-182` — the only success arm, and the only one that returns.
                    Ok(reply) if reply.ok => {
                        health.record_result(&candidate.key.id, ErrorClass::Ok, None, now_ms());
                        return Ok(ImageSuccess {
                            candidate,
                            base64: reply.base64,
                            url: reply.url,
                            attempts,
                        });
                    }
                    // `:183-185` — a refusal is an `Ok` reply with `ok: false`, and its status is
                    // what gets classified. `retry_after_ms` is `None` because the reply shape has
                    // no field for it; see the doc comment above and D22.
                    Ok(reply) => labelled(
                        AttemptOutcome {
                            // `classify`, not `classify_attempt_error`: the reply is a *value*,
                            // not an error, so the gate hint comes straight from its body.
                            cls: {
                                let hint = crate::core::client_gate::detect_client_gate(
                                    reply.status,
                                    reply.error_body.as_deref(),
                                )
                                .map(|_| BodyHint::ClientGate)
                                .or_else(|| {
                                    crate::core::client_gate::detect_not_found(
                                        reply.status,
                                        reply.error_body.as_deref(),
                                    )
                                    .map(|_| BodyHint::NotFound)
                                });
                                classify(reply.status, hint)
                            },
                            status: reply.status,
                            retry_after_ms: None,
                            reason: reason_from_body(reply.error_body.as_deref()),
                            label: None,
                        },
                        &candidate,
                    ),
                }
            }
        };

        // Read before the push, because an outcome is no longer `Copy` — it carries its label.
        let (cls, retry_after_ms) = (outcome.cls, outcome.retry_after_ms);
        health.record_result(&candidate.key.id, cls, retry_after_ms, now_ms());
        attempts.push(outcome);
        // `:189-191`'s `finally` is the `Permit`'s `Drop` here — on this path, on the `return`
        // above, and on a panic alike. There is nothing to remember to call.
    }

    Err(AllAttemptsFailed::new(args.model, attempts))
}

/// Wall-clock milliseconds. A private copy, matching the eight other modules that each carry one
/// (`persist.rs:22`, `capture.rs:108`, …) — this crate has no shared clock.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
