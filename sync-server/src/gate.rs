//! Bodies waiting in memory: a sync push or a file chunk takes a
//! slot of its account ([`PER_ACCOUNT`]) and one of the server ([`GLOBAL`]) **before** its body
//! is read, and waits at most [`WAIT`] for them (then 429 `rate_limited`). Downloads (GET) are
//! never gated.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Slots of one account: its Mac and its phone may send at the same time.
pub const PER_ACCOUNT: usize = 2;
/// Slots of the server: at most 16 bodies of 16 MiB (256 MiB of raw bytes) in memory at once.
pub const GLOBAL: usize = 16;
/// Parsed sync requests alive at once, server-wide. A parsed JSON tree takes far more than its
/// bytes (about 32 B per value: a 16 MiB body of tiny values may reach 256-512 MiB), so a sync
/// holds one of these 2 slots from its parse until its database work ends (about 1 GiB worst
/// case), whatever [`GLOBAL`] lets wait in memory as raw bytes.
pub const PARSES: usize = 2;
/// Longest wait for the slots.
pub const WAIT: Duration = Duration::from_secs(30);

/// The slots, per account and for the server. An account's semaphore is kept for the life
/// of the process (a few bytes per account).
pub struct BodyGates {
    per_account: usize,
    global: Arc<Semaphore>,
    accounts: Mutex<HashMap<String, Arc<Semaphore>>>,
    wait: Duration,
}

/// Both slots of a request, released when dropped (once the response is built).
pub struct BodyPermit {
    _account: OwnedSemaphorePermit,
    _global: OwnedSemaphorePermit,
}

impl Default for BodyGates {
    fn default() -> Self {
        BodyGates::new(PER_ACCOUNT, GLOBAL, WAIT)
    }
}

impl BodyGates {
    pub fn new(per_account: usize, global: usize, wait: Duration) -> Self {
        BodyGates {
            per_account,
            global: Arc::new(Semaphore::new(global)),
            accounts: Mutex::new(HashMap::new()),
            wait,
        }
    }

    /// The account's slot, then a server slot (in that order: an account's own queue never
    /// holds a server slot), or `None` after the wait.
    pub async fn enter(&self, account_id: &str) -> Option<BodyPermit> {
        let account = {
            let mut accounts = self.accounts.lock().unwrap_or_else(PoisonError::into_inner);
            Arc::clone(
                accounts
                    .entry(account_id.to_string())
                    .or_insert_with(|| Arc::new(Semaphore::new(self.per_account))),
            )
        };
        let deadline = tokio::time::Instant::now() + self.wait;
        let account = tokio::time::timeout_at(deadline, account.acquire_owned())
            .await
            .ok()?
            .ok()?;
        let global = tokio::time::timeout_at(deadline, Arc::clone(&self.global).acquire_owned())
            .await
            .ok()?
            .ok()?;
        Some(BodyPermit {
            _account: account,
            _global: global,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::BodyGates;

    const SHORT: Duration = Duration::from_millis(50);

    #[tokio::test]
    async fn an_account_gets_two_slots_then_waits() {
        let gates = BodyGates::new(2, 16, SHORT);
        let mac = gates.enter("a").await.expect("mac");
        let phone = gates.enter("a").await.expect("phone");
        assert!(
            gates.enter("a").await.is_none(),
            "third request of the account"
        );
        assert!(
            gates.enter("b").await.is_some(),
            "another account is not held up"
        );
        drop(mac);
        assert!(gates.enter("a").await.is_some(), "a freed slot is reused");
        drop(phone);
    }

    #[tokio::test]
    async fn the_server_slots_are_shared_by_all_accounts() {
        let gates = BodyGates::new(2, 3, SHORT);
        let _a1 = gates.enter("a").await.expect("a1");
        let _a2 = gates.enter("a").await.expect("a2");
        let _b1 = gates.enter("b").await.expect("b1");
        assert!(gates.enter("c").await.is_none());
    }

    #[tokio::test]
    async fn a_waiting_request_gets_the_slot_when_it_frees() {
        let gates = std::sync::Arc::new(BodyGates::new(1, 16, Duration::from_secs(5)));
        let first = gates.enter("a").await.expect("first");
        let waiter = {
            let gates = std::sync::Arc::clone(&gates);
            tokio::spawn(async move { gates.enter("a").await.is_some() })
        };
        tokio::time::sleep(SHORT).await;
        drop(first);
        assert!(waiter.await.expect("join"));
    }
}
