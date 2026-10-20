//! `POST /api/sync` algorithm (docs/SYNC.md § 2.4), in one SQLite transaction. Applying the
//! deletion of an attachment also forgets its file in that transaction; the caller
//! deletes the bytes once the transaction is committed ([`SyncOutcome::removed_files`]).

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::Value;
use sync_proto::{
    incoming_wins, known_entity_set, Change, ChangeKey, Entity, Stamp, SyncResponse,
    MAX_PULL_BYTES, MAX_PULL_CHANGES, PROTOCOL_VERSION,
};

use crate::error::ServerError;
use crate::{files, store};

/// A sync request whose changes are still raw JSON: one malformed change must not fail the
/// whole request (it is listed in `rejected`, § 2.4 step 2).
#[derive(Debug, Deserialize)]
pub struct RawSyncRequest {
    pub protocol: u32,
    pub cursor: u64,
    pub changes: Vec<Value>,
    /// See `SyncRequest::known_entities`: absent = a client made before the notebook.
    #[serde(default)]
    pub known_entities: Option<Vec<String>>,
}

/// A stored row.
struct Stored {
    rev: i64,
    updated_at: String,
    device_id: String,
    data: Option<String>,
}

impl Stored {
    fn stamp(&self) -> Stamp<'_> {
        Stamp {
            updated_at: &self.updated_at,
            device_id: &self.device_id,
            tombstone: self.data.is_none(),
        }
    }
}

type Key = (Entity, String);

/// What a sync did: the response, and the attachments whose file the transaction forgot. The
/// caller deletes those files from disk with `FileStore::delete_files` after the commit.
#[derive(Debug)]
pub struct SyncOutcome {
    pub response: SyncResponse,
    /// Ids of the account's attachments deleted by this push that had a file.
    pub removed_files: Vec<String>,
}

/// The attachment id when `change` deletes a row that owns a file, an attachment or a page
/// image (soft delete or tombstone).
fn deleted_attachment(change: &Change) -> Option<&str> {
    match change {
        Change::Attachment(v) => match &v.data {
            None => Some(&v.id),
            Some(data) if data.deleted_at.is_some() => Some(&v.id),
            Some(_) => None,
        },
        Change::NoteAttachment(v) => match &v.data {
            None => Some(&v.id),
            Some(data) if data.deleted_at.is_some() => Some(&v.id),
            Some(_) => None,
        },
        _ => None,
    }
}

/// Size of a pulled page: at most `rows` rows and, once it holds one, `bytes` of row data.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Page {
    pub rows: usize,
    pub bytes: usize,
}

impl Page {
    /// The protocol's page ([`MAX_PULL_CHANGES`] rows, [`MAX_PULL_BYTES`] bytes).
    pub(crate) const PROTOCOL: Page = Page {
        rows: MAX_PULL_CHANGES,
        bytes: MAX_PULL_BYTES,
    };
}

/// Bytes a stored row adds to a page: its data and its text fields (the JSON envelope around
/// them is small and fixed).
fn row_size(id: &str, stored: &Stored) -> usize {
    stored.data.as_ref().map_or(0, String::len)
        + id.len()
        + stored.updated_at.len()
        + stored.device_id.len()
}

/// What a push may add to the account's synced data. A push
/// that does not grow the data always passes: a full account can still delete.
#[derive(Debug, Clone, Copy)]
pub struct RecordsQuota {
    /// Largest total of the account's stored row data, in bytes.
    pub max_bytes: u64,
    /// The server's disk is below its free-space floor: no push may grow the data.
    pub disk_low: bool,
}

impl RecordsQuota {
    /// No limit (tests, and the `sync` of tools).
    pub const UNLIMITED: RecordsQuota = RecordsQuota {
        max_bytes: u64::MAX,
        disk_low: false,
    };
}

fn records_bytes(tx: &Transaction<'_>, account_id: &str) -> Result<u64, ServerError> {
    let bytes: i64 = tx.query_row(
        "SELECT records_bytes FROM accounts WHERE id = ?1",
        [account_id],
        |r| r.get(0),
    )?;
    Ok(u64::try_from(bytes).unwrap_or(0))
}

fn set_records_bytes(
    tx: &Transaction<'_>,
    account_id: &str,
    bytes: u64,
) -> Result<(), ServerError> {
    tx.execute(
        "UPDATE accounts SET records_bytes = ?2 WHERE id = ?1",
        params![account_id, i64::try_from(bytes).unwrap_or(i64::MAX)],
    )?;
    Ok(())
}

fn len_u64(len: usize) -> u64 {
    u64::try_from(len).unwrap_or(u64::MAX)
}

/// Runs the push and the pull for `device_id` of `account_id`: only that account's rows are
/// read and written (revisions stay unique across the server). The caller checked the token
/// and the protocol, and deletes the files listed in [`SyncOutcome::removed_files`].
pub fn sync(
    conn: &mut Connection,
    account_id: &str,
    device_id: &str,
    request: RawSyncRequest,
    quota: RecordsQuota,
) -> Result<SyncOutcome, ServerError> {
    sync_with_page(conn, account_id, device_id, request, Page::PROTOCOL, quota)
}

pub(crate) fn sync_with_page(
    conn: &mut Connection,
    account_id: &str,
    device_id: &str,
    request: RawSyncRequest,
    page_size: Page,
    quota: RecordsQuota,
) -> Result<SyncOutcome, ServerError> {
    // Rows of other entities never reach this client: one made before them could not read
    // the response (docs/SYNC.md § 0.1).
    let known = known_entity_set(request.known_entities.as_deref());
    let tx = conn.transaction()?;
    let used_before = records_bytes(&tx, account_id)?;
    let mut used = used_before;
    let max_rev_before = max_rev(&tx)?;
    let mut next_rev = max_rev_before;

    // Step 2: push, in request order.
    let mut accepted: HashSet<Key> = HashSet::new();
    let mut refused: HashSet<Key> = HashSet::new();
    let mut rejected: Vec<ChangeKey> = Vec::new();
    let mut accepted_count: u32 = 0;
    let mut removed_files: Vec<String> = Vec::new();
    for raw in request.changes {
        let mut change = match parse_change(raw) {
            Ok(change) => change,
            Err(key) => {
                match key {
                    Some(key) => {
                        tracing::warn!(entity = key.entity.as_str(), id = %key.id,
                            "rejected change: malformed");
                        rejected.push(key);
                    }
                    None => tracing::warn!("dropped change without a valid entity and id"),
                }
                continue;
            }
        };
        if let Err(err) = change.validate() {
            tracing::warn!(entity = change.entity().as_str(), id = %truncate(change.id()),
                reason = %err, "rejected change: invalid");
            rejected.push(change.key());
            continue;
        }
        change.set_device_id(device_id);
        let key: Key = (change.entity(), change.id().to_string());
        let stored = read_stored(&tx, account_id, &key)?;
        let wins = match &stored {
            None => true,
            Some(stored) => incoming_wins(change.stamp(), stored.stamp()),
        };
        if wins {
            let old = stored
                .as_ref()
                .and_then(|s| s.data.as_ref())
                .map_or(0, String::len);
            next_rev += 1;
            let new = upsert(&tx, account_id, &change, next_rev)?;
            used = used
                .saturating_sub(len_u64(old))
                .saturating_add(len_u64(new));
            if let Some(attachment_id) = deleted_attachment(&change) {
                if files::forget(&tx, account_id, attachment_id)? {
                    removed_files.push(attachment_id.to_string());
                }
            }
            accepted_count = accepted_count.saturating_add(1);
            refused.remove(&key);
            accepted.insert(key);
        } else {
            refused.insert(key);
        }
    }
    let max_rev = next_rev;
    if used > used_before && (used > quota.max_bytes || quota.disk_low) {
        tracing::warn!(
            account_id,
            disk_low = quota.disk_low,
            used,
            max = quota.max_bytes,
            "push refused: synced data quota or disk floor"
        );
        // Returning drops `tx`: the whole push is rolled back.
        return Err(ServerError::RecordsQuota);
    }
    if used != used_before {
        set_records_bytes(&tx, account_id, used)?;
    }

    // Step 3: a cursor beyond the log (database restored without `reset-epoch`) means a full
    // pull. Compared with the revision before this push, so the client's own push cannot hide
    // the gap.
    let cursor = match i64::try_from(request.cursor) {
        Ok(c) if c <= max_rev_before => c,
        _ => 0,
    };

    // Step 4: page of rows above the cursor, excluding the keys accepted now.
    let mut page: Vec<(i64, Change)> = Vec::new();
    let mut page_bytes: usize = 0;
    let mut has_more = false;
    {
        let mut stmt = tx.prepare(
            "SELECT entity, id, rev, updated_at, device_id, data FROM records
             WHERE account_id = ?1 AND rev > ?2 ORDER BY rev",
        )?;
        let mut rows = stmt.query(params![account_id, cursor])?;
        while let Some(row) = rows.next()? {
            let entity: String = row.get(0)?;
            let id: String = row.get(1)?;
            let Some(entity_kind) = Entity::parse(&entity) else {
                return Err(ServerError::CorruptRecord { entity, id });
            };
            if !known.contains(&entity_kind) || accepted.contains(&(entity_kind, id.clone())) {
                continue;
            }
            let stored = Stored {
                rev: row.get(2)?,
                updated_at: row.get(3)?,
                device_id: row.get(4)?,
                data: row.get(5)?,
            };
            let size = row_size(&id, &stored);
            // A page always takes its first row, however large.
            if page.len() == page_size.rows
                || (!page.is_empty() && page_bytes.saturating_add(size) > page_size.bytes)
            {
                has_more = true;
                break;
            }
            page_bytes = page_bytes.saturating_add(size);
            page.push((stored.rev, to_change(&entity, &id, &stored)?));
        }
    }
    let response_cursor = match (has_more, page.last()) {
        (true, Some((rev, _))) => *rev,
        _ => max_rev,
    };

    // Step 5: the server's version of every refused key the client would not get otherwise.
    // These rows come on top of the byte budget; the push limits bound them.
    for key in refused.iter().filter(|k| known.contains(&k.0)) {
        if let Some(stored) = read_stored(&tx, account_id, key)? {
            if stored.rev <= cursor {
                page.push((stored.rev, to_change(key.0.as_str(), &key.1, &stored)?));
            }
        }
    }
    page.sort_by_key(|(rev, _)| *rev);

    let server_epoch = store::server_epoch(&tx)?;
    tx.commit()?;

    Ok(SyncOutcome {
        response: SyncResponse {
            protocol: PROTOCOL_VERSION,
            server_epoch,
            cursor: u64::try_from(response_cursor).unwrap_or(0),
            changes: page.into_iter().map(|(_, change)| change).collect(),
            has_more,
            rejected,
            accepted: accepted_count,
            server_time: store::now_utc(),
        },
        removed_files,
    })
}

/// `COALESCE(MAX(rev), 0)` over the whole server (revisions are global).
pub fn max_rev(conn: &Connection) -> Result<i64, ServerError> {
    Ok(
        conn.query_row("SELECT COALESCE(MAX(rev), 0) FROM records", [], |r| {
            r.get(0)
        })?,
    )
}

/// Parses one pushed change; on failure returns its key when one can be read.
fn parse_change(raw: Value) -> Result<Change, Option<ChangeKey>> {
    let key = raw_key(&raw);
    serde_json::from_value::<Change>(raw).map_err(|_| key)
}

fn raw_key(raw: &Value) -> Option<ChangeKey> {
    let entity = Entity::parse(raw.get("entity")?.as_str()?)?;
    let id = raw.get("id")?.as_str()?;
    if id.is_empty() || id.len() > sync_proto::MAX_ID_LEN {
        return None;
    }
    Some(ChangeKey {
        entity,
        id: id.to_string(),
    })
}

/// Ids are at most 128 bytes once validated; a rejected one may be longer: keep logs short.
fn truncate(id: &str) -> &str {
    let mut end = id.len().min(sync_proto::MAX_ID_LEN);
    while !id.is_char_boundary(end) {
        end -= 1;
    }
    &id[..end]
}

fn read_stored(
    tx: &Transaction<'_>,
    account_id: &str,
    key: &Key,
) -> Result<Option<Stored>, ServerError> {
    Ok(tx
        .query_row(
            "SELECT rev, updated_at, device_id, data FROM records
             WHERE account_id = ?1 AND entity = ?2 AND id = ?3",
            params![account_id, key.0.as_str(), key.1],
            |r| {
                Ok(Stored {
                    rev: r.get(0)?,
                    updated_at: r.get(1)?,
                    device_id: r.get(2)?,
                    data: r.get(3)?,
                })
            },
        )
        .optional()?)
}

fn data_json(change: &Change) -> Result<Option<String>, serde_json::Error> {
    match change {
        Change::Subject(v) => v.data.as_ref().map(serde_json::to_string).transpose(),
        Change::Section(v) => v.data.as_ref().map(serde_json::to_string).transpose(),
        Change::Task(v) => v.data.as_ref().map(serde_json::to_string).transpose(),
        Change::Setting(v) => v.data.as_ref().map(serde_json::to_string).transpose(),
        Change::BoardColumn(v) => v.data.as_ref().map(serde_json::to_string).transpose(),
        Change::TimeSegment(v) => v.data.as_ref().map(serde_json::to_string).transpose(),
        Change::Relation(v) => v.data.as_ref().map(serde_json::to_string).transpose(),
        Change::Attachment(v) => v.data.as_ref().map(serde_json::to_string).transpose(),
        Change::NoteGroup(v) => v.data.as_ref().map(serde_json::to_string).transpose(),
        Change::NotePage(v) => v.data.as_ref().map(serde_json::to_string).transpose(),
        Change::NoteAttachment(v) => v.data.as_ref().map(serde_json::to_string).transpose(),
    }
}

fn upsert(
    tx: &Transaction<'_>,
    account_id: &str,
    change: &Change,
    rev: i64,
) -> Result<usize, ServerError> {
    let data = data_json(change).map_err(|_| ServerError::CorruptRecord {
        entity: change.entity().as_str().to_string(),
        id: change.id().to_string(),
    })?;
    let written = data.as_ref().map_or(0, String::len);
    tx.execute(
        "INSERT INTO records (account_id, entity, id, rev, updated_at, device_id, data)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (account_id, entity, id) DO UPDATE SET
           rev = excluded.rev, updated_at = excluded.updated_at,
           device_id = excluded.device_id, data = excluded.data",
        params![
            account_id,
            change.entity().as_str(),
            change.id(),
            rev,
            change.updated_at(),
            change.device_id(),
            data
        ],
    )?;
    Ok(written)
}

fn to_change(entity: &str, id: &str, stored: &Stored) -> Result<Change, ServerError> {
    let corrupt = || ServerError::CorruptRecord {
        entity: entity.to_string(),
        id: id.to_string(),
    };
    let data = match &stored.data {
        Some(json) => serde_json::from_str::<Value>(json).map_err(|_| corrupt())?,
        None => Value::Null,
    };
    let value = serde_json::json!({
        "entity": entity,
        "id": id,
        "updated_at": stored.updated_at,
        "device_id": stored.device_id,
        "data": data,
    });
    serde_json::from_value(value).map_err(|_| corrupt())
}

#[cfg(test)]
mod tests;
