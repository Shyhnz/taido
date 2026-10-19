//! E-mail addresses, passwords, tokens and the login and signup rate limits (docs/SYNC.md
//! § 4.3).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use argon2::password_hash::Error as HashError;
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use sha2::{Digest, Sha256};

use crate::error::ServerError;

/// Shortest accepted password of an account.
pub const MIN_PASSWORD_CHARS: usize = 10;
/// Longest accepted e-mail address, in characters.
pub const MAX_EMAIL_CHARS: usize = 254;
/// Failed logins (plus logins being checked) allowed per window for one e-mail address from
/// one client address.
pub const MAX_LOGIN_ATTEMPTS: usize = 10;
/// Failed logins allowed per window from one client address, whatever the e-mail: one client
/// cannot use up the global budget alone.
pub const MAX_LOGIN_ATTEMPTS_PER_CLIENT: usize = 50;
/// Failed logins allowed per window, all clients together: the bound on argon2 work spent on
/// failures (checks run one at a time, see `AppState::verify_gate`). Exhausting it takes at
/// least 20 client addresses.
pub const MAX_GLOBAL_LOGIN_ATTEMPTS: usize = 1000;
/// Signups (accepted or not, once the request is well formed) allowed per window, all
/// clients together.
pub const MAX_SIGNUPS: usize = 20;
/// Signups allowed per window from one client address.
pub const MAX_SIGNUPS_PER_CLIENT: usize = 5;
/// Window of the signup limit.
pub const SIGNUP_WINDOW: Duration = Duration::from_secs(60 * 60);
/// Window of the login rate limit.
pub const LOGIN_WINDOW: Duration = Duration::from_secs(15 * 60);
/// Longest wait for the single password-check slot before answering 429.
pub const VERIFY_WAIT: Duration = Duration::from_secs(1);

/// Forgotten-password requests allowed per window for one e-mail address (any client).
pub const MAX_FORGOTS_PER_EMAIL: usize = 3;
/// Forgotten-password requests allowed per window from one client address.
pub const MAX_FORGOTS_PER_CLIENT: usize = 10;
/// Forgotten-password requests allowed per window, all clients together (bounds the mails
/// the server can be made to send).
pub const MAX_FORGOTS: usize = 100;
/// Window of the forgotten-password limits.
pub const FORGOT_WINDOW: Duration = Duration::from_secs(60 * 60);
/// Wrong reset codes allowed per window from one client address, whatever the account: one
/// client cannot guess codes across many accounts.
pub const MAX_RESET_FAILURES_PER_CLIENT: usize = 20;
/// Wrong reset codes allowed per window, all clients together.
pub const MAX_RESET_FAILURES: usize = 1000;
/// Window of the reset limits.
pub const RESET_WINDOW: Duration = Duration::from_secs(60 * 60);
/// Tries allowed per e-mailed code; the next one fails even with the right code.
pub const MAX_CODE_ATTEMPTS: i64 = 5;
/// Lifetime of an e-mailed code.
pub const CODE_LIFETIME: Duration = Duration::from_secs(30 * 60);
/// Confirmation mails one account may ask for again, per [`RESEND_WINDOW`].
pub const MAX_RESENDS_PER_ACCOUNT: usize = 3;
/// Confirmation mails asked for again server-wide, per [`RESEND_WINDOW`].
pub const MAX_RESENDS: usize = 200;
/// Unknown or expired confirmation links one client may send, per [`RESEND_WINDOW`].
pub const MAX_CONFIRM_FAILURES_PER_CLIENT: usize = 20;
/// Unknown or expired confirmation links server-wide, per [`RESEND_WINDOW`].
pub const MAX_CONFIRM_FAILURES: usize = 1000;
/// Window of the confirmation limits.
pub const RESEND_WINDOW: Duration = Duration::from_secs(60 * 60);

/// argon2id PHC string of `password` (default parameters, random salt).
pub fn hash_password(password: &str) -> Result<String, ServerError> {
    Argon2::default()
        .hash_password(password.as_bytes())
        .map(|hash| hash.to_string())
        .map_err(|_| ServerError::PasswordHash)
}

/// Constant-time check of `password` against a stored PHC string. A corrupt hash counts as
/// a mismatch (logged).
pub fn verify_password(password: &str, phc: &str) -> bool {
    match Argon2::default().verify_password(password.as_bytes(), phc) {
        Ok(()) => true,
        Err(HashError::PasswordInvalid) => false,
        Err(err) => {
            tracing::error!(error = %err, "stored password hash is unusable");
            false
        }
    }
}

/// A hash checked when a login names an unknown address, so that it takes as long as a wrong
/// password. `None` if hashing failed (the login then answers sooner; still 401).
pub fn dummy_hash() -> Option<&'static str> {
    static DUMMY: OnceLock<Option<String>> = OnceLock::new();
    DUMMY
        .get_or_init(|| hash_password("no account has this password").ok())
        .as_deref()
}

/// A new password is long enough: at least [`MIN_PASSWORD_CHARS`] characters.
pub fn is_strong_enough(password: &str) -> bool {
    password.chars().count() >= MIN_PASSWORD_CHARS
}

/// [`is_strong_enough`] as a library error (test harness, CLI).
pub fn check_new_password(password: &str) -> Result<(), ServerError> {
    if !is_strong_enough(password) {
        return Err(ServerError::Invalid(format!(
            "the password must have at least {MIN_PASSWORD_CHARS} characters"
        )));
    }
    Ok(())
}

/// The stored form of an address: trimmed, lowercase, shaped like `x@y.z`, at most
/// [`MAX_EMAIL_CHARS`] characters. `None` when malformed.
pub fn normalize_email(raw: &str) -> Option<String> {
    let email = raw.trim().to_lowercase();
    if email.chars().count() > MAX_EMAIL_CHARS
        || email.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return None;
    }
    let (local, domain) = email.split_once('@')?;
    let labels: Vec<&str> = domain.split('.').collect();
    let well_formed = !local.is_empty()
        && !domain.contains('@')
        && labels.len() >= 2
        && labels.iter().all(|label| !label.is_empty());
    well_formed.then_some(email)
}

/// The login limiter's key for an address as typed: trimmed, lowercase, bounded (a malformed
/// address is limited like any other).
pub fn email_key(raw: &str) -> String {
    raw.trim()
        .to_lowercase()
        .chars()
        .take(MAX_EMAIL_CHARS)
        .collect()
}

/// New bearer token: 32 random bytes, base64url without padding (43 characters).
pub fn new_token() -> Result<String, ServerError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| ServerError::Random)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// What the database stores of a token: lowercase hex SHA-256.
pub fn hash_token(token: &str) -> String {
    hex_lower(&Sha256::digest(token.as_bytes()))
}

/// Lowercase hexadecimal of `bytes`.
pub fn hex_lower(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        hex.push(char::from(HEX[usize::from(byte >> 4)]));
        hex.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    hex
}

/// New reset code: six decimal digits, uniform, from the system CSPRNG.
pub fn new_reset_code() -> Result<String, ServerError> {
    // Largest multiple of 10^6 that fits in a u32: values above it are drawn again (no bias).
    const LIMIT: u32 = 4_294_000_000;
    loop {
        let mut bytes = [0u8; 4];
        getrandom::fill(&mut bytes).map_err(|_| ServerError::Random)?;
        let n = u32::from_le_bytes(bytes);
        if n < LIMIT {
            return Ok(format!("{:06}", n % 1_000_000));
        }
    }
}

/// What the database stores of a reset code: hex SHA-256 of `account_id:code`. A fast hash
/// is enough: a code lives 30 minutes and allows 5 tries, and with a million codes even
/// argon2 would not stop an offline search on a stolen database; the account id keeps
/// one table from serving every account.
pub fn hash_reset_code(account_id: &str, code: &str) -> String {
    hash_token(&format!("{account_id}:{code}"))
}

/// Equality whose time does not depend on where `a` and `b` differ (same-length inputs,
/// e.g. two hex hashes).
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

const HEX: &[u8; 16] = b"0123456789abcdef";

/// The token of an `Authorization: Bearer <token>` header value.
pub fn bearer_token(header: &str) -> Option<&str> {
    let token = header.strip_prefix("Bearer ")?.trim();
    (!token.is_empty() && token.len() <= 256).then_some(token)
}

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct LimiterState {
    failures: VecDeque<Instant>,
    in_flight: u32,
}

/// One login limiter: failures in the last window plus attempts being checked must stay
/// below its maximum. A slot is reserved **before** the
/// password is checked, so parallel attempts cannot exceed the limit. In memory.
#[derive(Debug)]
pub struct LoginLimiter {
    state: Mutex<LimiterState>,
    max: usize,
    window: Duration,
}

impl Default for LoginLimiter {
    fn default() -> Self {
        Self::new(MAX_LOGIN_ATTEMPTS, LOGIN_WINDOW)
    }
}

impl LoginLimiter {
    pub fn new(max: usize, window: Duration) -> Self {
        LoginLimiter {
            state: Mutex::new(LimiterState::default()),
            max,
            window,
        }
    }

    fn lock(&self) -> MutexGuard<'_, LimiterState> {
        // The state stays consistent even if a holder panicked: recover it.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Reserves a slot for one password check, or `None` when the limit is reached.
    pub fn try_reserve(self: &Arc<Self>, now: Instant) -> Option<Reservation> {
        let mut state = self.lock();
        while let Some(&oldest) = state.failures.front() {
            if now.saturating_duration_since(oldest) >= self.window {
                state.failures.pop_front();
            } else {
                break;
            }
        }
        let used = state.failures.len() + usize::try_from(state.in_flight).unwrap_or(usize::MAX);
        if used >= self.max {
            return None;
        }
        state.in_flight += 1;
        Some(Reservation {
            limiter: Arc::clone(self),
        })
    }

    /// No failure in the window and nothing in flight (an idle per-client limiter is dropped).
    fn is_idle(&self, now: Instant) -> bool {
        let state = self.lock();
        state.in_flight == 0
            && state
                .failures
                .back()
                .is_none_or(|&last| now.saturating_duration_since(last) >= self.window)
    }

    #[cfg(test)]
    fn counts(&self) -> (usize, u32) {
        let state = self.lock();
        (state.failures.len(), state.in_flight)
    }
}

/// A reserved slot; releases it on drop (also on error or panic).
#[derive(Debug)]
pub struct Reservation {
    limiter: Arc<LoginLimiter>,
}

impl Reservation {
    /// Records a failed check at `now`.
    pub fn fail(&self, now: Instant) {
        self.limiter.lock().failures.push_back(now);
    }
}

/// A rate limit (docs/SYNC.md § 4.3): one [`LoginLimiter`] per key, each with its own maximum,
/// plus a global one. Logins use two keys — (e-mail, client address) and client address —
/// so that guesses from one client lock out neither the account elsewhere nor the others;
/// signups use the client address.
#[derive(Debug)]
pub struct LoginLimits {
    global: Arc<LoginLimiter>,
    clients: Mutex<HashMap<String, Arc<LoginLimiter>>>,
    per_client: usize,
    window: Duration,
}

impl Default for LoginLimits {
    fn default() -> Self {
        Self::new(MAX_LOGIN_ATTEMPTS, MAX_GLOBAL_LOGIN_ATTEMPTS, LOGIN_WINDOW)
    }
}

impl LoginLimits {
    pub fn new(per_client: usize, global: usize, window: Duration) -> Self {
        LoginLimits {
            global: Arc::new(LoginLimiter::new(global, window)),
            clients: Mutex::new(HashMap::new()),
            per_client,
            window,
        }
    }

    /// Reserves a slot for one attempt by `client` (limit `per_client`), or `None` when its
    /// limit or the global one is reached.
    pub fn try_reserve(&self, client: &str, now: Instant) -> Option<LoginSlot> {
        self.try_reserve_keys(&[(client, self.per_client)], now)
    }

    /// Reserves a slot under every `(key, maximum)` and the global limit, or `None` when one
    /// of them is reached (slots already taken are released). A key keeps the maximum it was
    /// first created with while it stays in the window: give distinct kinds distinct prefixes.
    pub fn try_reserve_keys(&self, keys: &[(&str, usize)], now: Instant) -> Option<LoginSlot> {
        let keyed = {
            let mut clients = self.clients.lock().unwrap_or_else(|e| e.into_inner());
            // Bounded: a key stays only while it has failures in the window (at most the
            // global maximum per key kind) or a check in flight.
            clients.retain(|_, l| !l.is_idle(now));
            let mut keyed = Vec::with_capacity(keys.len());
            for (key, max) in keys {
                let limiter = clients
                    .entry((*key).to_string())
                    .or_insert_with(|| Arc::new(LoginLimiter::new(*max, self.window)));
                // Reserved while the map is locked: otherwise a parallel `retain` could drop
                // this still idle limiter and create a second one for the same key, each
                // granting its own slots. Lock order is always map, then limiter; a
                // reservation's drop or `fail` takes only its limiter. On `None`, the slots
                // already taken are released by their drop.
                keyed.push(limiter.try_reserve(now)?);
            }
            keyed
        };
        let global = self.global.try_reserve(now)?;
        Some(LoginSlot { keyed, global })
    }
}

/// A reserved slot of [`LoginLimits`]; released on drop.
#[derive(Debug)]
pub struct LoginSlot {
    keyed: Vec<Reservation>,
    global: Reservation,
}

impl LoginSlot {
    /// Records a failed check (or, for signups, an attempt) at `now`.
    pub fn fail(&self, now: Instant) {
        for reservation in &self.keyed {
            reservation.fail(now);
        }
        self.global.fail(now);
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        let mut state = self.limiter.lock();
        state.in_flight = state.in_flight.saturating_sub(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_hash_round_trip() {
        let hash = hash_password("correct horse battery").expect("hash");
        assert!(hash.starts_with("$argon2id$"));
        assert!(verify_password("correct horse battery", &hash));
        assert!(!verify_password("wrong horse battery", &hash));
        assert!(!verify_password("anything", "not a phc string"));
    }

    #[test]
    fn new_password_needs_ten_characters() {
        assert!(check_new_password("short").is_err());
        assert!(!is_strong_enough("élevé-éle")); // 9 characters, more bytes
        assert!(is_strong_enough("élevé-élev"));
        assert!(check_new_password("ten chars!").is_ok());
    }

    #[test]
    fn emails_are_trimmed_lowercase_and_shaped_like_x_at_y_dot_z() {
        assert_eq!(
            normalize_email("  User.Name@Example.COM ").as_deref(),
            Some("user.name@example.com")
        );
        assert_eq!(normalize_email("a@b.co").as_deref(), Some("a@b.co"));
        for bad in [
            "",
            "user",
            "@example.com",
            "user@",
            "user@example",
            "user@.com",
            "user@example.",
            "user@exa..mple.com",
            "eli ot@example.com",
            "a@b@example.com",
            "user@exam\nple.com",
        ] {
            assert_eq!(normalize_email(bad), None, "{bad:?}");
        }
        let long_local = "a".repeat(MAX_EMAIL_CHARS - "@b.co".len());
        assert!(normalize_email(&format!("{long_local}@b.co")).is_some());
        assert!(normalize_email(&format!("{long_local}a@b.co")).is_none());
        assert_eq!(email_key(" A@B.co "), "a@b.co");
        assert_eq!(email_key(&"x".repeat(1000)).len(), MAX_EMAIL_CHARS);
    }

    #[test]
    fn tokens_are_43_url_safe_characters_and_unique() {
        let a = new_token().expect("token");
        let b = new_token().expect("token");
        assert_eq!(a.len(), 43);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(a, b);
    }

    #[test]
    fn token_hash_is_hex_sha256() {
        // SHA-256("abc"), FIPS 180-2 test vector.
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(hash_token("x").len(), 64);
    }

    #[test]
    fn reset_codes_are_six_digits_and_hashed_per_account() {
        for _ in 0..200 {
            let code = new_reset_code().expect("code");
            assert_eq!(code.len(), 6);
            assert!(code.chars().all(|c| c.is_ascii_digit()));
        }
        let a = hash_reset_code("account-a", "123456");
        assert_eq!(a.len(), 64);
        assert_ne!(a, hash_reset_code("account-b", "123456"));
        assert_ne!(a, hash_reset_code("account-a", "123457"));
        assert!(!a.contains("123456"));
    }

    #[test]
    fn constant_time_equality() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(constant_time_eq("", ""));
    }

    #[test]
    fn bearer_header_parsing() {
        assert_eq!(bearer_token("Bearer abc"), Some("abc"));
        assert_eq!(bearer_token("Bearer "), None);
        assert_eq!(bearer_token("Basic abc"), None);
        assert_eq!(bearer_token(&format!("Bearer {}", "a".repeat(300))), None);
    }

    #[test]
    fn limiter_counts_failures_in_the_window() {
        let limiter = Arc::new(LoginLimiter::new(3, Duration::from_secs(60)));
        let t0 = Instant::now();
        for _ in 0..3 {
            let slot = limiter.try_reserve(t0).expect("slot");
            slot.fail(t0);
        }
        assert!(limiter.try_reserve(t0).is_none());
        assert!(limiter.try_reserve(t0 + Duration::from_secs(59)).is_none());
        // The failures leave the window.
        assert!(limiter.try_reserve(t0 + Duration::from_secs(60)).is_some());
        assert_eq!(limiter.counts(), (0, 0));
    }

    #[test]
    fn limiter_reserves_in_flight_attempts() {
        let limiter = Arc::new(LoginLimiter::new(2, Duration::from_secs(60)));
        let now = Instant::now();
        let a = limiter.try_reserve(now).expect("a");
        let b = limiter.try_reserve(now).expect("b");
        assert!(limiter.try_reserve(now).is_none(), "two checks in flight");
        assert_eq!(limiter.counts(), (0, 2));
        drop(a); // success: slot released, nothing recorded
        let c = limiter.try_reserve(now).expect("c");
        b.fail(now);
        drop(b);
        assert!(
            limiter.try_reserve(now).is_none(),
            "one failure + one in flight"
        );
        drop(c);
        assert_eq!(limiter.counts(), (1, 0));
        assert!(limiter.try_reserve(now).is_some());
    }

    #[test]
    fn one_client_failing_does_not_lock_out_another() {
        let limits = LoginLimits::new(2, 3, Duration::from_secs(60));
        let now = Instant::now();
        for _ in 0..2 {
            limits.try_reserve("attacker", now).expect("slot").fail(now);
        }
        assert!(limits.try_reserve("attacker", now).is_none());
        // The user, from another address, can still log in.
        assert!(limits.try_reserve("user", now).is_some());
        // The global limit bounds every client together.
        limits.try_reserve("other", now).expect("slot").fail(now);
        assert!(limits.try_reserve("user", now).is_none());
        // Everything leaves the window, and idle clients are forgotten.
        let later = now + Duration::from_secs(60);
        assert!(limits.try_reserve("user", later).is_some());
        assert_eq!(limits.clients.lock().expect("clients").len(), 1);
    }

    #[test]
    fn several_keys_each_keep_their_own_maximum() {
        let limits = LoginLimits::new(2, 100, Duration::from_secs(60));
        let now = Instant::now();
        for _ in 0..2 {
            limits
                .try_reserve_keys(&[("pair:alice|A", 2), ("ip:A", 3)], now)
                .expect("slot")
                .fail(now);
        }
        assert!(limits
            .try_reserve_keys(&[("pair:alice|A", 2), ("ip:A", 3)], now)
            .is_none());
        // Same client, another address: only the client's third failure is left.
        limits
            .try_reserve_keys(&[("pair:bob|A", 2), ("ip:A", 3)], now)
            .expect("slot")
            .fail(now);
        assert!(limits
            .try_reserve_keys(&[("pair:bob|A", 2), ("ip:A", 3)], now)
            .is_none());
        // A refused reservation released the slots it had taken.
        assert!(limits
            .try_reserve_keys(&[("pair:alice|B", 2), ("ip:B", 3)], now)
            .is_some());
        assert_eq!(limits.global.counts(), (3, 0));
    }

    #[test]
    fn parallel_reservations_of_one_key_never_exceed_its_maximum() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Barrier;
        const THREADS: usize = 8;
        const ROUNDS: usize = 200;
        const MAX: usize = 2;
        let limits = Arc::new(LoginLimits::new(MAX, 1000, Duration::from_secs(60)));
        let barrier = Arc::new(Barrier::new(THREADS));
        let granted = Arc::new(AtomicUsize::new(0));
        let worst = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..THREADS)
            .map(|_| {
                let (limits, barrier) = (Arc::clone(&limits), Arc::clone(&barrier));
                let (granted, worst) = (Arc::clone(&granted), Arc::clone(&worst));
                std::thread::spawn(move || {
                    for _ in 0..ROUNDS {
                        // Every thread asks at once; the slots are held until all have asked,
                        // then released before the next round starts.
                        barrier.wait();
                        let slot = limits.try_reserve_keys(&[("ip:A", MAX)], Instant::now());
                        if slot.is_some() {
                            granted.fetch_add(1, Ordering::SeqCst);
                        }
                        if barrier.wait().is_leader() {
                            worst.fetch_max(granted.swap(0, Ordering::SeqCst), Ordering::SeqCst);
                        }
                        drop(slot);
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().expect("thread");
        }
        let worst = worst.load(Ordering::SeqCst);
        assert!(worst <= MAX, "{worst} slots granted at once (max {MAX})");
        assert!(worst >= 1);
        assert_eq!(limits.global.counts(), (0, 0));
    }

    #[test]
    fn reservation_is_released_on_panic() {
        let limiter = Arc::new(LoginLimiter::new(1, Duration::from_secs(60)));
        let l2 = Arc::clone(&limiter);
        let result = std::thread::spawn(move || {
            let _slot = l2.try_reserve(Instant::now()).expect("slot");
            panic!("boom");
        })
        .join();
        assert!(result.is_err());
        assert_eq!(limiter.counts(), (0, 0));
    }
}
