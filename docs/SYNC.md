# Sync and mobile app: protocol 3

This document describes how Taido synchronises the desktop app with a sync server, and how the
phone web app (PWA) works against the same server: the wire protocol (`crates/sync-proto`), the
server (`sync-server/`), the desktop core (`src-tauri/src/sync/`), the desktop UI and the phone
app. Sync is optional: the desktop app is fully usable without an account.

**Read § 0 first: it wins over §§ 1–11 where they disagree.** The protocol version on the wire
is `PROTOCOL_VERSION = 3`.

| Part | Where |
| --- | --- |
| Wire types, validation, conflict rule, golden fixtures | `crates/sync-proto/` |
| TypeScript mirror of the protocol (same fixtures) | `src/lib/sync-proto.ts` |
| Sync server (axum + SQLite), accounts, Docker image, serves the PWA | `sync-server/` |
| Desktop core: sync engine, migration 0010, Tauri commands and event | `src-tauri/src/sync/` |
| Desktop UI: Réglages › Compte, sidebar sync button and status | `src/features/sync/`, `src/features/account/` |
| Phone web app (PWA): same React UI, persisted backend, offline outbox, sync client | `src/mobile/`, `mobile/` |
| Simulated sync and account for the mock backend | `src/lib/mock-sync.ts` |

---

## 0. Protocol 3

> This section is the single description of protocol 3 (`PROTOCOL_VERSION = 3`): accounts, the
> entities beyond projects, sections and tasks, and the files of attachments (§ 0.13). §§ 1–11
> below are the base contract: where one of them disagrees with this section, **this section
> wins**. Short contradictions are fixed in place; the long ones carry a pointer here.

### 0.1 Scope and compatibility

- Many accounts on one server (e-mail + password), an optional server that you run
  yourself. Account creation can be closed with `TAIDO_SIGNUPS=closed` (§ 0.2).
- Four new synced entities (§ 0.5), `SubjectData.is_group`, `TaskData.board_column_id`, account
  messages and error codes (§ 0.2).
- **No compatibility layer.** A client of another protocol version gets `unsupported_protocol`.
  The server refuses to start (exit 1, clear message) on a database of the former
  single-account schema that holds a password or records (an empty one is upgraded): start it
  on a new, empty data directory. A device sends all its rows to a new account (§ 0.10 rule 4).
- Clients that do not know an entity ignore its rows.
- **Declared entities (notebook).** A sync request may carry
  `known_entities`, the wire names of the entities the client reads (additive, optional, the
  protocol stays 3). The server's pull (and its answer to a refused push) holds back every row of
  an entity outside `known_entity_set(known_entities)` = the eight historical entities
  (`LEGACY_ENTITIES`: `subject` … `attachment`) plus the listed names it knows. A request without
  the field (a Mac or web app that predates the notebook) gets only the historical entities:
  `note_group`, `note_page`, `note_attachment` never reach it. Filtered rows take no room in a
  page; `has_more` and the cursor are computed over the rows actually sent. Pushes are not
  filtered (a new client's notebook rows are stored). The Mac declares `Entity::ALL`.
- **Tolerant pull (Mac).** The Mac reads `changes` as JSON first and skips (one log line per
  response) the rows of an entity it does not know, so a later additive entity never makes a
  whole response unreadable.
- **Cursor reset when the set grows.** The Mac stores the list it declared
  (`sync_known_entities` in `settings`). When the list of this build has a name the stored one
  lacks — or nothing is stored (a build that predates the declaration) — the cursor goes back
  to 0 once, before the run: rows the server held back from the older build (e.g. notebook pages
  made on another device) are then pulled. The phone does the same.
- **Update order:** the **server first**, then the clients. A server that does not know
  `known_entities` sends every row; one that does protects older clients.
- Sync stays **fully off** until an account is linked. Without an account the app works locally.

### 0.2 Accounts

An account = `id` (UUID), `email` (trimmed, lowercase, at most 254 characters, `local@a.b…` with
no space or control character), `password_hash` (argon2id PHC), `created_at`. A device (`devices`) belongs to one account; every login creates a new device with
its own revocable bearer token (43 characters, base64url of 32 random bytes, stored as hex
SHA-256, shown once). Passwords have at least **10 characters**.

**Address confirmation.** When the server can send mail (`TAIDO_SMTP_HOST` and
`TAIDO_PUBLIC_URL` both set), signup e-mails a link `TAIDO_PUBLIC_URL/confirmer?t=<token>` (valid
24 hours; the token is stored as a SHA-256 hash). The link opens a page with one button
(`GET /confirmer?t=…` only shows the page, because mail scanners open links on their own;
`POST /confirmer` with the form field `t` confirms and sends a welcome mail). The account works
before it is confirmed; `AccountResponse.email_verified` tells the apps, which offer « Renvoyer
le mail » (`POST /api/email/resend`, Bearer, 204; 503 `mail_unavailable` when the server cannot
send; 3 per account per hour). Without a mailer, accounts are confirmed at signup. A password
reset by e-mail confirms the address too. Unknown or expired links count on a per-client limiter
(20 per hour, 1000 for the server).

**Closed signups.** `TAIDO_SIGNUPS=closed` makes `POST /api/signup` answer 403 `signups_closed`
before it reads anything; login, password reset, sync and existing accounts are unaffected
(to create accounts, start the server with `open`, then restart it with `closed`).

| Route | Auth | Request (body ≤ 4 KiB) | Response | Errors |
| --- | --- | --- | --- | --- |
| `POST /api/signup` | — | `SignupRequest {protocol, email, password, device_name}` | `LoginResponse` (200) | 400 `bad_email` / `weak_password` / `bad_request` / `unsupported_protocol`, 403 `signups_closed`, 409 `email_taken`, 413, 429 |
| `POST /api/login` | — | `LoginRequest {protocol, email, password, device_name}` | `LoginResponse {protocol, token, device_id, server_epoch}` | 400, 401, 413, 429 |
| `GET /api/account` | Bearer | — | `AccountResponse {protocol, email, created_at, email_verified}` | 401 |
| `POST /api/logout` | Bearer | — | `204` (this device's token revoked) | 401 |
| `POST /api/password/forgot` | — | `ForgotRequest {protocol, email}` | `204` | 400 `bad_email`, 400 `unsupported_protocol`, 413, 429, 503 `mail_unavailable` |
| `POST /api/password/reset` | — | `ResetRequest {protocol, email, code, password}` | `204` | 400 `weak_password` / `invalid_code` / `unsupported_protocol`, 413, 429 |

Account `ErrorCode`s: `email_taken` (409), `weak_password`, `bad_email`, `invalid_code` (400),
`signups_closed` (403), `mail_unavailable` (503). `message` stays English, for logs.

- **Login.** A wrong password and an unknown or malformed address give the **same** 401 (the
  unknown address is checked against a dummy argon2 hash of the same cost, warmed up at start, so
  the answer time does not tell). Signup, on the contrary, does say `email_taken` (accepted: the
  code is part of the protocol).
- **Logs** never contain a password, code, token, address or content; an account appears by its
  id only (a test runs the whole flow at `RUST_LOG=trace` and greps the output).

### 0.3 Forgotten password: e-mailed code

Code, not link: nothing to open in a browser, nothing to host.

- **Forgot.** In this order: protocol check; no mailer configured → 503 `mail_unavailable`
  (whatever the address); malformed address → 400 `bad_email` (whatever the account); take a slot
  in the limiters (§ 0.11, every well-formed request counts, known address or not); then **answer
  204**. Only after the answer, in a spawned task: look up the account and, if it exists, make
  the code, store it and send the e-mail. So the answer — status, body bytes, headers — and its
  time are the same for a known and an unknown address, and an SMTP failure never changes it
  (logged as `password reset e-mail not sent`, error kind only). A mailed code is always stored
  first. One `password reset requested` log line per request, identical in both cases.
- **Code.** 6 digits from the CSPRNG (rejection sampling: uniform), valid **30 minutes**, at
  most **5 tries**, **one active code per account**: a new code replaces the old one and resets
  the tries (`password_resets` has one row per account). Stored as hex SHA-256 of
  `"<account id>:<code>"` (not argon2: the space is 10^6, a stolen database could be searched
  anyway, the code lives 30 minutes, and online guessing is bounded by the limits), compared in
  constant time. The e-mail (French, subject « Ton code Taido ») carries the code in clear.
- **Reset.** In this order: protocol; password under 10 characters → 400 `weak_password`
  **without** using a try; a per-client slot (§ 0.11); the argon2 gate; then the code. An unknown or
  malformed address, a wrong, expired, used or burnt code all give the same 400 `invalid_code`;
  each failure counts on the client limiter. The 6th try fails **even with the right code**
  (ask for a new one). An accepted code is deleted on the spot (if hashing or saving the new
  password then fails, the user asks for a new code). Success: the new password is stored and
  **every device of the account is logged out** (all tokens revoked, any pending code deleted).
  The reset does not log in: the app chains `login` with the new password.
- **Mail transport.** SMTP only (the server knows nothing of the service behind it): `lettre` 0.11.23, `TAIDO_SMTP_HOST` / `_PORT` (465 = implicit TLS
  through `relay()`, any other port = STARTTLS) / `_USER` + `_PASSWORD` (together or not at all)
  / `TAIDO_MAIL_FROM`; no host = no e-mail (503). The SMTP password lives only in the server's
  environment, never in the repository nor the logs. The last line of each mail names the
  server by the `host[:port]` of `TAIDO_PUBLIC_URL` (scheme, path and query dropped); without
  `TAIDO_PUBLIC_URL` it only says « Taido ».

### 0.4 Records per account

- The server key of a row is **`(account_id, entity, id)`**. Ids that are equal across accounts
  (`inbox_position`, `grp-…`, the default columns `col-…`) never meet: an account never reads,
  overwrites or deletes another account's row, and a tombstone is final only inside its account.
- `rev` stays **unique across the whole server** (one global log); a cursor is a revision of that
  log read through the rows of one account. So a page may skip revisions that belong to other
  accounts; `has_more` and `page` look at this account's rows only; the response cursor is the
  `rev` of the last row of the page when `has_more`, else the global `max_rev`. The refused-key
  rule of § 2.4 step 5 uses the account's own stored row.
- The conflict rule (§ 2.3), the epoch (§ 2.6) and the run (§ 2.7) are unchanged and apply per
  account. `server_epoch` is per database, not per account.

### 0.5 The four new entities

Wire names `board_column`, `time_segment`, `relation`, `attachment` (Rust structs in
`crates/sync-proto/src/lib.rs`, TS mirror `src/lib/sync-proto.ts`, golden file
`crates/sync-proto/fixtures/v3_entities.json`). Every entity keeps the common validation (id
1–128 bytes, canonical `updated_at`, `device_id` ≤ 128 bytes, free stamps 1–64 bytes, finite
`position`).

| Entity | Mac table | `data` | Validation | Deleted by |
| --- | --- | --- | --- | --- |
| `board_column` | `board_columns` | `subject_id` (`null` = « Sans projet »), `name`, `position`, `is_done`, `created_at` | `name` not blank | tombstone |
| `time_segment` | `time_segments` | `task_id`, `source` (`auto` \| `manual`), `started_at`, `ended_at` (`null` = running), `stop_reason`, `note`, `created_at`, `deleted_at` | `started_at` and `ended_at` canonical UTC, `ended_at >= started_at`; `stop_reason` ∈ `waiting`, `turn_ended`, `session_closed`, `task_done`, `app_closed` | `deleted_at`, tombstone on purge |
| `relation` | `task_relations` | `from_task_id`, `to_task_id`, `kind` (`blocks` \| `relates_to`), `created_at`, `deleted_at` | not to itself | `deleted_at`, tombstone on purge |
| `attachment` | `attachments` | `task_id`, `file_name`, `mime_type`, `size`, `sha256` (optional), `created_at`, `deleted_at` | `file_name` 1–255 bytes, no `/` nor `\`, not blank; `sha256`, when present, exactly 64 characters `[0-9a-f]` | `deleted_at`, tombstone on purge |

**Project notebook:** three more entities, additive (a client that does not know them ignores
their rows — see « Older clients » below).

| Entity | Mac table | `data` | Validation | Deleted by |
| --- | --- | --- | --- | --- |
| `note_group` | `note_groups` | `subject_id`, `name`, `position`, `created_at` | `name` not blank | tombstone (its pages fall back to no group) |
| `note_page` | `note_pages` | `subject_id`, `group_id` (`null` = no group), `kind` (`page` \| `summary`), `title`, `body` (Markdown), `source_task_id` (the summarised task), `pinned_at`, `position`, `created_at`, `deleted_at` | `kind` known; `title` not blank, at most `MAX_NOTE_TITLE_BYTES` = 500 bytes; `body` at most `MAX_NOTE_BODY_BYTES` = 262 144 bytes (256 KiB) | `deleted_at`, tombstone on purge |
| `note_attachment` | `attachments` (rows with `note_page_id`) | same as `attachment` with `note_page_id` instead of `task_id` | same as `attachment` | `deleted_at`, tombstone on purge |

An `attachments` row is an `attachment` on the wire when `task_id` is set and a
`note_attachment` when `note_page_id` is set (migration `0021_notes.sql`: exactly one of them).
Local-only columns of a page image: the same as an attachment's (`stored_path`, `remote`,
`shared`). Pages and groups have none. Migration `0021_notes.sql` adds the notebook triggers.

**Older clients.** A Mac that predates the notebook parses every pulled row with the strict
`sync_proto::Change` enum: a `note_*` row would make the whole response unreadable there. The
server therefore sends notebook rows only to clients that declare them (§ 0.1), so an older Mac
or web app keeps syncing everything else; once updated, its cursor goes back to 0 once and the
notebook arrives.

Added fields of existing entities (absent = default): `SubjectData.is_group` (`false`),
`TaskData.board_column_id` (`null`), `AttachmentData.sha256` (absent = unknown; additive, an
absent hash is not written to the JSON).

**Local-only columns**, never sent, never overwritten by an apply: `time_segments.agent_session_id`
and `attachments.stored_path` (plus the earlier ones: `subjects.root_path`,
`sections.subpath`, `tasks.workdir_override`), plus `attachments.remote` and
`attachments.shared` (§ 0.13). The **files** of attachments do not travel in sync rows: they go
through their own routes (§ 0.13); the state of agent sessions, terminals and the journal is
never synced. Migration `0016_sync_v2.sql` adds the triggers on the four tables and on
`subjects.is_group` / `tasks.board_column_id`; they watch the synced columns only (a change of
`agent_session_id`, `stored_path` or `updated_at` alone records nothing). All migrations
together define 30 triggers (`sync::TRIGGER_COUNT`).

### 0.6 Apply on the Mac (extends § 2.5)

**Order** (stable within a group): settings; projects; sub-projects; sections and **notebook
groups**; **board columns**; tasks; child tasks; **notebook pages**; **time segments, relations,
attachments, page images**; then the tombstones in this order: attachments and page images,
relations, segments, notebook pages, child tasks, tasks, sections, notebook groups, **columns**,
sub-projects, projects. A Mac pushes its outbox in the same spirit (per `seq`: projects,
sections, columns, tasks, notebook groups, notebook pages, then the rest).

**Missing references** (retried after the rest of the group, then):

| Row | Reference missing | Action |
| --- | --- | --- |
| board_column | `subject_id` | park |
| time_segment | `task_id` | park |
| relation | `from_task_id` or `to_task_id` | park |
| attachment | `task_id` | park |
| task | `board_column_id` | apply with `board_column_id = null` **and** keep the row parked until the column is here (like `section_id`) |
| task | column of another project | apply with `board_column_id = null` (N9) |
| note_group | `subject_id` | park |
| note_page | `subject_id` | park |
| note_page | `group_id` or `source_task_id` | apply with it `null` **and** keep the row parked until it is here (like a task's `section_id`) |
| note_page | group of another project | apply as is, then N11 |
| note_attachment | `note_page_id` | park |

Soft-deleted rows count as present. Parked rows follow § 2.5 (dropped when a newer version or a
tombstone arrives, or when their key has an outbox entry). The « already here » test of a task
kept for its section or column compares the whole stored row, so it is written again once one of
its references arrives.

**Tombstone cascades.** The descendants still here that the response does not tombstone itself
are deleted **as local changes** (`applying = 0`, so their tombstones are queued), deepest first,
then the row as an applied change (`applying = 1`):

- a task tombstone first deletes the task's (and its child tasks') time segments, relations (on
  either side) and attachments;
- a project tombstone also deletes the project's columns (and the tasks' rows as before);
- a **column** tombstone cascades to nothing: its tasks fall back to `board_column_id = NULL`
  through `ON DELETE SET NULL` while `applying = 1`, **silently, as for sections** — the device
  that deleted the column sends its tasks' new versions;
- a **notebook group** tombstone likewise: its pages fall back to `group_id = NULL` silently
  (the device that deleted the group sends them, moved after the pages outside any group);
- a **notebook page** tombstone first deletes the page's images; a project tombstone also deletes
  the project's notebook (images, pages, groups);
- the same descendants are collected before the apply so that their terminals are closed
  (`SyncHooks::close_tasks`).

**Normalisation** (§ 2.5 rules N1–N8, plus):

| # | Situation | Correction |
| --- | --- | --- |
| N9 | a task is in the column of another project | `board_column_id = null` |
| N10 | two running segments **of this Mac** (with a session) on one task | the older stops at the newer's start, `stop_reason = app_closed` |
| N11 | a notebook page is in a group of another project | `group_id = null` |

(This rule is N11; N7 is taken by § 2.5.) A group that is
not here at all cannot be referenced locally (foreign key): the apply writes the page without it
and keeps it waiting (above), so a page is never lost nor attached to a dead group.

N10 is a safety net: with the narrowed index of § 0.8 the second running segment cannot exist
locally in practice.

**Duplicate relations.** The local index `idx_relations_pair` forbids two live relations with the
same two tasks and kind, and adding a relation refuses the reversed pair too (« Liée à » is
symmetric; A blocks B with B blocks A would block both forever); two devices can create the same
one, or its reverse. A pulled relation that duplicates a live local one, in either direction,
keeps the **lowest id**, the other is soft-deleted **as a local change** (when the
pulled one must go, it is written already deleted, stamped after its pulled version). Both devices
end with one relation.

**Attachments.** A new pulled attachment gets `stored_path` = the task's attachment folder on this
Mac + `file_name`, else `<app folder>/Pièces jointes/<task id>/<file_name>` (the app folder is
`$HOME/Taido` when none is recorded): always absolute, **the row does not create the file**
(the background job downloads it, § 0.13; its state starts at `missing`). A known attachment
keeps its own path. The name is a free one, like a local copy's (`name (2).ext`…): never a file
on disk nor another live attachment's path (ASCII case ignored); `.` or `..` becomes `fichier`.
A local copy skips the paths of pulled attachments the same way, and removing an attachment
keeps a file another live attachment still points at.

### 0.7 Default Kanban columns

The four default columns of a project (À faire · En cours · À valider · Terminé) have fixed ids
**`col-<project id>-<0..3>`** (`col-inbox-<0..3>` for « Sans projet »), inserted with
`ON CONFLICT(id) DO NOTHING`; columns added later keep random ids. A default column that
`board_columns::ensure` actually inserts is queued with its known stamp, else **`EPOCH_STAMP`**
(like a re-enqueue, § 2.6). Result: two devices that create the same board before syncing make
one set of four; defaults created late never undo a rename made elsewhere (any real edit has a
later stamp); a stored tombstone stays final (a default column deleted elsewhere stays deleted).
Accepted residual: a Mac whose columns have random ids (made by a build that predates the fixed
ids) and another device creating the defaults before pulling them can end with 8 columns (manual
cleanup).

### 0.8 Running segments belong to the Mac that runs them

A running time segment (`ended_at = null`) is **this Mac's** only when it has a session here
(`agent_session_id IS NOT NULL`); a pulled row never has one.

- Every chrono path (reconcile, reconcile all, close on quit, recovery after a crash, close when
  a task is done or deleted) and N10 touch **only** those segments. Another Mac's running segment
  is never closed here, whatever happens locally.
- `idx_segments_open` (one running segment per task) is limited to them
  (`… AND agent_session_id IS NOT NULL`): a pulled running segment runs beside a local one and
  never violates the index, so applying it can never fail the whole transaction.
- The views count every running segment up to now (`running_since` = the earliest start); while
  two Macs run the same task only the earliest is counted live, the final sum is right once both
  stopped.
- **« Arrêter »**: every device (Mac, site, phone) can stop **any** running segment by hand
  (`stop_time_segment` / `stopTimeSegment`): `ended_at` = now (never before `started_at`),
  `stop_reason = null`, synced like any edit. It is then an ordinary stopped segment, removable
  with « Retirer ce temps ». This is how the running segment of a lost or restored Mac, or one
  whose session row was deleted, is ended. The Mac that ran it accepts the pulled stop (its local
  session id stays, the row is no longer running so no chrono path touches it) and its next
  reconcile in which a session counts opens a **new** segment. Safety net: a pulled version that
  runs again a segment this Mac had stopped drops its local session id, so it can never violate
  `idx_segments_open`.

### 0.9 The phone (PWA)

Protocol 3 and login by e-mail (details in § 6.3). It keeps `is_group` and `board_column_id` and
sends them back unchanged (a renamed task stays in « À valider », a renamed group stays a group).
It **applies the `attachment` rows** (shown on the task, parked while the task is missing) and
carries their files (§ 0.13). It also applies, keeps and pushes the rows of `board_column`,
`time_segment` and `relation`, with the order, parking, tombstone ranks and cascades of § 0.6
(`src/mobile/apply.ts`):

- **Default columns** (§ 0.7) have the Mac's fixed ids and are queued at `EPOCH_STAMP`; when the
  phone is linked they are made only **after its first complete pull** (`sync.pulledOnce`, set
  when a run ends with `has_more = false`, cleared at login). Until then the board shows no
  column and adding one is refused. Unlinked, they are made at once.
- **Running segments** (§ 0.8): a pulled segment never has an `agentSessionId`, so the phone never
  stops nor edits it on its own (it is shown running and counted up to now); only a click on
  « Arrêter » stops it (queued like any edit). The phone adds and removes manual time. Deleting a task removes its segments and relations (both sides) everywhere.
- **Deletion guard** (§ 6.2): segments are their own class; columns and relations count with
  the rows of their project / tasks, and only while those are live (a purge never trips it).
- **The notebook:** the phone holds `note_group`, `note_page` and
  `note_attachment` (a page image: the attachment record with `notePageId` as owner, same files
  layer, same routes). Every request carries `known_entities` (all of `ALL_ENTITIES`); the list
  declared is stored (`PersistedSync.knownEntities`) and, when this build knows a name the stored
  list lacks (or none is stored), the cursor goes back to 0 once, unsent edits staying in the
  outbox. Apply: § 0.6 (groups with the sections, pages after the child tasks, images with the
  attachments; a page with a missing group or task is applied without it and parked; N11 takes a
  page out of a group of another project). Deletion guard: pages and groups are a class of their
  own, images count with the attachments. Purge: pages deleted more than 24 h ago, a purged
  project's notebook; a summary whose task is purged is unlinked. The sync part of the saved set
  is stored under the key `sync.4` (§ 6.2): a build that does not know a row type reads another
  key, refuses the set and so cannot send a deletion of the rows it does not know.
- **Accounts.** The phone cannot sign up nor reset a password: `signup`, `forgot` and `reset`
  reject `invalid` (`NOT_ON_THE_PHONE`), the UI says « Crée ton compte ou change ton mot de passe
  depuis le Mac ». It follows the Mac for account switching (§ 0.10) and reads `GET /api/account`
  after login and after every successful run.

### 0.10 Account switching rules (every device)

1. **While linked, a device never joins another account.** `signup` is refused; `login` is
   refused unless it is for the cached account's address (trimmed, lowercased: a « Se
   reconnecter » after a refused token). The refusal is `invalid` with the detail `already linked
   to an account: log out first` (French « Déconnecte-toi d'abord pour changer de compte. »),
   before any request. A device linked with no cached account (every account read failed) is
   refused too; « Se déconnecter » then a new login gets out of it.
2. **Logging out syncs first.** The UI runs `sync_now`; if it fails, ends `error` / `offline`, or
   leaves `pending > 0`, a warning says how many changes were not sent and offers « Se
   déconnecter quand même » / « Annuler ». `sync_unlink` then asks the server to revoke the token
   (best effort, 5 s), deletes token, device id, epoch, cursor, last sync and the cached account,
   and **keeps** the server URL (the account forms start from it, else `DEFAULT_SERVER_URL`),
   the outbox, the known stamps, the parked rows (the triggers keep recording). **The data
   always stays on the device.**
3. **Creating an account uploads the device's data silently. Logging in to an existing account on
   a device that holds data asks first** « Fusionner avec ce compte ? » (« Fusionner » is the
   default, « Annuler »). « Holds data » = at least one project or task, « Sans projet »
   included; unknown counts as holding. After a password reset, the question comes after the
   reset succeeded, just before the chained login. There is no « replace this device's data with
   the account's » option: wiping the local data would also cascade the agent sessions and the
   journal.
4. **Every join forgets what a previous link learnt from its server and re-sends everything.** In
   one transaction: cursor, epoch, `sync_known` and `sync_parked` (phone: `parked` emptied, every
   snapshot stamp back to `EPOCH_STAMP`) are forgotten, **the outbox is kept** (real edits keep
   their own stamps), then every live or soft-deleted row without an outbox entry is enqueued at
   `EPOCH_STAMP` (§ 2.6): a stale copy loses to any real server version, which comes back with the
   first pull. A Mac whose cursor, epoch and known versions come from another server therefore
   logs in to a new account and sends exactly its rows, none lost, none doubled; the rows it had
   parked for the other server never reach the account. This also applies to « Se reconnecter ».
5. **A reset logs every device out**, this one included: the next sync is `unauthorized`; the app
   chains `login` after `reset`.
6. **Welcome.** On the Mac only, the welcome screen (« Créer un compte » / « J'ai déjà un compte »
   / « Continuer sans compte ») shows once while the Mac is unlinked and the core setting
   `Settings.account_welcome_done` is false — also on a Mac that already holds data (an update).
   Without an account the app works locally and nothing leaves the Mac.

### 0.11 Rate limits (as implemented)

In memory (a restart resets them). The client is `X-Real-IP` (trimmed, at most 64 characters; set
by the reverse proxy, never taken from the caller; absent = one shared key). Every
well-formed attempt counts unless stated; a request needs a free slot in **each** of its limiters
or gets 429, and slots already taken are released when a later one is refused. The keyed slots
are taken while the map of limiters is locked (lock order: map, then limiter), so a parallel
clean-up of idle keys can never make two limiters for one key.

| Route | Key | Maximum | Window |
| --- | --- | --- | --- |
| login (failures, plus checks in flight) | e-mail + client | 10 | 15 min |
| | client | 50 | 15 min |
| | global | 1000 | 15 min |
| signup | client | 5 | 1 h |
| | global | 20 | 1 h |
| forgot | e-mail address (any case) | 3 | 1 h |
| | client | 10 | 1 h |
| | global | 100 | 1 h |
| reset (wrong codes only) | client (all accounts) | 20 | 1 h |
| | global | 1000 | 1 h |
| one code | the code | 5 tries | until used, replaced or expired (30 min) |

- Password checks run **one at a time** (a 1-permit gate around `spawn_blocking`); no permit within
  1 s = 429 `rate_limited`. The reset takes the permit *before* trying the code, so a busy 429
  never burns a good code.
- The per-client keys exist so that one anonymous client cannot lock an account out or exhaust the
  global budget alone (exhausting 1000 login failures takes at least 20 addresses); the global
  caps bound the argon2 work (about 30–60 ms a check).
- The reverse proxy should add its own request-rate limits (for example in nginx: `/api/login`
  10 r/min burst 5, `/api/signup` 3 r/min burst 3, `/api/password/` 3 r/min burst 3, all
  answered 429).
- Accepted residuals: the per-address forgot limit (3 per hour) and the login pair limit let a
  third party block *that address's* resets / logins for an hour / 15 minutes (the global signup
  cap likewise limits signups); reset timing differs slightly between a known account with an
  active code and an unknown one.

### 0.12 Not synced

Agent session state, terminals, hook events, the journal, local settings; and the local-only
columns of § 0.5. The content of attachments travels by § 0.13.

### 0.13 Files

> Files are **always** sent once an account is linked, **100 MB per file** and **2 GB per
> account** by default, both set on the server (`TAIDO_MAX_FILE_BYTES`,
> `TAIDO_ACCOUNT_QUOTA_BYTES`). A client that does not know `sha256` still reads the row.
> Without an account nothing leaves the device. Files are stored on the server's disk only.

**Hash in the metadata.** `AttachmentData.sha256` is the SHA-256 of the file content, 64
lowercase hexadecimal characters (§ 0.5), **optional**: an unknown hash is omitted from the JSON
(the TypeScript mirror reads absent, `null` and `undefined` alike, and a device writes none when
it knows none, because the phone compares serialized rows). It tells which file the server should
hold, checks every download and avoids sending the same content twice. Rows are last-writer-wins
as a whole, so a device that pulls a hash **stores it and sends it back**; a version without a
hash never erases the one it knows (`COALESCE`, Mac and phone). A device that adds a file computes the hash before
the row leaves; rows without a hash (made by an older build) are hashed once by the Mac's
background job and pushed as a normal change.

**Routes** (all need `Authorization: Bearer <token>`; no token = 401 `unauthorized` before any
body is read). `{id}` is the attachment id, percent-encoded as one path segment.

| Route | Request | Response | Errors |
| --- | --- | --- | --- |
| `GET /api/files/{id}/status` | — | `FileStatus {protocol, received, size, complete}` (200) | 401, 404 `not_found` |
| `PUT /api/files/{id}?offset={n}&size={total}&sha256={hex}` | body = the chunk's bytes, at most `MAX_CHUNK_BYTES` (8 MiB) | `FileStatus` (200) | 400 `bad_request` / `hash_mismatch`, 401, 404 `not_found`, 409 `chunk_offset`, 413 `file_too_large` / `payload_too_large`, 507 `quota_exceeded` (account full, or the server's disk nearly full) |
| `GET /api/files/{id}` (and `HEAD`) | optional `Range` | the file (200, 206) | 401, 404 `not_found`, 416 |

**The live-row rule.** A file is received, reported and served **only for a live `attachment`
or `note_attachment` row of the token's account** (a page image's file travels exactly like an
attachment's: same routes, keyed by its id; deleting the row frees the file the same way): the row is present and not soft-deleted. Any other id — unknown,
another account's attachment, soft-deleted, tombstoned, another entity, longer than 128 bytes —
gets the same 404 `not_found` on the three routes. So the order of events is: the row is pushed
first, then its file; and an account never reads another account's file even when both use the
same attachment id (storage is keyed by account, below).

**Chunked upload.** A file goes in chunks of at most 8 MiB, each starting where the previous one
ended: `offset` is the number of bytes the server already holds. `size` and `sha256` describe the
**whole** file and travel with every chunk (each exactly once, `offset` and `size` decimal
digits, `sha256` 64 lowercase hex; a missing, repeated or malformed one is 400 `bad_request`,
unknown parameters are ignored). The server checks, in this order:

1. body over 8 MiB: 413 `payload_too_large` (reading stops);
2. not a live attachment of the account: 404;
3. the attachment row has a `sha256` and the request's is another one: 400 `bad_request`
   ("the sha256 is not the attachment's"; nothing changed). The device pushes its row first,
   then sends the file; it tries again at its next sync, once it has pulled the row. (Not 409:
   devices re-read the status on 409; not `hash_mismatch`: on it the phone hashes its whole
   kept copy again.) A row without a hash (an older client) accepts any hash;
4. `size` over the file limit: 413 `file_too_large`, nothing recorded;
5. no `files` row, or a row with another `size` or `sha256` = a **new upload**. When the
   existing row is **complete**, the request must be a valid first chunk (`offset` 0, body not
   past `size`), else 409 / 400 and the complete file stays. The quota is checked (the other
   files of the account, complete or not, plus `size` over the quota: 507 `quota_exceeded`,
   nothing changed), then the disk's free-space floor (below), then the row is replaced and any
   previous partial or complete file of this attachment is deleted (`received = 0`);
6. `offset` different from the bytes received: 409 `chunk_offset` (the error body is the usual
   `ErrorBody`; the client reads the status again);
7. `offset` + body past `size`: 400 `bad_request`;
8. the chunk is appended and flushed to disk, then 200 with the new `received`; a write that
   finds the disk full (`ENOSPC`, disk quota) deletes the partial file and its row and answers
   507 `quota_exceeded`;
9. at the last byte (also `size` 0 with one empty chunk) the SHA-256 of the whole file is compared
   with the `sha256` **of the request**: different, the partial file and its row are deleted and
   the answer is 400 `hash_mismatch` (nothing is kept, the quota is freed); equal, the file is
   renamed into place, the row becomes complete and the answer is `{received: size, size,
   complete: true}`. On a complete file only `offset = size` with an empty body answers 200
   (idempotent); anything else is 409 or 400.

The bytes received are the **length of the partial file on disk** (flushed before each answer),
not a counter: after a crash the status is the truth. A `files` row is trusted only while it
matches: a **complete row whose file is gone from the disk**, or a row whose `sha256` is not the
attachment row's (when that one has a hash), is dropped (row, partial and file) the next time
the status, an upload or a download reads it: the status then says `received: 0` and the
attachment's size, a download answers 404, and a device that has the file sends it again. So
the server never says « complete » for a file it cannot serve. `received == size` with `complete: false`
means a crash between the last append and the rename: send an empty chunk at `offset = size` to
finish. A client resumes after a cut by reading the status: same `size` = continue at `received`;
another `size` = start again at 0. A client that opens a new upload sends an **empty first
chunk** (`offset = 0`, no body): the limit and quota answers (413, 507) come back before a single
byte travels. After a 409 it reads the status and continues (at most 3 times per file per run).

**Limits.** `TAIDO_MAX_FILE_BYTES` (default `DEFAULT_MAX_FILE_BYTES` = 104 857 600) and
`TAIDO_ACCOUNT_QUOTA_BYTES` (default `DEFAULT_ACCOUNT_QUOTA_BYTES` = 2 147 483 648), and the
server's **free-space floor** `TAIDO_MIN_FREE_BYTES` (default 2 147 483 648, server-only, not in
the protocol): decimal digits only (at most `i64::MAX`); a malformed value stops `serve` with a
message naming the variable; the three are logged at start. A **new** upload that would leave
less than the floor free on the disk of `files/` (`statvfs`: free space for an unprivileged
process, minus `size`) is refused with 507 `quota_exceeded` (no new code: devices show
« Espace du compte plein » and try again at each sync); an upload in progress goes on. With a
full disk while writing, see step 8: the database never runs out of space because of files.
507 answers and refused files are logged as warnings, not errors. The test server starts
without a floor (`TestServer::set_free_space` sets one and a pretend free space). The quota is the sum of `size` over the account's `files`
rows (complete and in progress); deleting a file frees it. The apps do not judge the size
themselves: a file the server refuses (413, 507) shows the tile states described below and is
tried again at each sync, so a server with a higher limit takes it.

**File error codes:** `file_too_large` (413), `quota_exceeded` (507), `not_found`
(404), `hash_mismatch` (400), `chunk_offset` (409). `payload_too_large` (413: chunk over 8 MiB),
`bad_request` and `unauthorized` keep their meaning. `message` stays English, for logs.

**Download.** Always a download, never a page: `Content-Type: application/octet-stream`,
`Content-Disposition: attachment; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded>`
(the fallback replaces `"`, `\`, `%`, control and non-ASCII characters by `_`),
`X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, `Cache-Control: private,
no-store`, `Accept-Ranges: bytes`. One `Range` (`a-b`, `a-`, `-n`) answers 206 with `Content-Range`;
several ranges answer the whole file; an unsatisfiable or malformed one answers 416 with
`Content-Range: bytes */total`. After any resumed download the client **must check the SHA-256**.
The web app's own `Content-Security-Policy` (sent by the server that serves it, from the same
Docker image) gains `blob:` in `img-src` only (§ 4.4; unused, since every file is saved,
harmless).

**Storage and deletion (server).** A file lives at `<data_dir>/files/<account id>/<hex SHA-256 of
account id, a zero byte and attachment id>` (partial: the same name plus `.part`): a name or id
sent by a device never becomes a path component, and the account id must be `[A-Za-z0-9-]{1,64}`.
The table `files(account_id, attachment_id, size, sha256, complete, updated_at)` (migration
`0003_files.sql`, cascades with the account) holds what was announced. A file is deleted when
an **accepted** attachment change is a soft delete (`deleted_at` set) or a tombstone: the `files`
row goes in the **same transaction** as the sync, the bytes right after the commit (a failure is
logged as `attached file not deleted` with ids only; the sync still answers 200). The deletion
takes the file's lock and checks again that the `files` row is still gone: when a new upload
started meanwhile (the attachment was restored), its bytes are not the deleted ones and stay. A losing change
removes nothing; another account's file with the same id and another attachment with the same
name are untouched. A restored attachment (`deleted_at` back to `null`) has **no file** any more:
the status says `received 0` and a device that still holds the file sends it again. A file of a
task in the trash stays on the server until the 24 h purge sends the tombstones. Logs never hold
a file name, a content or a path. Back up `files/` with the database.

**Content is fixed once it is shared** (« copie figée »). The hash names a
content: the file of an attachment never changes once another device may have it. A live
version pulled with a `sha256` **different** from the device's non-null one means "another
file": the device marks it `missing`, downloads the real file (next to the old copy if the place
is taken) and **never overwrites** its own. A device hashes rows with no hash, and never
re-hashes a file that may be elsewhere: an **in-place edit of a shared copy stays local**, is not
sent and is not hashed again; to share a new version the user attaches it again (a new
attachment, a new id). This is what keeps two devices from sending each other's versions for
ever. A copy edited **before its file ever left** (nobody else can have it) is the only content
of its attachment: the Mac hashes it again and sends it (below).

**Mac.** Local-only columns (`0017_attachment_files.sql`; `sha256` is also synced, `remote` is
not and never fires the sync triggers): `attachments.remote` ∈ `local` (not sent yet), `sent`,
`missing` (to download), `file_too_large`, `quota_exceeded`. A pulled attachment starts `missing`.
`attachments.shared` (`0018_attachment_shared.sql`, local-only, not followed by the triggers): 1
when the file of the row's hash may be on another device — a row inserted by a pull, a pulled
hash that is not the local one, or any `sent` recorded by the job (uploaded, found complete on
the server, downloaded); 0 for a file added here and never sent.
After every successful sync run — **outside the sync lock** — a background job runs, one file at
a time, only while linked, over **every** `attachments` row (a task's attachment or a notebook
page's image: the Mac keeps every file; « no outbox entry » below means neither an `attachment`
nor a `note_attachment` entry): (1) **hash** the live rows that have none and have a file (real size
too; the change is pushed by the next sync, about 10 s later); (2) **upload** the live rows
`local`, `file_too_large` or `quota_exceeded` that have a hash and **no outbox entry** (the row
must have reached the server): status, then the empty first chunk (it never opens the file), then
the chunks; the copy is hashed once, **after** the empty chunk was accepted and before the first
byte, or when the status says the server already has the file complete (a copy edited here is
not that file). A copy that no longer matches its row: when it is **not shared** and the server
holds no complete file, its new hash and size become the row's (pushed by the next sync, state
`local`), then it is sent; otherwise it stays as it is and the row becomes `missing` (the
original comes back next to it); (3) **download** the live `missing` rows. A refused file
(413, 507) shows its state and is tried again at every run (one empty chunk, no data) without
blocking the sync of tasks. A network error leaves the file for the next run. A link, an epoch
change or a live version pulled for a row that was `sent` or deleted sets it back to `local`, so
the job checks the server again. Every state the job records, and the end of a download,
require the row's `sha256` to be still the one the job worked with (a hash pulled meanwhile
names another file, whose state is left alone).

- Download: into a hidden **`.<attachment id>.part`** next to the destination (an id that is not
  `[A-Za-z0-9-]{1,64}` is replaced by its SHA-256); resumed with `Range` **only when the row has
  a hash** (so the result is always checked); body capped at the row's size; SHA-256 checked (size
  only when there is no hash and no resume); then marked as downloaded (`com.apple.quarantine`
  = `0081;<hex Unix time>;Taido;`, the value browsers write, so that Gatekeeper checks an app or a
  script opened from the folder; best effort, a failure is logged without a path) and put in
  place **without replacing anything** (`hard_link`, then removal of the partial; `rename` after
  a last check on a volume without hard links). A name already taken gets a free one (`name
  (2).ext`, stored in the local-only `stored_path`) **only once the file has arrived**: until
  then the row keeps pointing at what is there. A regular file already there with the row's hash
  is kept (the row becomes `local`, nothing fetched: the upload pass asks the server whether it
  has it); another file is never touched. 404: stays `missing`, retried at the next run.
- Timeouts: status 15 s, chunk 5 min, download 30 min. Transfers are registered in memory so the
  views show « Envoi… » / « Téléchargement… ».
- Deletion: a pulled soft delete or tombstone (also a task or project tombstone's cascade) and
  the 24 h purge remove the local copy **and its `.part`**, unless a live attachment still points
  at the path, and the copy **only while it is still the attachment's file**: each freed file
  carries the row's `sha256` and is hashed first (after the sync's commit or the purge, outside
  the database lock and the async workers, at startup off the setup thread); a copy edited in place, or whose row never had a hash, stays on disk as the user's own
  file (the `.part` always goes). The purge does so even without an account.
- **« Télécharger »** (command `download_attachment`, core `files::save_copy`): a **copy** of the file goes into
  the user's Downloads folder (Tauri 2 `PathResolver::download_dir`, `$HOME/Downloads` on macOS)
  under a **free name** (`devis (2).pdf` when `devis.pdf` is there; checked on disk only), never
  over a file: copied to a hidden `.<attachment id>.part` in that folder, then put in place like
  a download (`hard_link`, then removal of the partial). The name is the attachment's
  `file_name` when it is one plain file name, else `fichier`. The copy keeps the source's
  `com.apple.quarantine` (`fs::copy` keeps extended attributes on macOS; set again if a volume
  did not). The file is « here » when its stored path is a regular file (a link is never
  followed, as in the job) and, linked, the row is not `missing` (a `missing` row's place may
  hold a copy edited here). Not here: unlinked → `file_not_here` (the UI greys « Télécharger »
  out then: the tile says « fichier introuvable » and nothing can bring the file); linked →
  **downloaded now**, ahead of the job, by the job's own download (same `.part`, resume, hash
  check, placement without replacing, state `sent`), then copied. A download that stops says
  why (the job only logs it and tries again at its next run): 404 → `file_not_on_server`; no
  network, a timeout, **nothing received for 60 s** (idle timeout on each read of the body, so
  a body that stops arriving never waits the 30 min of the whole download; the wait for the response headers is still only bounded by the 30 min) or a gateway error (502,
  503, 504) → `sync_offline`; 401 → `sync_auth` (the UI says « Connexion refusée :
  reconnecte-toi dans les Réglages. », as the sync does); any other error status →
  `sync_server`; the `.part` cannot be written in the task's folder → `disk_full` (`ENOSPC`,
  `EDQUOT`) or `file_write_failed`; any other failure (wrong hash, deleted meanwhile) →
  `internal`; the row stays `missing`. **macOS protects the Downloads folder**: the first copy
  makes macOS ask whether Taido may access the Downloads folder, with the sentence of
  `NSDownloadsFolderUsageDescription` (`src-tauri/Info.plist`, merged by the Tauri
  CLI into the bundle's Info.plist), again after each update of an app signed ad hoc; a refusal
  (`EPERM`/`EACCES` in that folder) → `downloads_denied`, whose message points to Réglages
  Système › Confidentialité et sécurité › Fichiers et dossiers › Taido › Téléchargements; a
  full disk there → `disk_full`, anything else → `file_write_failed`. **One download
  per attachment at a time**: the job and « Télécharger » take the attachment's slot (an async
  lock per id, in memory) for the whole download, and the job then fetches a row only while it
  is still `missing` with the same hash and stored path. Returns the copy's path; the UI shows
  « Enregistré dans Téléchargements » with « Afficher dans le Finder » (`reveal_path`), and the
  tile says « Téléchargement… » while the command runs (a second start does nothing).
- Logs: attachment ids, counts and error kinds only (never a URL, a name or a path).
- View model `Attachment.remote`: `none` | `local_only` | `uploading` | `to_download` |
  `downloading` | `too_large` | `quota_full`. Unlinked → always `none` (everything is local, so
  the tile says nothing; « fichier introuvable » as before). Linked → an active transfer first
  (`uploading` / `downloading`); `file_too_large` → `too_large`; `quota_exceeded` → `quota_full`;
  no file on disk → `to_download`; `missing` with a different file at the place → `to_download`;
  `local` → `local_only`; `sent` or `missing` with its file → `none`. Labels: « Sur ce Mac
  seulement », « Envoi… », « À télécharger », « Téléchargement… », « Trop gros »,
  « Espace du compte plein ».

**Web app (site and phone).** The saved set keeps its sync part under the IndexedDB key
**`sync.4`** (§ 6.2), so that a build that predates it finds four parts of five, refuses the set
(`InconsistentStoreError`) and never saves nor syncs (see « Downgrades » below). The same
`attachment` rows are applied (§ 0.9) and the same
routes are used from the browser, with the file kept in **IndexedDB** (database `todo-files`
v1, store `files`, value `{blob, sha256, size}`; a separate database from `todo`, so that
upgrading the main one never blocks an open page of the previous build). A file added on the
device is hashed (Web Crypto, in memory), stored, then its row is created and pushed; the job
(run after each successful sync, single flight) sends it once its row has been pushed, with the
same status, resume and empty-first-chunk rules. Files added **without an account** are kept and
sent once the device is linked (the phone keeps all its data without an account too). Once sent,
the kept copy is dropped (it moves to an in-memory session cache of at most 32 MiB).
Per-attachment state on the device: `local` (kept here, not sent), `sent`, `missing` (not here;
a pulled hash that differs also gives `missing`), `too_large`, `quota_exceeded` (both retried at
each sync) and **`unsendable`** (the kept copy no longer matches its recorded hash — damaged
device storage: never sent again, but **kept** and still openable). Rules: a kept copy whose
attachment is gone, `sent` or `missing` is swept (never one being kept or sent, never one whose
deletion is held until « Les remettre » / « Supprimer partout » is chosen); a failed read leaves
the file `local`; a set without `state.attachments` (written by a build that predates
attachments) drops its `attachment:` snapshot, outbox and held entries; linked, it resets its
pull cursor to 0 **once**, so that the attachment rows it used to ignore arrive, and sets
`sync.filesRecovery`: **no kept file is swept** until the first successful sync, which then
gives back to the job the copies that are still the only ones (a pulled row `missing` whose kept
copy matches becomes `local`). The deletion guard (§ 6.2) counts the attachments that vanish while
their task stays, with their own ratio (one purged with its task is not counted).

| Situation | Tile on the web (only with an account) |
| --- | --- |
| added here, not sent yet (`local`, `unsendable`) | « Sur cet appareil seulement » |
| chunk in flight | « Envoi… » |
| being fetched to download it (or read from this device) | « Téléchargement… » |
| refused: too large / account full | « Trop gros » / « Espace du compte plein » (retried at each sync) |
| on the server, not on this device | nothing (normal on the web: files are fetched when downloaded) |
| sent | nothing |

**« Télécharger »** (the tile's first item and its double-click) takes the copy kept on the device, else fetches the file whole (no `Range` on the web, a cut
download fails with a message), checks size and SHA-256, then **saves** it — every file,
images included. A file the server does not have yet says « Ce fichier n'est pas encore arrivé
sur ton compte. Réessaie plus tard. »; unlinked and not on the device: « Connecte-toi à ton
compte pour télécharger ce fichier. ». Hashing keeps the file in memory: expect a
peak of 2–3 times its size on a phone, so very large files can fail on low-memory devices (a
streaming hash is a possible improvement).

**Security of the web app** (same origin as the API: a script running there could read the
token). **Nothing of a file is ever shown** in the app: every file is **saved**, never opened in
a tab, rendered or put in a frame — an HTML page, an SVG, a PDF, a photo alike. The server's
content type is never read. Saving re-wraps
the bytes as `application/octet-stream`, clicks a hidden `<a download>` removed at once, and
revokes the URL 5 minutes later. (An HTML page opened from a `blob:` URL would run on the app's
origin.) The app also cancels any file drag released outside a drop zone, so a stray drop
never navigates to the file. The server adds its own layer: `Content-Disposition: attachment`,
`nosniff`, `Content-Security-Policy: sandbox`.

**Downgrades.** Never put the web app or the server back to an older build once phones are
linked. A web app that does not know attachments sees every `attachment:` key of the saved
snapshot as a vanished row and queues a tombstone for each (its deletion guard counts only
projects and tasks), and its saves drop `state.attachments`; the server then deletes the files.
The service worker keeps the previous build in its cache until the new worker is active, and
serves it for navigations that are offline, slower than 3 s or answered with an error. Three
protections narrow that window: (1) data saved by the current build is refused by older builds
(the key `sync.4`, above), (2) a set that an older build wrote anyway is recovered as described
above, (3) a waiting worker that is the running page's build activates at once (the page asks
it with `{type: "SKIP_WAITING_IF_SAME_BUILD", path}`, `path` = one of the page's scripts; the
worker skips waiting only when it pre-caches that path and answers `{skipping}`), so the window
closes at the first opening online. Putting an older image back on the server stays forbidden.

---

## 1. Principles

- One person's few devices (a Mac, a phone) per account — many accounts on one server
  (§ 0.2). Conflicts are rare: **last writer wins per whole row**, decided by the server
  only. Each device makes **monotonic** stamps (§ 2.6), so a slow clock or a clock stepping back
  never makes a newer edit lose to an older one the device has already seen.
- The server is a dumb, durable log of the latest version of every row, with a monotonic
  revision and an **epoch** (identity of its database). Clients push their changed rows and
  pull every row newer than their cursor with `POST /api/sync`, in chunks (§ 2.7).
- Synced: projects (`subjects`, incl. sub-projects and groups), `sections`,
  tasks and sub-tasks (`tasks`, `parent_id`), with their notes (`description`), due date/time,
  priority, completion, positions, soft deletes (`deleted_at`) and hard deletes (tombstones);
  also Kanban columns, time segments, task relations and attachment
  rows (§ 0.5), and the **attachment files** themselves (their content, through
  `/api/files/…`, § 0.13).
- **Never synced as rows**: `subjects.root_path`, `sections.subpath`, `tasks.workdir_override`,
  `time_segments.agent_session_id`, `attachments.stored_path`, `attachments.remote` and
  `attachments.shared` (the files themselves travel apart, § 0.13), `terminals`, `agent_sessions`, `journal_entries`, `hook_events`, `settings`.
- Sync is **fully off** until an account is linked (an explicit network exception). No other network access is added.
- After applying remote changes the Mac creates missing project folders with
  `db::workspace::ensure`; sync never deletes nor renames a folder.
- Every device ends in the same state: whatever a client corrects locally after an apply
  (§ 2.5 normalisation) is itself pushed.

## 2. Protocol (`crates/sync-proto`, version 3)

> **Protocol 3.** The four entities beyond projects, sections and tasks, `is_group`,
> `board_column_id`, the account messages and error codes, the Mac's apply rules (order,
> parking, cascades, N9/N10), the default columns, running segments and account switching are
> all described in **§ 0**; the sections below keep the base text and say where § 0 extends
> them.

Rust: `sync_proto::*` (path dependency `sync-proto = { path = "../crates/sync-proto" }` from
`src-tauri/` and `sync-server/`; no Cargo workspace, each crate keeps its own `target/`).
TypeScript mirror: `src/lib/sync-proto.ts`. **Any change to one changes the other and the
fixtures in the same commit**; a protocol change is a deliberate, reviewed commit.

JSON is snake_case. `PROTOCOL_VERSION = 3` travels in every request and response. A client or
server of another version is refused with `unsupported_protocol` (no compatibility layer:
update the server and the Mac app together, the PWA updates with the server).

Constants (both languages): `MAX_SYNC_BODY_BYTES` 16 MiB, `MAX_LOGIN_BODY_BYTES` 4 KiB,
`MAX_ID_LEN` 128, `MAX_STAMP_LEN` 64, `MAX_PUSH_CHANGES` 500, `MAX_PUSH_BYTES` 4 MiB,
`MAX_PULL_CHANGES` 2000, `MAX_PULL_BYTES` 8 MiB, `EPOCH_STAMP` `"1970-01-01T00:00:00.000Z"`,
`MAX_SETTING_KEY_LEN` 64, `MAX_SETTING_VALUE_BYTES` 4096, `SETTING_INBOX_POSITION` `"inbox_position"`,
`MAX_FILE_NAME_BYTES` 255; file transfer:
`MAX_CHUNK_BYTES` 8 MiB, `DEFAULT_MAX_FILE_BYTES` 104 857 600, `DEFAULT_ACCOUNT_QUOTA_BYTES`
2 147 483 648; the file status answer is `FileStatus {protocol, received, size, complete}`.

### 2.1 Records

```jsonc
// Change = one version of one row, tagged by "entity"
// (more entities: "board_column" | "time_segment" | "relation" | "attachment", notebook: § 0.5)
{ "entity": "subject" | "section" | "task" | "setting",
  "id": "uuid",                       // 1..128 bytes; a setting's id is its key
  "updated_at": "2026-10-04T09:15:02.120Z", // canonical UTC, 24 chars: the conflict stamp
  "device_id": "uuid",                // ignored in a push (server stamps the token's device)
  "data": { … } | null }              // null = tombstone (gone for good)

// subject data                      // section data            // task data
{ "name": "Globex",                   { "subject_id": "…",       { "subject_id": "…" | null,
  "color": "teal",                     "name": "Admin",           "section_id": "…" | null,
  "parent_id": "…" | null,             "position": 2.0,           "parent_id": "…" | null,
  "position": 1.0,                     "created_at": "…" }        "title": "…",
  "created_at": "…",                                              "description": "…",
  "deleted_at": "…" | null }                                      "due_date": "YYYY-MM-DD" | null,
                                                                  "due_time": "HH:MM" | null,
                                                                  "priority": 1..4,
                                                                  "completed_at": "…" | null,
                                                                  "position": 1.0,
                                                                  "created_at": "…",
                                                                  "deleted_at": "…" | null }
// setting data: one shared setting, id = key, never deleted
{ "value": <any JSON value> }        // e.g. id "inbox_position", { "value": 2.5 }
// subject data also has "is_group": bool (absent = false), task data
// "board_column_id": "…" | null (absent = null); data of the other entities: § 0.5
// ChangeKey
{ "entity": "task", "id": "…" }
```

Golden examples: `crates/sync-proto/fixtures/sync_request.json`, `sync_response.json`.

`Change::validate` / `validateChange`: id 1–128 bytes; `updated_at` canonical
(`YYYY-MM-DDTHH:MM:SS.sssZ`, what `db::now_utc`, SQLite
`strftime('%Y-%m-%dT%H:%M:%fZ','now')` and `Date.prototype.toISOString` produce);
`device_id` ≤ 128 bytes; finite `position`; optional ids 1–128 bytes; not its own parent;
priority 1–4; `due_date` `YYYY-MM-DD`; `due_time` `HH:MM` and only with a date; free stamps
(`created_at`, `deleted_at`, `completed_at`) 1–64 bytes. **Names, titles and notes have no
length limit** (only the body size is limited): a long title on the Mac must never block
the sync.

Settings (`Change::Setting`, `SettingData { value: serde_json::Value }`; TS
`SettingChange`, `value: unknown`): the key (the change id) matches `[a-z0-9_]{1,64}`
(`is_setting_key` / `isSettingKey`); the serialized value is at most
`MAX_SETTING_VALUE_BYTES` (4 KiB); `inbox_position` must be a finite JSON number (the
position of « Sans projet » among the top-level projects); **a setting tombstone is
refused** (`"a setting is never deleted"`: a tombstone is final and would forbid any later
value); unknown keys are accepted as is (forward compatible). The conflict
rule is the same as for rows (last writer wins, § 2.3). Wire example:
`{"entity":"setting","id":"inbox_position","updated_at":"…","device_id":"…","data":{"value":2.5}}`.

### 2.2 Endpoints (all JSON, under `/api`)

| Route | Auth | Request | Response | Errors |
| --- | --- | --- | --- | --- |
| `GET /api/health` | — | — | `HealthResponse {ok:true, protocol:3}` | — |
| `POST /api/login` | — | `LoginRequest {protocol, email, password, device_name}` (body ≤ 4 KiB) | `LoginResponse {protocol, token, device_id, server_epoch}` | 400, 401, 413, 429 |
| `POST /api/logout` | Bearer | empty | `204` (token revoked) | 401 |
| `POST /api/sync` | Bearer | `SyncRequest {protocol, cursor, changes}` (body ≤ 16 MiB, ≤ `MAX_PUSH_CHANGES` changes) | `SyncResponse {protocol, server_epoch, cursor, changes, has_more, rejected, accepted, server_time}` | 400, 401, 413, 429, 507 |

413 `payload_too_large` also for more than `MAX_PUSH_CHANGES` (500) changes in one push (the
whole push is refused, nothing applied); 429 `rate_limited` when the account's send slots or the
server's parse slots stay busy (§ 4.3); 507 `quota_exceeded` when the push would grow the
account's synced row data above `TAIDO_RECORDS_QUOTA_BYTES` (default 50 MiB) or the server's disk
is below its free-space floor (the whole push is refused, nothing applied; a push that does not
grow the data always passes).

The account routes (`POST /api/signup`, `GET /api/account`, `POST /api/password/forgot`,
`POST /api/password/reset`, `POST /api/email/resend`) are in § 0.2; `POST /api/sync` reads and
writes only the rows of the token's account (§ 0.4).

- Auth header: `Authorization: Bearer <token>`.
- Errors: status + `ErrorBody {error: ErrorCode, message}`; `ErrorCode` ∈ `bad_request`
  (400: malformed JSON, bad `device_name`), `unsupported_protocol` (400), `unauthorized`
  (401), `payload_too_large` (413), `rate_limited` (429), `internal` (500); accounts:
  `email_taken` (409), `weak_password`, `bad_email`, `invalid_code` (400), `signups_closed`
  (403), `mail_unavailable` (503); files: `file_too_large` (413), `quota_exceeded` (507),
  `not_found` (404), `hash_mismatch` (400), `chunk_offset` (409: an upload chunk does not start at the bytes
  already received; read the file status again). `message` is English, for logs only. **An invalid change never fails the request** (§ 2.4).
- `device_name`: 1–64 characters (the Mac sends `"Mac"`, the PWA `"Téléphone"`).
- `token`: 43 characters, base64url (no padding) of 32 random bytes; returned once.
- `cursor`: `u64` (JSON number; stays far below 2^53).
- `server_epoch`: UUID string; changes only when the server database is reset or restored.

### 2.3 Conflict rule (`incoming_wins`, shared)

Decided by the **server only**, per whole row:

1. a stored tombstone is final (nothing replaces it, the row never comes back);
2. an incoming tombstone always wins;
3. otherwise the greater `(updated_at, device_id)` wins (byte-wise string compare, valid
   because `updated_at` is canonical); an **equal** pair wins too (re-push is idempotent).

Clients never resolve conflicts: they apply what the server returns, except rows they still
have to push (§ 2.7), which they push next.

### 2.4 Server algorithm of `POST /api/sync` (one SQLite transaction)

1. Authenticate (token → device and its account, `last_seen_at = now`); `protocol` must equal
   `PROTOCOL_VERSION` (3) (`unsupported_protocol`). Everything below reads and writes **only the
   rows of that account** (§ 0.4).
2. For each pushed change, in request order: if it fails `validate` → add its key to
   `rejected`, store nothing (logged with the key and reason, never the content); else stamp
   `device_id` = token's device; read the stored row; if absent or `incoming_wins` →
   `rev = max_rev + 1`, upsert, add the key to `accepted` (and remove it from `refused`);
   else add it to `refused`.
3. If `request.cursor > max_rev`, treat it as `0` (safety net; the epoch, § 2.6, is the real
   guard).
4. `page` = rows with `rev > cursor` whose key is **not** in `accepted`, ordered by `rev`,
   at most `MAX_PULL_CHANGES` rows **and**, from the second row on, at most `MAX_PULL_BYTES`
   (8 MiB) of row data (a larger row comes alone). `has_more` = more such rows exist; response
   `cursor` = the `rev` of the last row of `page` when `has_more`, else `max_rev`.
5. `changes` = `page` + the current stored version of every `refused` key whose
   `rev <= request.cursor` (a refused key above the cursor is in `page` or a later page),
   ordered by `rev`. `accepted` = number stored, `server_epoch` = `meta.server_epoch`,
   `server_time` = now (canonical).

### 2.5 Client apply (both clients, one local transaction per response)

> The order, the parking table, the tombstone cascades and the normalisation below are
> extended with the entities of § 0.5 (columns, segments, relations, attachments, notebook) and
> rules N9–N11: **§ 0.6**. The phone applies them too (§ 0.9).

**Order.** Apply the response rows in this order (stable within a group):

0. setting data (settings reference nothing; a setting tombstone, refused by
   `validate`, is ignored);
1. subject data with `parent_id = null`; 2. subject data with a parent;
3. section data; 4. task data with `parent_id = null`; 5. task data with a parent;
6. tombstones: tasks with a parent, tasks, sections, sub-projects, projects.

Rows parked by earlier runs (see below) are merged in first, a pulled version of the same key
replacing the parked one.

**Missing references.** Within a group, a row whose reference is not present locally yet is
retried after the rest of its group (repeat while progress is made). A reference still
missing after that is handled so:

| Row | Reference missing | Action |
| --- | --- | --- |
| subject | `parent_id` | **park** the row |
| section | `subject_id` | park |
| task | `subject_id` | park |
| task | `section_id` | apply with `section_id = null`, **and** keep the row (parked) to apply it again once the section is here |
| task | section of another project | apply with `section_id = null` |
| task | `parent_id` | park |

Soft-deleted rows count as present. **Parked** rows are kept (Mac: table `sync_parked`; PWA:
`parked` in the persisted set) and retried at every apply; a parked row is dropped when a
newer version or a tombstone of its key arrives, and when its key has an outbox entry (a
local edit or deletion, pending or just sent: it goes out, and the server sends its own
version back if that one wins, § 2.4 step 5). A task kept for its section is not written
again while the section is still missing (its version is already here); it is not counted
as parked. (Pages are ordered by `rev`, so a section renamed after
its tasks can arrive one page later.) Parking replaces « skip »: a child pulled
before its parent (different pages, or the parent's outbox entry pushed in a later chunk)
is never lost.

**Writes.** Synced columns only, as `INSERT … ON CONFLICT(id) DO UPDATE SET <synced
columns>, updated_at = excluded.updated_at` — **never `INSERT OR REPLACE`** (a REPLACE deletes
the row first and the `ON DELETE CASCADE` would wipe its child tasks, terminals, sessions and
journal). Local-only columns are never written; a new row gets them `NULL`. The version's
stamp becomes the row's known version (Mac `sync_known`, PWA snapshot `stamp`, § 2.6).

**Tombstones.** For a tombstone of row X: its local descendants (sub-projects, sections,
tasks, child tasks, via a recursive query) that are **not** themselves tombstoned in this
response are deleted first **as local changes** (Mac: `applying = 0`, so their tombstones
are queued; PWA: they leave the snapshot as outbox tombstones), then X is deleted as an
applied row (`applying = 1`). A tombstone of an unknown row is a no-op. (Sections: tasks are
not descendants — `section_id` is `ON DELETE SET NULL`; the device that deleted the section
sends its tasks' new versions. Kanban columns work the same way, § 0.6.)

**Normalisation** (after all rows, same transaction, as **local changes** — Mac
`applying = 0`, PWA through the snapshot diff — so every correction is pushed and every
device converges). Rules, applied in this order until nothing changes:

| # | Situation | Correction |
| --- | --- | --- |
| N1 | subjects form a cycle through `parent_id` | clear `parent_id` of the cycle member with the lowest `(updated_at, id)` |
| N2 | a subject's parent itself has a parent (two levels) | `parent_id` = the parent's parent (repeat: ends one level deep) |
| N3 | tasks form a cycle through `parent_id` | clear `parent_id` of the member with the lowest `(updated_at, id)` |
| N4 | a task's parent itself has a parent | `parent_id` = the parent's parent |
| N5 | a child task's `subject_id` / `section_id` differ from its parent's | copy the parent's |
| N6 | a task's section belongs to another project | `section_id = null` |
| N7 | a live subject under a soft-deleted parent | `deleted_at` = the parent's `deleted_at` |
| N8 | a live task whose project (or parent task) is soft-deleted | `deleted_at` = that `deleted_at` |

N7/N8 = « la suppression gagne » (delete wins; « Annuler » / restore brings the row back
with its project because it shares the stamp). This is a product choice: the alternative
« la modification gagne » would instead clear the parent's `deleted_at`. N1–N8 are idempotent: a normalised database
produces no correction.

### 2.6 Stamps, known versions, re-enqueue, epoch

- **Monotonic stamps.** The stamp of a local change is
  `max(now, known(row) + 1 ms, device_last_stamp + 1 ms)` where `known(row)` is the stamp of
  the row's latest version this device has seen (applied or pushed), and `device_last_stamp`
  the device's previous stamp (persisted, updated with each new stamp). Mac: in the triggers
  (§ 3.1); PWA: `nextStamp(now, snapshot.stamp, lastStamp)` from `sync-proto.ts`. A stamp far
  ahead (a device with a wrong clock) propagates to edits of the same rows on other devices:
  accepted trade-off (ordering stays causal).
- **Known versions.** Mac table `sync_known(entity, id, stamp)`; PWA `snapshot[key].stamp`.
  Set when a row is applied (its `updated_at`) and when a pushed change was stored (its
  stamp: every pushed non-tombstone key not in `rejected` and not returned in `changes`);
  removed with the row on a tombstone.
- **Re-enqueue** (at link, and on an epoch change): every live or soft-deleted row **without
  an outbox entry** is enqueued with its known stamp, or `EPOCH_STAMP` when none is known.
  Shared settings are included (Mac rows of `synced_settings`, PWA
  `state.syncedSettings`); a device that never set a setting has no row for it and sends
  nothing.
  **Existing outbox entries are kept as they are** (`ON CONFLICT DO NOTHING`): they hold real
  edits. `updated_at` is never used as a conflict stamp (local-only writes bump it). Result:
  a row the server lacks is accepted; a stale copy loses to any real server version; a row
  this device holds at its latest version wins back a restored server.
- **Epoch.** The server makes a random UUID `meta.server_epoch` when it creates its database;
  the `reset-epoch` subcommand renews it and the restore procedure runs it (§ 4.5). Clients
  store it at link (`LoginResponse.server_epoch`). A response with another epoch: the
  client **ignores that response** (applies nothing, keeps its outbox), sets the cursor to
  `0`, stores the new epoch, re-enqueues (rule above), and starts the run again (once per
  run). The union of every device's data is rebuilt, newest versions first.

### 2.7 One run (both clients)

```text
S = current change counter (Mac sync_guard.seq; PWA: snapshot of the outbox at start)
loop (at most 1000 requests):
  chunk = outbox entries with seq ≤ S not yet sent in this run, by seq,
          ≤ MAX_PUSH_CHANGES and ≤ MAX_PUSH_BYTES of JSON (one larger change goes alone)
  response = POST /api/sync {cursor, changes: chunk}
  epoch differs → § 2.6 (once), restart
  apply response (§ 2.5), skipping every pulled row whose key still has an outbox entry
        other than an entry of this chunk unchanged since it was sent (it is pushed later;
        the server decides then)
  remove from the outbox the chunk's entries unchanged since sent, and the rejected ones
        (logged); record known stamps; cursor = response.cursor; commit
  stop when every entry ≤ S was sent and !has_more
```

A failure leaves the outbox and cursor as they were after the last committed chunk.
HTTP 413 halves the chunk (down to one change, then `error` `server`).

---

## 3. Desktop core

### 3.1 Migration `0010_sync.sql` (register in `db/mod.rs`, plain `M::up`)

```sql
-- Change tracking for the sync (docs/SYNC.md § 3). Triggers record every
-- change of a synced column of subjects / sections / tasks in `sync_outbox`, unless the
-- change comes from applying the server's rows (`sync_guard.applying = 1`). Hard deletes
-- (sections, purges, cascades) leave a tombstone (`purged = 1`). Foreign-key actions fire
-- these triggers too (ON DELETE CASCADE / SET NULL).

CREATE TABLE sync_guard (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  applying   INTEGER NOT NULL DEFAULT 0,   -- 1 only while applying pulled rows
  seq        INTEGER NOT NULL DEFAULT 0,   -- change counter
  last_stamp TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'  -- device's last stamp (§ 2.6)
);
INSERT INTO sync_guard (id) VALUES (1);

CREATE TABLE sync_outbox (
  entity     TEXT NOT NULL CHECK (entity IN ('subject', 'section', 'task')),
  id         TEXT NOT NULL,
  seq        INTEGER NOT NULL,             -- sync_guard.seq at the last change
  changed_at TEXT NOT NULL,                -- canonical UTC: the row's conflict stamp
  purged     INTEGER NOT NULL DEFAULT 0,   -- 1 = hard-deleted: push a tombstone
  PRIMARY KEY (entity, id)
);

CREATE TABLE sync_known (                  -- latest version seen of each row (§ 2.6)
  entity TEXT NOT NULL, id TEXT NOT NULL, stamp TEXT NOT NULL,
  PRIMARY KEY (entity, id)
);

CREATE TABLE sync_parked (                 -- pulled rows waiting for a parent (§ 2.5)
  entity TEXT NOT NULL, id TEXT NOT NULL,
  change TEXT NOT NULL,                    -- JSON of the sync_proto::Change
  PRIMARY KEY (entity, id)
);
```

Then, for each `(table, entity, synced columns)`:

| table | entity | synced columns compared in the UPDATE trigger |
| --- | --- | --- |
| `subjects` | `subject` | `name, color, parent_id, position, deleted_at` |
| `sections` | `section` | `subject_id, name, position` |
| `tasks` | `task` | `subject_id, section_id, parent_id, title, description, due_date, due_time, priority, completed_at, position, deleted_at` |

three triggers each, nine in all (example for `tasks`; same shape for the others):

```sql
CREATE TRIGGER sync_tasks_ai AFTER INSERT ON tasks
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  UPDATE sync_guard SET seq = seq + 1, last_stamp = max(
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', last_stamp, '+0.001 seconds'),
      COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ',
        (SELECT stamp FROM sync_known WHERE entity = 'task' AND id = NEW.id),
        '+0.001 seconds'), ''))
    WHERE id = 1;
  INSERT INTO sync_outbox (entity, id, seq, changed_at, purged)
  SELECT 'task', NEW.id, seq, last_stamp, 0 FROM sync_guard WHERE id = 1
  ON CONFLICT (entity, id) DO UPDATE
    SET seq = excluded.seq, changed_at = excluded.changed_at, purged = 0;
END;

CREATE TRIGGER sync_tasks_au AFTER UPDATE ON tasks
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
  AND (OLD.subject_id IS NOT NEW.subject_id OR OLD.section_id IS NOT NEW.section_id
    OR OLD.parent_id IS NOT NEW.parent_id OR OLD.title IS NOT NEW.title
    OR OLD.description IS NOT NEW.description OR OLD.due_date IS NOT NEW.due_date
    OR OLD.due_time IS NOT NEW.due_time OR OLD.priority IS NOT NEW.priority
    OR OLD.completed_at IS NOT NEW.completed_at OR OLD.position IS NOT NEW.position
    OR OLD.deleted_at IS NOT NEW.deleted_at)
BEGIN
  -- same body as the INSERT trigger
END;

CREATE TRIGGER sync_tasks_ad AFTER DELETE ON tasks
WHEN (SELECT applying FROM sync_guard WHERE id = 1) = 0
BEGIN
  -- same body with OLD.id and purged = 1 (also in the DO UPDATE)
END;
```

On SQLite 3.51: UPSERT is accepted in a trigger body
(`INSERT … SELECT … WHERE … ON CONFLICT` — the `WHERE` avoids the parsing ambiguity);
`AFTER DELETE` / `AFTER UPDATE` triggers fire for `ON DELETE CASCADE` / `SET NULL` actions;
`strftime` accepts the trailing `Z` and `'+0.001 seconds'`; the multi-argument `max()`
returns `NULL` when an argument is `NULL`, hence the `COALESCE(…, '')`. One statement
updating many rows gets strictly increasing stamps (`last_stamp + 1 ms`).

Why triggers: no repository function changes; and many existing writes do not bump
`updated_at` (soft delete stamps, restore, renumbering, moves), so the column cannot be the
conflict stamp. **The conflict stamp of a pushed row is `sync_outbox.changed_at`.**
Changes to local-only columns (`root_path` set by `workspace::ensure`, `subpath`,
`workdir_override`) and to `updated_at` alone record nothing. A future migration that
rewrites synced columns enqueues those rows (intended). **A migration that rebuilds a synced
table drops its triggers**: a test checks that, after all migrations, the expected `sync_%`
triggers exist (`sync::TRIGGER_COUNT`), and a startup check logs an error (`log::error!`) when
they do not.

**Migration `0011_synced_settings.sql`.**
New table `synced_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL /* JSON */,
updated_at TEXT NOT NULL)`, kept apart from the local-only `settings` (the sync token is
there). `sync_outbox` is rebuilt so its `CHECK` accepts `'setting'` (a `CHECK` cannot be
altered): the nine triggers above are dropped first, the rows are copied into the new table,
`idx_sync_outbox_seq` is recreated, then the nine triggers come back verbatim, plus three on
`synced_settings` (`sync_synced_settings_ai` / `_au` / `_ad`, entity `'setting'`, id
`key`; the UPDATE trigger compares `value`). The later migrations add more
(`0016_sync_v2.sql`, `0021_notes.sql`; § 0.5, `sync::TRIGGER_COUNT`), checked by the test and
the startup check. The app never deletes a
setting; the DELETE trigger only keeps a manual delete from desyncing silently (its
tombstone is refused by `validate` and dropped from the push). Accessors:
`db::synced_settings::{get, set, inbox_position, set_inbox_position}`; `set` writes nothing
when the value is unchanged, so no outbox entry.

### 3.2 Purge and startup order

Startup stays: open → orphans → `workspace::ensure` → **purge only when unlinked** (no
`sync_token`) → backup → `AppState`, then the sync worker starts. **When linked**, the worker
runs `trash::purge` right after the **first successful run** of the session (a row revived
by another device while the Mac was closed is pulled before the 24 h purge could delete it),
then pokes itself so the resulting tombstones go out. Network work never blocks the window.

### 3.3 Settings (rows of `settings`, JSON values; never synced, never in `Settings`)

| key | value | notes |
| --- | --- | --- |
| `sync_server_url` | `string` | kept after unlink |
| `sync_token` | `string` | removed on unlink; never logged |
| `sync_device_id` | `string` | from `LoginResponse`; removed on unlink |
| `sync_server_epoch` | `string` | from `LoginResponse`, renewed on an epoch change; removed on unlink |
| `sync_cursor` | `u64` | `0` at link; removed on unlink |
| `sync_interval_minutes` | `1 \| 5 \| 15 \| 30 \| 60` | default 5 |
| `sync_last_success_at` | `string` | canonical UTC |
| `sync_last_error` | `SyncErrorKind \| null` | last failure, cleared by a success |
| `sync_account` | `{ email }` | the account of the link, read from `GET /api/account` after a login and each successful run; removed on unlink; `sync_account()` returns it |

The token stays in SQLite (file private to the user, like the rest of the data; the daily
backups contain it). Keychain storage: later, if needed.

### 3.4 One sync run (`sync::engine::run_once`)

```rust
pub trait SyncHooks: Send + Sync {
    /// Called before an apply, without the DB lock: close the terminals of these tasks
    /// (the Tauri layer calls `TerminalService::close_task` for each).
    fn close_tasks(&self, task_ids: &[String]);
}
pub async fn run_once(db: &Arc<Mutex<Connection>>, documents: &Path, client: &SyncClient,
                      hooks: &dyn SyncHooks) -> Result<RunReport, SyncError>;
```

Never hold the DB mutex across an `await`. Per chunk of § 2.7:

1. Lock. If unlinked, or linked again since the run started (another token) → stop
   (`Superseded`, nothing recorded). Build the chunk: for each outbox entry, `purged = 1` or row
   missing → tombstone; else the row's synced columns as data; `updated_at` = `changed_at`,
   `device_id` = stored device id. Entries that fail `validate` locally are logged and
   removed from the outbox (never block the sync). Unlock.
2. `POST /api/sync`. Network error / timeout → state `offline`; 401 → `error`
   `unauthorized` (stay linked: the user reconnects); `unsupported_protocol` → `error`
   `unsupported_protocol`; 413 → halve the chunk (§ 2.7); other 4xx/5xx, an HTML body
   (a proxy or CDN challenge page) or unreadable JSON → `error` `server`.
3. Epoch check (§ 2.6).
4. Lock, read-only: collect the ids of tasks the response deletes (tombstone or `deleted_at`
   newly set), completes (`completed_at` newly set), or whose project / parent it deletes,
   **plus all their local descendants** (recursive query). Unlock; `hooks.close_tasks(ids)`.
5. Lock; if the link changed meanwhile (unlink or new link during the request) → stop
   without writing anything (the response belongs to the old link: its cursor and outbox
   state are not the new one's). One transaction: `applying = 1`; apply (§ 2.5: groups, retries, parked rows, UPSERT,
   tombstones with descendants at `applying = 0`); `applying = 0`; normalisation (§ 2.5);
   remove sent entries / rejected entries; known stamps; `sync_cursor`; commit.
6. After the last chunk, if at least one row was applied or corrected:
   `db::workspace::ensure(conn, documents)` (logged on failure, never fatal), then the Tauri
   layer calls `commands::data::notify(app, conn, &[Subjects, Tasks, Journal], None)`
   (emits `data-changed` + `counts-changed`) — **also when a later chunk failed**: the
   chunks already applied are committed and the UI must show them. On success:
   `sync_last_success_at = now`, `sync_last_error = null` (never recorded for an old link).
7. Emit `sync-changed` at every state transition (start: `syncing`; end: `idle`, `offline`
   or `error`).

Run report (for logs and tests): `RunReport { requests, pushed, accepted, rejected, applied,
parked, corrected, closed_task_ids, epoch_reset: bool }`.

### 3.5 Link and unlink

- **Accounts**: `sync_signup(AccountInput)` / `sync_login(AccountInput)`
  (`{ server_url, email, password }`; the UI passes `DEFAULT_SERVER_URL` =
  `https://sync.example.com` unless changed under « Avancé »). Normalise the URL
  (trim, drop trailing `/`); accept `https://host[...]`, or `http://127.0.0.1[:port]` /
  `http://localhost[:port]` (tests); else `invalid`. `POST /api/signup` or `/api/login` with
  `device_name: "Mac"`. **While linked**, both are refused before any request (`invalid`,
detail `already linked to an account: log out first`, French « Déconnecte-toi d'abord pour
changer de compte. »), except `sync_login` with the cached account's address (trimmed,
lowercased: a re-login after a refused token): logging in to another account would merge
this Mac's rows into it. Server codes → kinds: `unauthorized` → `sync_auth`, `rate_limited` →
  `sync_rate_limited`, `email_taken` → `sync_email_taken`, `weak_password` →
  `sync_weak_password`, `bad_email` → `sync_bad_email`, `invalid_code` → `sync_invalid_code`,
  `signups_closed` → `sync_signups_closed`, `mail_unavailable` → `sync_mail_unavailable`;
  network/timeout → `sync_offline`; other →
  `sync_server`. Success, in one transaction: **forget what a previous link learnt from its
  server** (cursor, epoch, `sync_known`, `sync_parked`: another server or another account;
  the outbox is kept, it holds real edits), store url, token, device id, epoch, cursor 0,
  clear `sync_last_error`, `sync_last_success_at` and the cached account; **re-enqueue**
  (§ 2.6: `INSERT … ON CONFLICT (entity, id) DO NOTHING`, every row at `EPOCH_STAMP` since no
  version is known any more). Then `GET /api/account` (best effort) caches `{ email }`
  in the setting `sync_account`; emit `sync-changed`; start a run in the background; return
  the status. The account is read again after every successful run (outside the run lock, 10 s
timeout); `sync_account()` returns
  the cached value (`null` when unlinked).
- `sync_forgot_password({ server_url, email })` → `POST /api/password/forgot` (204 whether the
  address has an account or not); `sync_reset_password({ server_url, email, code, password })`
  → `POST /api/password/reset` (204; every device of the account is logged out, the UI then
  calls `sync_login`). Same error mapping.
- `sync_unlink()`: best-effort `POST /api/logout` (5 s timeout, errors ignored); delete
  token, device id, epoch, cursor, last success, last error, cached account; keep the URL, the outbox, the
  known stamps and the parked rows (the triggers keep recording). Emit, return status
  (`unlinked`).

### 3.6 Worker and timers

`SyncService` in `AppState` (`pub sync: Arc<SyncService>`), started after `app.manage`:
one tokio task (`tauri::async_runtime::spawn`), single-flight (one run at a time):

- when linked: a run at start (then the purge, § 3.2), then every `interval_minutes`;
- `poke()`: called by `commands::data::notify` when its scopes contain `Subjects` or `Tasks`;
  schedules a run **10 s** later (debounced) **only if** `pending > 0` (an apply records
  nothing, so no loop; normalisation corrections are pending and go out at the next run);
- `sync_now` waits for the running sync, then runs one and returns the final status;
- `sync_set_interval` re-arms the timer.

HTTP client: **reqwest 0.13** `default-features = false, features = ["rustls", "json"]`
(rustls with aws-lc-rs and the platform verifier; **no OpenSSL** — `cargo tree -i openssl-sys`
is empty), one `Client` with `connect_timeout(10 s)`, `timeout(60 s)` (a large first pull over a
slow link), user agent `Taido/<version>`. Only the sync module talks to the network.

### 3.7 Commands, event and types (exact)

`src-tauri/src/commands/sync.rs`, registered in `collect_commands!`; event
`events::SyncChanged` in `collect_events!`. Types in
`src-tauri/src/sync/model.rs` (re-exported), all `specta::Type`:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SyncState { Unlinked, Idle, Syncing, Offline, Error }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SyncErrorKind { Unauthorized, Server, UnsupportedProtocol, Internal, DeletionsHeld }
// DeletionsHeld: never produced by the Mac (phone only, § 6.2); in the enum so the
// generated type matches src/bindings.ts.

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub state: SyncState,
    pub server_url: Option<String>,
    pub interval_minutes: u32,
    pub last_sync_at: Option<String>,
    pub error_kind: Option<SyncErrorKind>,
    pub pending: u32,
}

pub struct AccountInput { pub server_url: String, pub email: String, pub password: String }
pub struct ForgotInput { pub server_url: String, pub email: String }
pub struct ResetInput { pub server_url: String, pub email: String, pub code: String,
    pub password: String }
pub struct AccountInfo { pub email: String }

// events.rs
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct SyncChanged { pub status: SyncStatus }

// commands/sync.rs — every command is async
pub async fn sync_status(state: State<'_, AppState>) -> AppResult<SyncStatus>;
pub async fn sync_now(app: AppHandle, state: State<'_, AppState>) -> AppResult<SyncStatus>;
pub async fn sync_signup(state: State<'_, AppState>, input: AccountInput) -> AppResult<SyncStatus>;
pub async fn sync_login(state: State<'_, AppState>, input: AccountInput) -> AppResult<SyncStatus>;
pub async fn sync_forgot_password(state: State<'_, AppState>, input: ForgotInput) -> AppResult<()>;
pub async fn sync_reset_password(state: State<'_, AppState>, input: ResetInput) -> AppResult<()>;
pub async fn sync_account(state: State<'_, AppState>) -> AppResult<Option<AccountInfo>>;
pub async fn sync_unlink(app: AppHandle, state: State<'_, AppState>) -> AppResult<SyncStatus>;
pub async fn sync_set_interval(app: AppHandle, state: State<'_, AppState>, minutes: u32)
    -> AppResult<SyncStatus>;
```

Doc comments on the Rust types are emitted into `src/bindings.ts` by tauri-specta.

`state` semantics: `unlinked` (no token); `syncing` (a run is in flight); otherwise the
outcome of the last run: `idle` (success, or linked and never failed), `offline`, `error`
(+ `error_kind`). `pending` = rows in `sync_outbox`.

`AppError` variants and `ErrorKind`s of the sync (documented in the table of `error.rs`):
`SyncAuth` → `sync_auth`, `SyncOffline(String)` → `sync_offline`, `SyncServer(String)` →
`sync_server`, and, for the account commands only, `sync_rate_limited`, `sync_email_taken`,
`sync_weak_password`, `sync_bad_email`, `sync_invalid_code`, `sync_signups_closed`,
`sync_mail_unavailable`.

TypeScript (in `src/bindings.ts`, generated by tauri-specta):

```ts
syncStatus: () => Promise<SyncStatus>
syncNow: () => Promise<SyncStatus>
syncSignup / syncLogin: (input: AccountInput) => Promise<SyncStatus>
syncForgotPassword: (input: ForgotInput) => Promise<null>
syncResetPassword: (input: ResetInput) => Promise<null>
syncAccount: () => Promise<AccountInfo | null>
syncUnlink: () => Promise<SyncStatus>
syncSetInterval: (minutes: number) => Promise<SyncStatus>
events.syncChanged: SyncChanged            // "sync-changed"
type SyncState = "unlinked" | "idle" | "syncing" | "offline" | "error"
type SyncErrorKind = "unauthorized" | "server" | "unsupported_protocol" | "internal"
                   | "deletions_held"
type SyncStatus = { state; serverUrl: string | null; intervalMinutes: number;
  lastSyncAt: string | null; errorKind: SyncErrorKind | null; pending: number }
type AccountInput = { serverUrl: string; email: string; password: string }
type SyncChanged = { status: SyncStatus }
ErrorKind += "sync_auth" | "sync_rate_limited" | "sync_email_taken" | "sync_weak_password"
           | "sync_bad_email" | "sync_invalid_code" | "sync_signups_closed"
           | "sync_mail_unavailable" | "sync_offline" | "sync_server"
const DEFAULT_SERVER_URL = "https://sync.example.com"
```

Testability: the engine (`sync::client::SyncClient`, `sync::engine::{signup, login,
forgot_password, reset_password, refresh_account, unlink, run_once}`) takes `&Arc<Mutex<Connection>>`, the documents folder, a base URL and a
`&dyn SyncHooks`, never an `AppHandle`; the Tauri layer (`SyncService`, commands) only adds
events, timers, terminals and `notify`.

### 3.8 Robustness of existing code

- `db::workspace::ensure`: an error on one project is logged (`log::warn!` with the id)
  and the loop **continues** with the next; the function still returns the count created.
- `subjects::folder_name`: truncated to **200 bytes** on a char boundary (names typed on the
  phone are unlimited; macOS refuses components over 255 bytes). Existing folders are never
  renamed.
- Rust dependency versions shared with `sync-server` (it becomes a dev-dependency of
  `src-tauri` for the e2e test, and `libsqlite3-sys` has `links = "sqlite3"`):
  **`rusqlite = { version = "0.40", features = ["bundled"] }` and
  `rusqlite_migration = "2.6"` in both crates**, same majors.

### 3.9 Mock backend (TypeScript)

`src/lib/mock-sync.ts`: starts `unlinked`; `syncLogin` / `syncSignup` refuse a non-https URL
(`invalid`, same rule as § 3.5), a URL containing `"injoignable"` (`sync_offline`); login
refuses the password `"mauvais"` (`sync_auth`) and `bloque@exemple.fr` (`sync_rate_limited`);
signup refuses a malformed address (`sync_bad_email`), fewer than 10 characters
(`sync_weak_password`), `pris@exemple.fr` (`sync_email_taken`) and a URL containing
`"inscriptions-fermees"` (`sync_signups_closed`); else both link at once
(`idle`, `lastSyncAt = now`, account `{ email }`). `syncForgotPassword` refuses a
URL containing `"sans-mail"` (`sync_mail_unavailable`); `syncResetPassword` accepts only the
code `123456` (`sync_invalid_code`);
`syncNow` emits `syncing` then `idle`; `syncSetInterval` accepts 1, 5, 15, 30, 60;
`syncUnlink` keeps the URL. Tests force any state with `mockBackend.sync.set({...})`.
`MockBackend.emitDataChanged(scopes, taskIds?)` emits `data-changed` + `counts-changed`
(used by the PWA after applying pulled rows).

Placement in `mock-backend.ts` follows `db/positions.rs`: a move writes **one row**
(append = max + 1 over the scope, first = first − 1, else midpoint; renumber 1..n only when
the gap is under 1e-6); new projects/sections/tasks at max + 1; `byPosition` breaks ties on
`id` like `ORDER BY position, id`; moving a project to another level does not renumber the
level it left. Test: `src/lib/mock-positions.test.ts`.

---

## 4. Server — `sync-server/`

The server has **many accounts** and sends e-mail (§ 0).

Crate `taido-sync-server` (lib + bin), dependencies: `sync-proto` (path), axum 0.8, tokio,
rusqlite 0.40 (`bundled`) + rusqlite_migration 2.6 (same as `src-tauri`, § 3.8), tower-http
0.7 (`fs`, `trace`), argon2 0.6, sha2 0.11, base64 0.23, getrandom 0.4, uuid (v4, for ids and the epoch),
serde_json, clap 4 (derive), tracing + tracing-subscriber, and **lettre 0.11.23**
(`default-features = false`, features `builder`, `hostname`, `smtp-transport`,
`tokio1-rustls-tls`: rustls, no OpenSSL, no native-tls, no connection pool). No `unwrap()`
outside tests.

### 4.1 Config (env) and CLI

| env | default | Docker image |
| --- | --- | --- |
| `TAIDO_SYNC_BIND` | `127.0.0.1:3020` | `0.0.0.0:3020` (publish it as `127.0.0.1:3020:3020`) |
| `TAIDO_SYNC_DATA_DIR` | `./data` (SQLite database `sync.sqlite3` and the `files/` folder) | `/data` (volume) |
| `TAIDO_SYNC_STATIC_DIR` | unset = no static files | `/app/public` (built PWA) |
| `TAIDO_PUBLIC_URL` | unset = no address-confirmation e-mail and no host in mail footers; read only when `TAIDO_SMTP_HOST` is set; must start with `https://` or `http://` | unset (for example `https://sync.example.com`) |
| `TAIDO_SIGNUPS` | `open` (also when unset or empty); `closed` refuses `POST /api/signup` with 403 `signups_closed`; case-insensitive; any other value stops `serve` naming the variable | unset (`open`) |
| `TAIDO_MAIL_LANG` | `en` (also when unset or empty) or `fr`: language of the e-mails and of the address-confirmation pages; case-insensitive; any other value stops `serve` naming the variable | unset (`en`) |
| `TAIDO_SMTP_HOST` | unset = no e-mail (`forgot` answers 503, accounts are confirmed at signup) | unset |
| `TAIDO_SMTP_PORT` | `465` (implicit TLS; any other port = STARTTLS) | `465` |
| `TAIDO_SMTP_USER` / `TAIDO_SMTP_PASSWORD` | none; given together or not at all | none |
| `TAIDO_MAIL_FROM` | required when the host is set | none (for example `Taido <noreply@sync.example.com>`) |
| `TAIDO_MAX_FILE_BYTES` | `104857600` (100 MB per file, § 0.13) | unset (default) |
| `TAIDO_ACCOUNT_QUOTA_BYTES` | `2147483648` (2 GB of files per account) | unset (default) |
| `TAIDO_MIN_FREE_BYTES` | `2147483648` (2 GB kept free on the disk of `files/`) | unset (default) |
| `TAIDO_RECORDS_QUOTA_BYTES` | `52428800` (50 MiB of synced row data per account) | unset (default) |
| `RUST_LOG` | `info` | `info` |

The four `*_BYTES` variables are whole numbers of bytes, no unit (at most `i64::MAX`); a
malformed value stops `serve`. The limits and the signup mode are logged at start. Files are
always stored on the disk (§ 0.13); variables starting with `TAIDO_R2_` (a former remote
storage) are ignored with one warning at start.

An incomplete mail configuration (user without password or the reverse, missing or malformed
sender, bad port) stops `serve` with a clear message; the password is hidden from `Debug`.
Subcommands: `serve` (default); **`accounts`** (e-mail, creation, number of live devices);
`devices [<email>]` (id, e-mail, name, created, last seen,
revoked); `revoke <device_id>`; `reset-epoch` (new random `server_epoch`; run after restoring a
backup); `healthcheck` (GET `http://<TAIDO_SYNC_BIND>/api/health` with a 3 s timeout over a plain
`tokio::net::TcpStream` and a minimal HTTP/1.1 request — no HTTP client dependency; exit 0 when
`ok`, else 1; used by the Docker `HEALTHCHECK`, the slim image has no curl). Each person creates an
account from the app (unless signups are closed). `serve` prints exactly one line `LISTENING <addr>` on stdout once bound (tests use
`TAIDO_SYNC_BIND=127.0.0.1:0`), logs with tracing to stderr, shuts down gracefully on
SIGTERM/Ctrl-C.

### 4.2 Storage (`<data_dir>/sync.sqlite3`, WAL, foreign keys on, one connection behind a mutex)

Migrations with `rusqlite_migration`: `0001_init.sql` (the base schema), `0002_accounts.sql`
(accounts), `0003_files.sql` (the `files` table of § 0.13), `0004_records_bytes.sql` (the size of
each record, for the records quota), `0005_email_verification.sql` (address confirmation,
§ 0.2). A database of the former single-account schema holding a password or records is refused
**before** the migrations run (`store::refuse_legacy`, § 0.1); an empty one is upgraded
(`devices` and `records` are recreated, not converted).

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- 'server_epoch': random UUID made with the database, renewed by `reset-epoch`
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,                       -- UUID
  email TEXT NOT NULL UNIQUE,                -- lowercase, trimmed
  password_hash TEXT NOT NULL,               -- argon2id PHC string
  created_at TEXT NOT NULL);
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,           -- hex SHA-256 of the token
  created_at TEXT NOT NULL, last_seen_at TEXT, revoked_at TEXT);
CREATE TABLE records (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  entity TEXT NOT NULL, id TEXT NOT NULL,
  rev INTEGER NOT NULL UNIQUE,               -- unique across the whole server (global log)
  updated_at TEXT NOT NULL, device_id TEXT NOT NULL,
  data TEXT,                                 -- JSON of the entity's data; NULL = tombstone
  PRIMARY KEY (account_id, entity, id));     -- + index (account_id, rev)
CREATE TABLE password_resets (               -- one active code per account (§ 0.3)
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
```

`max_rev = COALESCE(MAX(rev), 0)` over the whole table. The server enforces no foreign keys
between records (clients do, § 2.5).

### 4.3 Auth

- Password: argon2id (default params), verified with `verify_password` (constant time),
  **inside `tokio::task::spawn_blocking`**, behind a `tokio::sync::Semaphore` with **1
  permit**: if a permit is not acquired within **1 s** → 429 `rate_limited`. An unknown or
  malformed address is checked against a dummy hash of the same cost (§ 0.2).
- Rate limits: the table of **§ 0.11**. Mechanism: each limiter
  keeps `{ failures: VecDeque<Instant>, in_flight: u32 }` behind a mutex; **before** verifying,
  drop failures older than the window; if `failures.len() + in_flight >= max` → 429; else
  `in_flight += 1` (the slot is reserved, released by a guard also on error/panic); a failure
  pushes `now`. A request reserves all its keys at once (`try_reserve_keys`, each key with its
  own maximum; slots taken are released if a later key refuses). Idle limiters are dropped.
  (A single global limit would let one anonymous client lock a user out of linking for good,
  and a limit keyed by address alone would let anyone lock an account out, hence the pair,
  client and global keys.)
- `/api/sync` and `/api/account` check the bearer token (middleware) **before** their body is
  read: an anonymous client never makes the server buffer a 16 MiB body.
- Bodies waiting in memory (`gate::BodyGates`): every non-GET request of a signed-in client
  (sync push, file chunk) takes **2 slots per account** (its Mac and its phone together) and **16
  for the server** (at most 16 x 16 MiB = 256 MiB of raw bytes in memory) before its body is
  read, waits at most **30 s** for them, then gets 429 `rate_limited`. Downloads (GET) are never
  gated. The sync body is parsed before the database lock is taken, and a parsed JSON tree is far
  larger than its bytes (about 32 B per value), so a second gate lets only **2** parsed sync
  requests exist at once, server-wide: a sync holds its slot from the parse until its database
  work ends (about 1 GiB worst case; same 30 s wait, then 429).
- Token: 32 random bytes → base64url no padding; stored as hex SHA-256; lookup by hash
  (`WHERE token_hash = ? AND revoked_at IS NULL`), giving the device **and its account**. The token
  itself is never stored nor logged.
- Never log passwords, codes, tokens, e-mail addresses, nor record content (titles, notes).

### 4.4 HTTP

- Routes of § 2.2 and § 0.2 and the algorithm of § 2.4 (per-change validation → `rejected`;
  page of `MAX_PULL_CHANGES` with `has_more`; `server_epoch` in login, signup and sync
  responses).
- Body limits with `DefaultBodyLimit`: 4 KiB for signup, login and the two password routes,
  16 MiB sync, 8 MiB (`MAX_CHUNK_BYTES`) for a file chunk (§ 0.13) → 413 `payload_too_large`
  (JSON error body). Malformed JSON → 400 `bad_request` (map axum's rejections to
  `ErrorBody`).
- **No CORS layer**: the PWA is same-origin; the Mac is not a browser. Local PWA development
  uses Vite's proxy (`/api` → `http://127.0.0.1:3020`).
- Static files (when `TAIDO_SYNC_STATIC_DIR` is set):
  - `/assets/*`: `ServeDir::new(<dir>/assets)` with **no fallback** — an unknown asset is a
    real **404** (never `index.html`); `Cache-Control: public, max-age=31536000, immutable`.
  - unknown `/api/*` → 404 JSON `ErrorBody`.
  - everything else: `ServeDir::new(<dir>).not_found_service(ServeFile::new(<dir>/index.html))`
    (SPA fallback for navigations, status 200).
  - Headers decided from the **response**, not from a path list: every `text/html` response
    and `/sw.js` get `Cache-Control: no-cache`; `/manifest.webmanifest` gets
    `Content-Type: application/manifest+json`; every response gets
    `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; every static response
    gets `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'
    'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; manifest-src 'self';
    worker-src 'self'; base-uri 'none'; frame-ancestors 'none'` (`'unsafe-inline'` styles:
    the toast library injects a `<style>`; `img-src blob:` is allowed but unused, since every
    file is saved, never shown, § 0.13).
- TLS is the reverse proxy's job; the app listens on loopback (or a private network) only.

### 4.5 Docker and deployment

- `sync-server/Dockerfile`, build context = repo root (`docker build -f
  sync-server/Dockerfile .`): stage 1 `node` + pnpm → `pnpm install --frozen-lockfile` and
  `pnpm build:mobile`; stage 2 `rust` (bookworm) → `cargo build --release` in
  `sync-server/`; stage 3 `debian:bookworm-slim`, non-root user, binary + `mobile/dist` as
  `/app/public`, `VOLUME /data`, `EXPOSE 3020`,
  `HEALTHCHECK CMD ["/app/taido-sync-server", "healthcheck"]`.
- Root `.dockerignore` (node_modules, target dirs, sandbox, .git, src-tauri/target…).
- The server listens on a loopback or private address and does not terminate TLS: put a
  reverse proxy (nginx, Caddy, Traefik…) with HTTPS in front of it. The proxy should pass the
  real client address in `X-Real-IP` (the rate limiters of § 0.11 key on it), accept bodies of
  at least 16 MiB and rate-limit `/api/login`, `/api/signup` and `/api/password/`.
- `sync-server/README.md`: build, configuration (the table of § 4.1), an example
  `docker compose` file, backups and the **restore procedure**: stop, copy the backup (database
  and `files/`), `taido-sync-server reset-epoch`, start (clients then rebuild the union, § 2.6).

---

## 5. Desktop UI

> On the Mac the account UI is `src/features/account` (welcome, account forms,
> Réglages › Compte); the phone uses `SyncSettings` (§ 6). The description below is the shared
> sync UI.

`commands.sync*` / `events.syncChanged` go through `src/lib/ipc.ts`, strings are `fr.sync.*`.
Folder `src/features/sync/`, public API in `src/features/sync/index.ts`:

```ts
export function useSyncStatus(): UseQueryResult<SyncStatus>;
export function SyncButton(props: { variant?: "sidebar" | "topbar" }): JSX.Element | null;
export function SyncSettings(props: { defaultServerUrl?: string }): JSX.Element;
```

- `useSyncStatus()` — React Query `["sync-status"]` on `commands.syncStatus()`, updated in
  place by `events.syncChanged` (set the query data from the payload).
- `SyncButton` — `variant` `"sidebar"` (default: sidebar footer, left of the Réglages
  button) or `"topbar"` (phone top bar: 44 px target). Icon `RefreshCw` (spinning while
  `syncing`), `CloudOff` when `offline`, `AlertCircle` (red) on `error`; renders `null` when
  `unlinked`. Click → `commands.syncNow()`. Accessible name and tooltip
  `fr.sync.buttonLabel(fr.sync.state[state], detail)` where `detail` is
  `fr.sync.lastSync(formatRelative(lastSyncAt))`, or `fr.sync.never`, or the error text
  `fr.sync.error[errorKind]`. When `pending > 0` and `idle`, `detail` may add
  `fr.sync.pending(n)`.
- `SyncSettings` — props `{ defaultServerUrl?: string }` (Mac: none → placeholder only;
  the PWA passes `location.origin`). Unlinked: intro, privacy line, fields `serverUrl`
  (`type="url"`) and `password` (`type="password"`, `autoComplete="current-password"`),
  button `link` (`linking` while pending). Errors under the form from `errorKind(error)`:
  `fr.sync.linkError[kind]` for `sync_auth | sync_offline | sync_server | invalid`, else
  `readableError`. Success → toast `fr.sync.linkedToast`, password cleared. Linked:
  `linkedTo(url)`, state + last sync line (with `fr.sync.error[errorKind]` on error), `syncNow`
  button, interval select (`intervalOption` for 1, 5, 15, 30, 60; `intervalHelp`), `unlink`
  button with confirmation dialog (`unlinkConfirmTitle`, `unlinkConfirmText`) → toast
  `unlinkedToast`.
- Réglages (`SettingsDialog.tsx`): tab `"sync"` (`SettingsTab`, `fr.settings.tabs.sync`)
  right after « Général », rendering `<SyncSettings />`. **Also**:
  the tabs `editor`, `claude` and `diagnostic` are listed only when `features.terminals`
  (desktop unchanged; on the phone only Général + Synchro remain), and the shortcut hints in
  Réglages only when `features.shortcuts`.
- Sidebar (`Sidebar.tsx`): wrap project/task drag-and-drop in `features.dragAndDrop` and
  folder actions in `features.folders` (desktop unchanged).

## 6. Mobile PWA

### 6.1 Architecture (decided): the same React UI, a third backend

- Entry `mobile/index.html` → `src/mobile/main.tsx`: imports **only** `src/mobile/mobile.css`
  (which imports the global CSS, § 6.5), calls `navigator.storage.persist()` (best effort,
  result logged), **awaits** `createMobileBackend()` (loads IndexedDB), sets
  `globalThis.__TODO_BACKEND__ = backend`, then `await import("./MobileApp")` and renders it.
  `src/lib/ipc.ts` then uses it as `mockBackend` (commands, events) — no change to ipc.ts.
- `MobileBackend extends MockBackend` (`src/mobile/backend.ts`): constructed with
  `{ seed: false }`; `newId()` overridden to `crypto.randomUUID()` (ids must be globally
  unique); state loaded from storage; `commands.syncStatus/syncNow/syncLogin/syncUnlink/
  syncSetInterval` replaced (`Object.assign(this.commands, …)`) by the real client; emits
  `events.syncChanged` like the core. Applying pulled rows writes `state.subjects/sections/
  tasks` directly (wire ↔ `SubjectRec`/`SectionRec`/`TaskRec`, local-only fields `null`),
  following § 2.5 entirely (groups, retries, parking, tombstones with descendants,
  normalisation N1–N8 done as local edits so the diff queues them), then
  `emitDataChanged(["subjects", "tasks"])`. The mock commands keep their behaviour; their
  placement already writes one row per move (§ 3.9).
- Build target flag: `IS_MOBILE` (`src/lib/target.ts`, Vite `--mode mobile`); feature
  flags in `src/lib/features.ts` (already set: mobile has `terminals`, `focusMode`,
  `states`, `folders`, `journal`, `dragAndDrop`, `shortcuts` **off**, `search` on).

### 6.2 Persistence, outbox, stamps

- IndexedDB database `todo`, version 1, object store `kv`. One persisted set
  `Persisted = { state, snapshot, outbox, parked, sync }`, each part under its own key, except
  `sync`, stored under **`sync.4`** (an older build reads another key, finds four parts of five
  and refuses the set, § 0.13 « Downgrades »; a set saved under an older key is moved by the
  first load, in one transaction) — the database version stays 1, so pages of another build
  are never blocked: `state` (subjects, sections,
  tasks incl. soft-deleted, settings.theme, and `syncedSettings?` — shared
  settings by key, optional so a set saved without it still loads as `{}`); `snapshot` (key `entity:id` →
  `{ json: string /* wire data */, stamp: string /* known version, § 2.6 */ }`); `outbox`
  (key → `{ changed_at, purged }`); `parked` (key → `Change`); `sync` (`serverUrl, token,
  deviceId, serverEpoch, cursor, intervalMinutes, lastSyncAt, errorKind, lastStamp,
  heldDeletions: string[]`).
- `MobileStore { load(): Promise<Persisted | null>; save(p: Persisted): Promise<void> }`
  with an IndexedDB implementation and an in-memory one for tests. **`save` writes the five
  keys in one `readwrite` transaction** (resolve on `complete`, reject on `error`/`abort`);
  **`load` rejects an inconsistent set** (some keys present and others missing, or a
  `snapshot` without `state`): the app then shows `fr.mobile.storageError` and starts
  without syncing (never diffs a partial state). Save after every `data-changed`
  (debounced 300 ms), after every sync chunk, and **immediately** on `visibilitychange` →
  `hidden` and on `pagehide`. Storage failure → toast `fr.mobile.storageError`.
- Change tracking by **snapshot diff**: on each `data-changed` with `subjects` or `tasks`,
  compute the wire data of every row; a key whose JSON differs from `snapshot` gets
  `outbox[key] = { changed_at: nextStamp(now, snapshot[key]?.stamp, sync.lastStamp),
  purged: false }`, and `snapshot[key] = { json, stamp: changed_at }`, `sync.lastStamp =
  changed_at`; a key missing now gets `purged: true` the same way (then leaves the
  snapshot). Applying pulled rows updates `snapshot` too (so they are not re-queued).
  `wireRows` / `wireJsonOf` include the settings (`setting:<key>` → `{ value }`), so a
  `reorderInbox` (it notifies `subjects` and `tasks`) queues `setting:inbox_position`; a
  pulled setting is written by `apply.ts`, a pulled setting tombstone is ignored.
- **Deletion guard.** In one diff, count the vanished subjects/tasks whose snapshot data was
  **live** (`deleted_at: null`) — the phone never hard-deletes a live row itself (purges
  remove soft-deleted rows; sections and settings are not counted, neither in the vanished
  rows nor in the snapshot total). Attachments are a second class with its own
  ratio: a live one counts when it vanishes while its task is still here and live (one purged
  with its task is that task's deletion). Held when **more than 25 live rows vanish in all, or,
  in either class, ≥ 5 vanish and > 20 % of that class in the snapshot** (subjects + tasks;
  attachments): so many attachments never dilute a wipe of projects and tasks: queue none of them, keep their snapshot
  entries, store their keys in `sync.heldDeletions`, set the status `error` /
  `deletions_held`, log it, and show a banner (`fr.mobile.deletionsHeld(n)`) with
  `deletionsHeldConfirm` (queue the tombstones, clear the hold) and `deletionsHeldRestore`
  (put the rows back into `state` from their snapshot data, `emitDataChanged`, clear the
  hold). Other changes keep syncing meanwhile. The Mac has no such guard: its tombstones come
  from real SQL deletes recorded by triggers, there is no snapshot that can tear.
- Same run algorithm as § 2.7 (in-flight marker: an outbox entry whose `changed_at`
  changed since it was sent). Purge of soft-deleted rows older than 24 h: at startup when
  unlinked; when linked, after the first successful run of the session (§ 3.2).
- Journal entries are not persisted (not shown, not synced).

### 6.3 Sync client (`src/mobile/sync/`)

`fetch` injectable (tests), base URL = `serverUrl` (default `location.origin`), JSON per
`src/lib/sync-proto.ts`, `device_name: "Téléphone"`, `AbortController` timeout 60 s.
Triggers: after load, every `intervalMinutes`, `visibilitychange` → visible, `online`
event, 3 s after a local change (debounced), the sync button. `navigator.onLine === false`
or a `TypeError` from fetch → `offline`. Error mapping identical to § 3.4/3.5 (a non-JSON
body → `server`). Link re-enqueue and epoch handling of § 2.6.

> **Accounts.** `syncLogin({ serverUrl, email, password })` follows § 3.5:
> `POST /api/login` with the e-mail; `unauthorized` → `sync_auth`, `rate_limited` →
> `sync_rate_limited`, network → `sync_offline`, other → `sync_server`; while linked, only
> the cached account's address (trimmed, lowercased) is accepted, else `invalid`
> (`ALREADY_LINKED`). Success forgets the previous server's state (`parked` emptied, every
> `snapshot` stamp back to `EPOCH_STAMP`; the outbox stays), stores the link (cursor 0, last
> sync and account cleared), re-enqueues, then reads `GET /api/account` (10 s, best effort)
> into `sync.account` (persisted; also read after every successful run, an answer for an older
> token dropped; cleared at unlink). `syncAccount()` returns it (`null` when unlinked).
> `syncSignup`, `syncForgotPassword`, `syncResetPassword` reject `invalid` with
> `NOT_ON_THE_PHONE` (accounts are created and reset from the Mac). The phone keeps
> `is_group` (`SubjectRec.isGroup`) and `board_column_id` (`TaskRec.boardColumnId`) and sends
> them back unchanged; `attachment` rows are applied and their files travel, and
> `board_column`, `time_segment` and `relation` rows are applied, kept and pushed
> (§ 0.9, § 0.13). The phone's
> Réglages › Synchro follows the Mac's account flows (`SyncParts.tsx`): « Fusionner » /
> « Annuler » before a login when it holds projects or tasks, and « Se déconnecter » syncs
> first and warns when that fails or leaves changes pending.

### 6.4 What the phone shows (phone width 360–430 px)

- Shows: Aujourd'hui, Prochainement, À faire, Sans projet, projects and sub-projects with
  their sections; task panel: title, note (description), due date, priority, completion,
  sub-tasks, **attachments** (add from the picker, a paste or a drop;
  « Télécharger » = the file saved, images too; remove; § 0.13), move to project/section, delete
  (with « Annuler »); quick add (§ 7 handles the
  mobile behaviour); create/rename/delete projects, sub-projects and sections; ⌘K search as
  a « Recherche » screen; Réglages = `SettingsDialog` (the Mac-only tabs are hidden) with the
  Synchro tab rendering `<SyncSettings defaultServerUrl={location.origin} />`;
  `<SyncButton variant="topbar" />` in the top bar.
- The « Liste | Kanban | Dashboard » tabs and the figures strip; the Kanban
  (under 1024 px: one column per screen with scroll snapping, column names and card counts on
  top, a card moved by « Déplacer vers… » or a long press then a drag; from 1024 px: columns side
  by side as on the Mac; column management as on the Mac; no column until the first complete
  pull, § 0.9); the Dashboard (figures 2 by 2 on the phone, blocks stacked, nothing about local
  Claude sessions); the chrono (all time, a Mac's running segment shown running and never
  stopped here; time added and removed by hand) and relations in the task panel. **From
  1024 px only**: « Portefeuille » in the sidebar (without the « Sessions » column) and its CSV
  export, downloaded as a file (`src/lib/mock-time-csv.ts` mirrors the core's `time_csv`).
- Hides (flags): terminals, Claude launch, states/rings of Claude, second line, folders and
  « Ouvrir dans… », journal and sessions, focus mode, list drag and drop (no reordering on the
  phone), keyboard shortcut hints.
- Layout `src/mobile/MobileShell.tsx` (composes existing components; `App.tsx` untouched):
  top bar (menu, view title, sync button); sidebar in a left drawer (`fr.mobile.menu`,
  `closeMenu`); list full width; task panel as a full-screen sheet with `fr.mobile.back`;
  floating « + » opening the quick add. Touch targets ≥ 44 px, inputs ≥ 16 px (no zoom),
  `viewport-fit=cover` + safe-area insets, actions shown without hover
  (`@media (hover: none)`). Banners: `offlineBanner` when offline, `linkFirst` when
  unlinked (opens Réglages on Synchro), `deletionsHeld` (§ 6.2), `updateReady` + `reload`
  when a new service worker waits.
- Mobile-only CSS lives in `src/mobile/mobile.css`, scoped under the `.mobile` root class;
  any edit to a shared component must leave the desktop rendering unchanged (guard with a
  flag or `IS_MOBILE`).

### 6.5 Build, CSS, manifest, service worker

- `vite.mobile.config.ts` (root): `root: "mobile"`, React + Tailwind plugins,
  `build.outDir: "dist"` → **`mobile/dist/`** (git-ignored by `dist`),
  `build.emptyOutDir: true`, dev proxy `/api` → `http://127.0.0.1:3020`. Scripts:
  `"dev:mobile": "vite --config vite.mobile.config.ts --mode mobile"`, `"build:mobile": "tsc
  && vite build --config vite.mobile.config.ts --mode mobile"`.
- **Tailwind sources.** With `root: "mobile"` the Tailwind v4 Vite plugin scans only
  `mobile/**` (it uses Vite's root as base when no `@source` is given — checked in
  `@tailwindcss/vite`). So `src/mobile/mobile.css` is the PWA's single Tailwind entry:
  `@import "../styles/globals.css";` then `@source "../";` (path relative to the CSS file:
  all of `src/`), then the mobile rules. Verify `@source` in the Tailwind v4 docs. Check
  (test or script): the built CSS in `mobile/dist/assets/*.css` contains a
  class used only under `src/features/`.
- `mobile/public/manifest.webmanifest`: `name` « Taido », `short_name` « Taido », `lang`
  `fr`, `start_url` `/`, `scope` `/`, `display` `standalone`, `background_color` and
  `theme_color`, icons 192 and 512 PNG (+ `maskable` 512) in `mobile/public/icons/`
  Chrome's installability criteria (web.dev): HTTPS, `name`/`short_name`, 192 and 512 icons,
  `start_url`, `display` standalone; no `prefer_related_applications`.
- **Service worker** `mobile/sw.js` (source, not in `public/`), emitted by a small Vite
  plugin in `vite.mobile.config.ts` (`generateBundle`: read the bundle's file names) as
  `dist/sw.js` with a header `const BUILD = "<hash of the emitted file names>"; const
  PRECACHE = [ "/", "/index.html", "/manifest.webmanifest", "/icons/…", "/assets/…" ];` —
  its bytes change at every deploy, so the browser sees an update. Behaviour: install
  pre-caches all of `PRECACHE` in cache `todo-<BUILD>`; activate deletes every other cache
  and calls `clients.claim()`; navigations network-first with a **3 s timeout**, falling
  back to the cached `/index.html`; `/assets/*` cache-first, caching a response only when
  `response.ok` and its `Content-Type` is not `text/html`; `/api/*` never cached;
  `message` `{type: "SKIP_WAITING"}` → `skipWaiting()`; `message`
  `{type: "SKIP_WAITING_IF_SAME_BUILD", path}` → `skipWaiting()` only when `PRECACHE` holds
  `path`, answering `{skipping}` on the message port. Registered by `main.tsx` in
  production only; when a worker waits (`registration.waiting`, or `updatefound` → installed
  while a controller exists) the page first asks it to activate if it is the page's own build
  (`path` = the pathname of one of the page's scripts, `swUpdate.ts`); otherwise, or with no
  answer within 1 s, the `updateReady` banner shows; « Recharger » posts `SKIP_WAITING`
  and reloads on `controllerchange`. The built `index.html` must contain no inline script
  (CSP, § 4.4).

## 7. Quick add `!2`…`!4` and quick add without terminals

- `src/features/quick-add/parse.ts`: new token kind `"priority"` with `value: 2 | 3 | 4`
  (`QuickToken`, `TokenKind`), `ParseResult.priority?: 2 | 3 | 4`. `!2`, `!3`, `!4` start a
  word and end like other tokens; the first one wins, later ones stay text; `!1`, `!5`,
  `!` alone stay text; respects `literals`. Removed from the title.
- `QuickAddDialog.tsx`: chip `fr.quickAdd.priority(n)` and token colour (use the
  `--priority-N` tokens); after `createTask`, `commands.setTaskPriority({ id, priority })`
  when a priority was parsed (no core change); help text becomes
  `"#projet · /section · demain 17h · !2 · >claude"` (edit `fr.quickAdd.help` and the
  test that asserts it).
- **When `features.terminals` is off** (the phone): the help text is
  `fr.quickAdd.helpMobile`; the `>claude` / `>shell` tokens are not recognised (they stay
  text, no chip, no launch); « Ajouter et lancer » and its shortcut are not shown. Desktop
  unchanged. Test it by mocking `features` (`vi.mock("../../lib/features", …)`).
- Tests in `parse.test.ts` and `QuickAddDialog.test.tsx`.

## 8. UI strings

The French strings are in `src/i18n/fr.ts` (`fr.sync.*` incl.
`error.deletions_held`, `fr.mobile.*` incl. `deletionsHeld*`, `fr.settings.tabs.sync`,
`fr.quickAdd.helpMobile`, `fr.quickAdd.priority`, `fr.errors.kind.sync_*`).

## 9. Tests

- **Server**: unit (conflict application, cursor/exclusion/page rules of § 2.4, per-change
  rejection, epoch creation and `reset-epoch`, rate limiter incl. in-flight reservation and
  the 1-permit semaphore, token hashing, password set/verify, body limits, error bodies);
  integration with `axum::Router` + `tower::ServiceExt::oneshot` or a bound `127.0.0.1:0`
  server and a temp data dir: login (epoch returned) → sync push/pull between two devices,
  refused older push returns the server row, tombstone finality, idempotent re-push, an
  invalid change in a batch → `rejected` and the others stored, 2 500 rows → two pages
  (`has_more`), `unsupported_protocol`, 401/429/413, 11 parallel bad logins → at most 10
  verified, static: unknown `/assets/x.js` → 404, unknown navigation → index.html 200 with
  `no-cache` and CSP, `healthcheck` subcommand exit codes. Library API for others:
  `pub async fn start_for_tests(data_dir: &Path) -> Result<TestServer, ServerError>` with `TestServer { pub base_url: String }` (stops on drop; an in-memory
  mailer; `create_account(email, password)`, `set_password`, `mailer()`, `wait_for_code(email,
  nth, timeout)`, `state()`) and `pub fn reset_epoch(data_dir: &Path) -> Result<String,
  ServerError>` (for the e2e). Tests never use a real SMTP server.
- **Desktop core**: migration 0010 (triggers record inserts/updates/soft deletes/hard deletes/cascades,
  ignore local-only columns and `updated_at`, ignore writes while `applying = 1`; the nine
  triggers exist after all migrations; stamps are monotonic: a row known at a future stamp
  gets known + 1 ms, two changes in one statement get increasing stamps);
  `run_once` against a fake HTTP server on `127.0.0.1:0` (axum, in the test) — push build,
  chunking (1 200 outbox entries → 3 requests, cursor stored after each), `has_more` loop,
  `rejected` dropped, apply order and in-group retry (C→A→B in one group), parking (child
  before parent across two responses → applied on the second), normalisation N1–N8 (each
  correction is queued: cycle, two levels, child task under a child, delete wins), apply
  of a parent's new version **keeps its child tasks, terminals and journal** (UPSERT, not
  REPLACE), tombstone of a project queues tombstones for its local tasks added offline,
  in-flight skip, local-only preservation, cursor, epoch change (cursor 0, re-enqueue with
  known stamps, newer local row wins back), error mapping (offline, 401, 400 protocol, 413
  halving, 500, HTML body); **relink: link, sync, unlink, edit (complete a task), relink →
  the edit is pushed with its own stamp and survives** (no stamp lowered); link with no
  known versions enqueues `EPOCH_STAMP`; `workspace::ensure` after apply (folders in a temp
  dir) and continuing after one failing project; a 300-character project name gets a
  ≤ 200-byte folder; purge after the first successful run when linked; unlink keeps data;
  `SyncHooks::close_tasks` receives the descendants. `pnpm typecheck` passes on the
  regenerated `src/bindings.ts`, and its sync types are **semantically** equal to
  the reference one (compare the type declarations, not bytes).
- **Desktop UI**: Vitest with the mock backend: settings tab link/unlink/interval/errors (password
  `"mauvais"`, URL with `"injoignable"`, bad URL), the editor/claude/diagnostic tabs hidden
  when `features.terminals` is false (mocked), sidebar button states via
  `mockBackend.sync.set` (incl. `deletions_held` text), `variant="topbar"`, tooltip texts,
  `syncNow` click.
- **Phone**: Vitest (in-memory `MobileStore`, fake `fetch` / fake server built on
  `sync-proto.ts` `incomingWins` with paging and `rejected`): diff outbox (create, edit,
  complete, soft delete, purge → tombstone) with monotonic stamps (a row pulled at a future
  stamp then edited gets stamp + 1 ms), **a move on the phone queues exactly one task**,
  apply order, retry, parking and normalisation, in-flight skip, chunked push, epoch change,
  link re-enqueue (outbox entries kept, others with known stamp or epoch), persistence round
  trip, atomic save (a failing save leaves the previous set), `load` rejects an
  inconsistent set, deletion guard (30 live rows vanish → held, confirm and restore paths),
  flush on `pagehide`, offline → online flush, triggers. `pnpm build:mobile` succeeds and
  emits `mobile/dist/{index.html,sw.js,manifest.webmanifest,icons/*}`; `sw.js` lists every
  emitted asset; the built CSS contains a class used only in `src/features/`.
- **Quick add**: parser and dialog tests above, including the `features.terminals` off case.
- **Settings**: `sync-proto` (Rust and TS, same
  cases) — fixtures round trip with the setting change, `setting` parse, `inbox_position`
  number ok / string refused, setting tombstone refused, bad keys (`Inbox`, `a-b`, 65 bytes)
  refused, unknown key accepted, value > 4 KiB refused; server — a setting is stored and
  pulled by another device, its tombstone is rejected; core — the triggers (§ 0.5), a v10
  database migrated keeps its outbox, `synced_settings` writes queue `'setting'` (an equal
  write does not, `applying = 1` does not), apply writes a pulled setting without queuing it,
  `re_enqueue` and an epoch reset include settings, two Macs converge on `inbox_position`
  (`e2e_tests`); phone — `reorderInbox` queues `setting:inbox_position`, persistence round
  trip with and without `syncedSettings`, the deletion guard ignores settings, two phones
  converge through the real server (`sync-e2e.test.ts`).
- **Accounts and entities**: `sync-proto` (Rust and TS,
  same cases, `fixtures/v3_entities.json`); server — signup / login / `account`,
  wrong password and unknown address answer alike (dummy check counted), two accounts with the
  same ids never see nor overwrite each other (filter removal makes 6 of 7 tests fail), paging
  with another account writing between pages, forgot always 204 with identical response bytes,
  6th try fails with the right code, a new code replaces the old, expired code, reset logs every
  device out, all limits of § 0.11, no address / password / code / token in the logs at TRACE, a
  legacy database refused, signups open and closed (`TAIDO_SIGNUPS`), address confirmation; core (real test server) — the four entities round trip,
  default columns made on two Macs make one set, a late default never undoes a rename, a
  running segment of another Mac is never stopped here, duplicate relations converge, a Mac
  linked to another server logs in to a new account and sends exactly its rows, a linked Mac
  never joins another account, every account error has its kind; UI — welcome, forms with errors under their field,
  forgotten-password flow, merge question (also over the welcome), logout warning; phone — a
  task in « À valider » and a group survive an edit, the four entities round trip, login by
  e-mail and the account reads, an old store still loads, the merge question and the logout
  flow of the Mac.
- **End to end**:
  1. Rust: `src-tauri` dev-dependency on `sync-server` (path; check the rusqlite /
     rusqlite_migration versions match, § 3.8); test `sync::e2e_tests` starts
     `start_for_tests` in a temp dir, two core databases (temp files) linked as « Mac » and
     « Mac 2 »: add / edit / complete / soft delete / purge / section delete / conflict
     (older loses) / clock skew (one side's clock ahead: the other's later edit still wins
     after seeing it) / offline (server stopped → `offline`, outbox kept, then flush) /
     server reset (`reset-epoch` + restored older file → both clients rebuild, nothing
     lost), folders created under a temp documents dir after receiving a project and a
     sub-project.
  2. TypeScript: `src/mobile/sync-e2e.test.ts` (`// @vitest-environment node`), skipped
     unless `TAIDO_SYNC_SERVER_BIN` is set: spawns the server binary with
     `TAIDO_SYNC_BIND=127.0.0.1:0`, temp data dir, account made by `POST /api/signup`, reads the
     `LISTENING` line, and runs the PWA sync client + `MobileBackend` against it (create
     project + sub-project + tasks, note, complete, delete; second client sees them).
  3. `pnpm check` green; `pnpm build:mobile`.

## 10. Main dependencies

Version requirements of the sync-related crates (exact versions are in the `Cargo.lock` files):
reqwest 0.13 (`rustls` with aws-lc-rs and the platform verifier; desktop client only),
axum 0.8, tower-http 0.7, tower 0.5 (tests), tokio 1, rusqlite 0.40 with rusqlite_migration 2.6
(identical in `src-tauri` and `sync-server`), argon2 0.6, sha2 0.11, base64 0.23, clap 4,
serde 1, serde_json 1, tracing-subscriber 0.3, and lettre 0.11.23 with `default-features =
false` and features `builder`, `hostname`, `smtp-transport`, `tokio1-rustls-tls` (rustls 0.23,
implicit TLS on port 465 through `relay()`).
