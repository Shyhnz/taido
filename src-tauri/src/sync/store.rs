//! Sync settings (rows of `settings`, never synced, never in `Settings`; docs/SYNC.md § 3.3)
//! and the small queries on the sync tables shared by the engine and the service.

use rusqlite::{params, Connection};

use crate::db::settings::{read, remove, write};
use crate::error::AppResult;
use crate::sync::model::{AccountInfo, SyncErrorKind, SyncState, SyncStatus};

pub const SERVER_URL: &str = "sync_server_url";
pub const TOKEN: &str = "sync_token";
pub const DEVICE_ID: &str = "sync_device_id";
pub const SERVER_EPOCH: &str = "sync_server_epoch";
pub const CURSOR: &str = "sync_cursor";
pub const INTERVAL_MINUTES: &str = "sync_interval_minutes";
pub const LAST_SUCCESS_AT: &str = "sync_last_success_at";
pub const LAST_ERROR: &str = "sync_last_error";
/// The linked account (`AccountInfo` as JSON), read from the server at link and after each
/// successful run.
pub const ACCOUNT: &str = "sync_account";
/// Wire names of the entities this Mac declared in its last sync request (JSON list).
pub const KNOWN_ENTITIES: &str = "sync_known_entities";

/// Accepted values of the automatic sync interval, in minutes.
pub const INTERVALS: [u32; 5] = [1, 5, 15, 30, 60];
pub const DEFAULT_INTERVAL: u32 = 5;

/// What a linked device needs to talk to the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub server_url: String,
    pub token: String,
    pub device_id: String,
    pub server_epoch: String,
}

/// The current link, `None` when unlinked (no token).
pub fn link(conn: &Connection) -> AppResult<Option<Link>> {
    let Some(token) = read::<String>(conn, TOKEN)? else {
        return Ok(None);
    };
    Ok(Some(Link {
        server_url: read::<String>(conn, SERVER_URL)?.unwrap_or_default(),
        token,
        device_id: read::<String>(conn, DEVICE_ID)?.unwrap_or_default(),
        server_epoch: read::<String>(conn, SERVER_EPOCH)?.unwrap_or_default(),
    }))
}

pub fn is_linked(conn: &Connection) -> AppResult<bool> {
    Ok(read::<String>(conn, TOKEN)?.is_some())
}

/// Stores a fresh link: url, token, device, epoch, cursor 0; clears the last error, the last
/// success and the account (of the previous link).
pub fn save_link(conn: &Connection, link: &Link) -> AppResult<()> {
    write(conn, SERVER_URL, &link.server_url)?;
    write(conn, TOKEN, &link.token)?;
    write(conn, DEVICE_ID, &link.device_id)?;
    write(conn, SERVER_EPOCH, &link.server_epoch)?;
    write(conn, CURSOR, &0u64)?;
    remove(conn, LAST_SUCCESS_AT)?;
    remove(conn, ACCOUNT)?;
    remove(conn, LAST_ERROR)
}

/// Forgets what a previous link learnt from its server (a V1 server, another account): the
/// cursor, the epoch, the known versions and the parked rows. Called before every new link;
/// the outbox (real local edits) is kept, and the link re-enqueues every row (§ 2.6).
pub fn forget_server_state(conn: &Connection) -> AppResult<()> {
    remove(conn, CURSOR)?;
    remove(conn, SERVER_EPOCH)?;
    conn.execute_batch("DELETE FROM sync_known; DELETE FROM sync_parked;")?;
    Ok(())
}

/// Forgets the link and the account; keeps the URL (prefills the form), the interval, the
/// outbox, the known versions and the parked rows.
pub fn clear_link(conn: &Connection) -> AppResult<()> {
    for key in [
        TOKEN,
        DEVICE_ID,
        SERVER_EPOCH,
        CURSOR,
        LAST_SUCCESS_AT,
        LAST_ERROR,
        ACCOUNT,
    ] {
        remove(conn, key)?;
    }
    Ok(())
}

/// The cached account, `None` when unlinked or not read yet.
pub fn account(conn: &Connection) -> AppResult<Option<AccountInfo>> {
    if !is_linked(conn)? {
        return Ok(None);
    }
    read::<AccountInfo>(conn, ACCOUNT)
}

pub fn set_account(conn: &Connection, account: &AccountInfo) -> AppResult<()> {
    write(conn, ACCOUNT, account)
}

pub fn cursor(conn: &Connection) -> AppResult<u64> {
    Ok(read::<u64>(conn, CURSOR)?.unwrap_or(0))
}

pub fn set_cursor(conn: &Connection, cursor: u64) -> AppResult<()> {
    write(conn, CURSOR, &cursor)
}

/// Records the entities this Mac declares to the server. When the set grew since the last
/// declaration (a new build, or a build made before the declaration existed), the cursor goes
/// back to 0 once: rows of the new entities the server held back from the older build are
/// pulled. Returns whether the cursor was reset.
pub fn declare_entities(conn: &Connection, names: &[String]) -> AppResult<bool> {
    let before = read::<Vec<String>>(conn, KNOWN_ENTITIES)?;
    let grew = before
        .as_ref()
        .is_none_or(|known| names.iter().any(|n| !known.contains(n)));
    if grew {
        set_cursor(conn, 0)?;
    }
    if before.as_deref() != Some(names) {
        write(conn, KNOWN_ENTITIES, &names)?;
    }
    Ok(grew)
}

pub fn set_epoch(conn: &Connection, epoch: &str) -> AppResult<()> {
    write(conn, SERVER_EPOCH, &epoch)
}

pub fn interval_minutes(conn: &Connection) -> AppResult<u32> {
    Ok(read::<u32>(conn, INTERVAL_MINUTES)?
        .filter(|m| INTERVALS.contains(m))
        .unwrap_or(DEFAULT_INTERVAL))
}

pub fn set_interval_minutes(conn: &Connection, minutes: u32) -> AppResult<()> {
    write(conn, INTERVAL_MINUTES, &minutes)
}

pub fn last_error(conn: &Connection) -> AppResult<Option<SyncErrorKind>> {
    Ok(read::<Option<SyncErrorKind>>(conn, LAST_ERROR)?.flatten())
}

/// A successful run: `last_success_at = at`, last error cleared.
pub fn record_success(conn: &Connection, at: &str) -> AppResult<()> {
    write(conn, LAST_SUCCESS_AT, &at)?;
    remove(conn, LAST_ERROR)
}

pub fn record_error(conn: &Connection, kind: SyncErrorKind) -> AppResult<()> {
    write(conn, LAST_ERROR, &Some(kind))
}

/// Rows waiting in the outbox.
pub fn pending(conn: &Connection) -> AppResult<u32> {
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM sync_outbox", [], |r| r.get(0))?;
    Ok(u32::try_from(n).unwrap_or(u32::MAX))
}

/// The status view model. `running`: a run is in flight; `offline`: the last run could not
/// reach the server (kept in memory by the service).
pub fn status(conn: &Connection, running: bool, offline: bool) -> AppResult<SyncStatus> {
    let linked = is_linked(conn)?;
    let error_kind = if linked { last_error(conn)? } else { None };
    let state = if !linked {
        SyncState::Unlinked
    } else if running {
        SyncState::Syncing
    } else if offline {
        SyncState::Offline
    } else if error_kind.is_some() {
        SyncState::Error
    } else {
        SyncState::Idle
    };
    Ok(SyncStatus {
        state,
        server_url: read::<String>(conn, SERVER_URL)?,
        interval_minutes: interval_minutes(conn)?,
        last_sync_at: if linked {
            read::<String>(conn, LAST_SUCCESS_AT)?
        } else {
            None
        },
        error_kind: if state == SyncState::Error {
            error_kind
        } else {
            None
        },
        pending: pending(conn)?,
    })
}

/// Sets the `applying` flag of the triggers (docs/SYNC.md § 3.1).
pub fn set_applying(conn: &Connection, applying: bool) -> AppResult<()> {
    conn.execute(
        "UPDATE sync_guard SET applying = ?1 WHERE id = 1",
        [i64::from(applying)],
    )?;
    Ok(())
}

/// Current change counter.
pub fn seq(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row("SELECT seq FROM sync_guard WHERE id = 1", [], |r| r.get(0))?)
}

/// Latest version seen of a row.
pub fn known(conn: &Connection, entity: &str, id: &str) -> AppResult<Option<String>> {
    use rusqlite::OptionalExtension;
    Ok(conn
        .query_row(
            "SELECT stamp FROM sync_known WHERE entity = ?1 AND id = ?2",
            params![entity, id],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn set_known(conn: &Connection, entity: &str, id: &str, stamp: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO sync_known (entity, id, stamp) VALUES (?1, ?2, ?3) \
         ON CONFLICT (entity, id) DO UPDATE SET stamp = excluded.stamp",
        params![entity, id, stamp],
    )?;
    Ok(())
}

pub fn forget_known(conn: &Connection, entity: &str, id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM sync_known WHERE entity = ?1 AND id = ?2",
        params![entity, id],
    )?;
    Ok(())
}
