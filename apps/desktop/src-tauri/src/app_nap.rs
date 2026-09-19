/**
 * App Nap suppression (macOS).
 *
 * The gateway's router core lives in a hidden webview, and its liveness is proven by a
 * heartbeat. macOS suspends JavaScript in hidden and backgrounded processes — App Nap for the
 * process, and WebKit throttling for the page. Either way the heartbeat stops, the watchdog
 * sees a stale beat, and requests fail or, worse, wait on a worker that will never answer.
 *
 * A heartbeat-based recovery can only paper over that: it notices the suspension after the
 * fact and re-warms, which is why requests during the cooldown were refused outright and one
 * observed turn hung past 60 seconds. The honest fix is to tell macOS this process is doing
 * user-initiated work and must not be napped.
 *
 * `NSActivityUserInitiatedAllowingIdleSystemSleep` is deliberately chosen over
 * `NSActivityUserInitiated`: it suppresses App Nap and timer coalescing, but still lets the
 * machine go to sleep when idle. A local gateway should stay responsive while the user is at
 * the machine without keeping a laptop awake all night.
 *
 * The returned activity token is what holds the assertion. Dropping it ends the suppression,
 * so it is leaked on purpose for the lifetime of the process — which is exactly what we want.
 */

#[cfg(target_os = "macos")]
pub fn suppress_app_nap() {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    let info = NSProcessInfo::processInfo();
    let reason = NSString::from_str("AI-Provider Router is serving gateway requests");
    let activity = info.beginActivityWithOptions_reason(
        NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
        &reason,
    );
    // Leak: the token must outlive every request. `forget` keeps its +1 retain count, so the
    // assertion stays in force until the process exits and the kernel tears it down anyway.
    std::mem::forget(activity);
    tracing::info!("app nap suppressed: gateway worker will not be suspended while idle");
}

#[cfg(not(target_os = "macos"))]
pub fn suppress_app_nap() {}
