//! Normalisation after an apply (docs/SYNC.md § 2.5, rules N1–N8; protocol 3 adds N9 and
//! N10, the project notebook N11). Runs with `applying = 0`: every correction is a local change, queued by the triggers and pushed, so
//! that every device converges. Rules are tried in order; the first one that corrects
//! something is applied, then everything is read again, until nothing changes. A normalised
//! database produces no correction.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};

use crate::error::AppResult;

/// Safety bound on the passes (each pass corrects at least one row).
const MAX_PASSES: usize = 1000;

struct Node {
    id: String,
    parent_id: Option<String>,
    updated_at: String,
    deleted_at: Option<String>,
}

struct TaskNode {
    node: Node,
    subject_id: Option<String>,
    section_id: Option<String>,
}

/// Runs N1–N11 until nothing changes; returns the number of corrections.
pub fn normalize(conn: &Connection) -> AppResult<usize> {
    let mut total = 0;
    for _ in 0..MAX_PASSES {
        let n = pass(conn)?;
        if n == 0 {
            return Ok(total);
        }
        total += n;
    }
    log::warn!("sync: normalisation stopped after {MAX_PASSES} passes");
    Ok(total)
}

fn pass(conn: &Connection) -> AppResult<usize> {
    let subjects = load_subjects(conn)?;
    let subject_nodes: Vec<&Node> = subjects.iter().collect();
    // N1: a cycle of projects through `parent_id`.
    if let Some(id) = cycle_victim(&subject_nodes) {
        conn.execute("UPDATE subjects SET parent_id = NULL WHERE id = ?1", [&id])?;
        return Ok(1);
    }
    // N2: a sub-project of a sub-project moves under its grandparent.
    let fixes = grandparent_fixes(&subject_nodes);
    if !fixes.is_empty() {
        for (id, parent) in &fixes {
            conn.execute(
                "UPDATE subjects SET parent_id = ?2 WHERE id = ?1",
                params![id, parent],
            )?;
        }
        return Ok(fixes.len());
    }

    let tasks = load_tasks(conn)?;
    let task_nodes: Vec<&Node> = tasks.iter().map(|t| &t.node).collect();
    // N3: a cycle of tasks.
    if let Some(id) = cycle_victim(&task_nodes) {
        conn.execute("UPDATE tasks SET parent_id = NULL WHERE id = ?1", [&id])?;
        return Ok(1);
    }
    // N4: a child of a child task moves under its grandparent.
    let fixes = grandparent_fixes(&task_nodes);
    if !fixes.is_empty() {
        for (id, parent) in &fixes {
            conn.execute(
                "UPDATE tasks SET parent_id = ?2 WHERE id = ?1",
                params![id, parent],
            )?;
        }
        return Ok(fixes.len());
    }

    // N5: a child task lives where its parent lives.
    let by_id: HashMap<&str, &TaskNode> = tasks.iter().map(|t| (t.node.id.as_str(), t)).collect();
    let mut n = 0;
    for task in &tasks {
        let Some(parent) = task.node.parent_id.as_deref().and_then(|p| by_id.get(p)) else {
            continue;
        };
        if task.subject_id != parent.subject_id || task.section_id != parent.section_id {
            conn.execute(
                "UPDATE tasks SET subject_id = ?2, section_id = ?3 WHERE id = ?1",
                params![task.node.id, parent.subject_id, parent.section_id],
            )?;
            n += 1;
        }
    }
    if n > 0 {
        return Ok(n);
    }

    // N6: a task's section belongs to its project.
    let sections = load_sections(conn)?;
    for task in &tasks {
        let Some(section) = task.section_id.as_deref() else {
            continue;
        };
        if sections.get(section) != Some(&task.subject_id) {
            conn.execute(
                "UPDATE tasks SET section_id = NULL WHERE id = ?1",
                [&task.node.id],
            )?;
            n += 1;
        }
    }
    if n > 0 {
        return Ok(n);
    }

    // N7: a live sub-project under a deleted parent is deleted with it (delete wins).
    let subject_by_id: HashMap<&str, &Node> = subjects.iter().map(|s| (s.id.as_str(), s)).collect();
    for subject in &subjects {
        if subject.deleted_at.is_some() {
            continue;
        }
        let Some(parent) = subject
            .parent_id
            .as_deref()
            .and_then(|p| subject_by_id.get(p))
        else {
            continue;
        };
        if let Some(at) = &parent.deleted_at {
            conn.execute(
                "UPDATE subjects SET deleted_at = ?2 WHERE id = ?1",
                params![subject.id, at],
            )?;
            n += 1;
        }
    }
    if n > 0 {
        return Ok(n);
    }

    // N8: a live task whose project or parent task is deleted is deleted with it.
    for task in &tasks {
        if task.node.deleted_at.is_some() {
            continue;
        }
        let from_subject = task
            .subject_id
            .as_deref()
            .and_then(|s| subject_by_id.get(s))
            .and_then(|s| s.deleted_at.clone());
        let from_parent = || {
            task.node
                .parent_id
                .as_deref()
                .and_then(|p| by_id.get(p))
                .and_then(|p| p.node.deleted_at.clone())
        };
        if let Some(at) = from_subject.or_else(from_parent) {
            conn.execute(
                "UPDATE tasks SET deleted_at = ?2 WHERE id = ?1",
                params![task.node.id, at],
            )?;
            n += 1;
        }
    }
    if n > 0 {
        return Ok(n);
    }

    // N9: a task in another project's Kanban column leaves it (back to the first column).
    n += conn.execute(
        "UPDATE tasks SET board_column_id = NULL WHERE board_column_id IS NOT NULL \
         AND NOT EXISTS (SELECT 1 FROM board_columns c WHERE c.id = tasks.board_column_id \
         AND c.subject_id IS tasks.subject_id)",
        [],
    )?;
    if n > 0 {
        return Ok(n);
    }

    // N10: two running segments of this Mac's chrono (with a session here) on one task: the
    // older stops when the newer starts. The local index forbids it: a safety net. Segments
    // pulled from another device (no session here) are that device's, never touched.
    n += conn.execute(
        "UPDATE time_segments SET ended_at = max(started_at, \
           (SELECT MIN(n.started_at) FROM time_segments n WHERE n.task_id = time_segments.task_id \
            AND n.ended_at IS NULL AND n.deleted_at IS NULL AND n.agent_session_id IS NOT NULL \
            AND n.id <> time_segments.id \
            AND (n.started_at, n.id) > (time_segments.started_at, time_segments.id))), \
         stop_reason = 'app_closed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
         WHERE ended_at IS NULL AND deleted_at IS NULL AND agent_session_id IS NOT NULL \
         AND EXISTS \
           (SELECT 1 FROM time_segments n WHERE n.task_id = time_segments.task_id \
            AND n.ended_at IS NULL AND n.deleted_at IS NULL AND n.agent_session_id IS NOT NULL \
            AND n.id <> time_segments.id \
            AND (n.started_at, n.id) > (time_segments.started_at, time_segments.id))",
        [],
    )?;
    if n > 0 {
        return Ok(n);
    }

    // N11: a notebook page in a group of another project leaves it (outside any group). A
    // group that is not here at all cannot be referenced (the apply writes such a page
    // without its group and keeps it waiting for it).
    n += conn.execute(
        "UPDATE note_pages SET group_id = NULL WHERE group_id IS NOT NULL \
         AND NOT EXISTS (SELECT 1 FROM note_groups g WHERE g.id = note_pages.group_id \
         AND g.subject_id = note_pages.subject_id)",
        [],
    )?;
    Ok(n)
}

/// A member of a `parent_id` cycle to cut: the lowest `(updated_at, id)` of the first cycle
/// found (by id order).
fn cycle_victim(nodes: &[&Node]) -> Option<String> {
    let parent: HashMap<&str, &str> = nodes
        .iter()
        .filter_map(|n| n.parent_id.as_deref().map(|p| (n.id.as_str(), p)))
        .collect();
    let by_id: HashMap<&str, &Node> = nodes.iter().map(|n| (n.id.as_str(), *n)).collect();
    let mut ids: Vec<&str> = nodes.iter().map(|n| n.id.as_str()).collect();
    ids.sort_unstable();
    for start in ids {
        // Walk up; a cycle through `start` comes back to it within `nodes.len()` steps.
        let mut members = vec![start];
        let mut seen: HashSet<&str> = HashSet::from([start]);
        let mut current = start;
        while let Some(&next) = parent.get(current) {
            if next == start {
                return members
                    .iter()
                    .filter_map(|id| by_id.get(id))
                    .min_by(|a, b| (&a.updated_at, &a.id).cmp(&(&b.updated_at, &b.id)))
                    .map(|n| n.id.clone());
            }
            if !seen.insert(next) {
                break;
            }
            members.push(next);
            current = next;
        }
    }
    None
}

/// `(id, grandparent)` for every node whose parent itself has a parent (no cycles left).
fn grandparent_fixes(nodes: &[&Node]) -> Vec<(String, String)> {
    let parent: HashMap<&str, &str> = nodes
        .iter()
        .filter_map(|n| n.parent_id.as_deref().map(|p| (n.id.as_str(), p)))
        .collect();
    let mut fixes = Vec::new();
    for node in nodes {
        let Some(p) = node.parent_id.as_deref() else {
            continue;
        };
        if let Some(&grandparent) = parent.get(p) {
            if grandparent != node.id {
                fixes.push((node.id.clone(), grandparent.to_string()));
            }
        }
    }
    fixes
}

fn load_subjects(conn: &Connection) -> AppResult<Vec<Node>> {
    let mut stmt =
        conn.prepare("SELECT id, parent_id, updated_at, deleted_at FROM subjects ORDER BY id")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Node {
                id: r.get(0)?,
                parent_id: r.get(1)?,
                updated_at: r.get(2)?,
                deleted_at: r.get(3)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

fn load_tasks(conn: &Connection) -> AppResult<Vec<TaskNode>> {
    let mut stmt = conn.prepare(
        "SELECT id, parent_id, updated_at, deleted_at, subject_id, section_id FROM tasks \
         ORDER BY id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(TaskNode {
                node: Node {
                    id: r.get(0)?,
                    parent_id: r.get(1)?,
                    updated_at: r.get(2)?,
                    deleted_at: r.get(3)?,
                },
                subject_id: r.get(4)?,
                section_id: r.get(5)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}

/// Section id → its project.
fn load_sections(conn: &Connection) -> AppResult<HashMap<String, Option<String>>> {
    let mut stmt = conn.prepare("SELECT id, subject_id FROM sections")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, Some(r.get::<_, String>(1)?))))?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}
