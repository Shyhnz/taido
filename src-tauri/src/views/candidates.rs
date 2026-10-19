//! « + Lier une tâche » (Relations, 2026-10-11, option A): every task that can be linked,
//! in the app's order (sidebar order of the projects, « Sans projet » last, sections in
//! order, then position), each followed by its subtasks; and the recently changed ones.

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;

use crate::error::AppResult;
use crate::model::{RelationCandidate, RelationCandidates, SectionTag};
use crate::views::rows::{self, Filter, TaskFacts};

/// Size of « Récentes ».
const RECENT: usize = 8;

/// Candidates for `task_id`: neither the task itself nor its own subtasks (they already
/// belong to it). Open and completed tasks both come; the menu filters them.
pub fn relation_candidates(conn: &Connection, task_id: &str) -> AppResult<RelationCandidates> {
    let mut tops = rows::load(conn, Filter::All { completed: false })?;
    tops.extend(rows::load(conn, Filter::All { completed: true })?);

    let sections = section_tags(conn)?;
    let parents = parent_names(conn)?;
    let section_position = |t: &TaskFacts| {
        t.section_id
            .as_ref()
            .and_then(|id| sections.get(id))
            .map(|(_, p)| *p)
            .unwrap_or(f64::NEG_INFINITY)
    };
    // Projects in sidebar order, « Sans projet » last; open tasks before completed ones.
    tops.sort_by(|a, b| {
        let project = |t: &TaskFacts| match t.subject_order {
            Some((top, sub)) => (0, top, sub.unwrap_or(f64::NEG_INFINITY)),
            None => (1, 0.0, 0.0),
        };
        let (pa, pb) = (project(a), project(b));
        pa.0.cmp(&pb.0)
            .then(pa.1.total_cmp(&pb.1))
            .then(pa.2.total_cmp(&pb.2))
            .then(section_position(a).total_cmp(&section_position(b)))
            .then(a.completed_at.is_some().cmp(&b.completed_at.is_some()))
            .then(a.position.total_cmp(&b.position))
            .then(a.id.cmp(&b.id))
    });

    let titles: HashMap<String, String> = tops
        .iter()
        .flat_map(|t| std::iter::once(t).chain(t.children.iter()))
        .map(|t| (t.id.clone(), t.title.clone()))
        .collect();
    let candidate = |t: &TaskFacts| RelationCandidate {
        id: t.id.clone(),
        title: t.title.clone(),
        parent_id: t.parent_id.clone(),
        parent_title: t.parent_id.as_ref().and_then(|p| titles.get(p).cloned()),
        project: t.subject.as_ref().map(|s| match parents.get(&s.id) {
            Some(parent) => format!("{parent} › {}", s.name),
            None => s.name.clone(),
        }),
        subject: t.subject.clone(),
        section: t
            .section_id
            .as_ref()
            .and_then(|id| sections.get(id))
            .map(|(tag, _)| tag.clone()),
        ring: t.ring(),
        completed: t.completed_at.is_some(),
        due_date: t.due_date.clone(),
    };

    let mut seen = HashSet::new();
    let mut tasks = Vec::new();
    for top in &tops {
        if top.id == task_id || top.parent_id.as_deref() == Some(task_id) {
            continue;
        }
        if seen.insert(top.id.clone()) {
            tasks.push(candidate(top));
        }
        // An open subtask of a completed task is listed on its own in the open lists.
        for child in &top.children {
            if child.id != task_id && seen.insert(child.id.clone()) {
                tasks.push(candidate(child));
            }
        }
    }

    let mut stmt = conn.prepare(
        "SELECT id FROM tasks WHERE deleted_at IS NULL AND completed_at IS NULL \
         AND id <> ?1 AND (parent_id IS NULL OR parent_id <> ?1) \
         ORDER BY updated_at DESC, id LIMIT ?2",
    )?;
    let recent = stmt
        .query_map(rusqlite::params![task_id, RECENT as i64], |r| r.get(0))?
        .collect::<Result<Vec<String>, _>>()?
        .into_iter()
        .filter(|id| seen.contains(id))
        .collect();
    Ok(RelationCandidates { tasks, recent })
}

/// Every section: its tag and its position.
fn section_tags(conn: &Connection) -> AppResult<HashMap<String, (SectionTag, f64)>> {
    let mut stmt = conn.prepare("SELECT id, name, position FROM sections")?;
    let rows = stmt.query_map([], |r| {
        let id: String = r.get(0)?;
        Ok((
            id.clone(),
            (
                SectionTag {
                    id,
                    name: r.get(1)?,
                },
                r.get::<_, f64>(2)?,
            ),
        ))
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Name of the parent of each sub-project (« Globex » for « Globex › Client »).
fn parent_names(conn: &Connection) -> AppResult<HashMap<String, String>> {
    let mut stmt =
        conn.prepare("SELECT s.id, p.name FROM subjects s JOIN subjects p ON p.id = s.parent_id")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::{section, subject, task};
    use crate::db::{open_in_memory, subjects, subtasks, tasks};
    use crate::model::{AddSubtaskInput, GroupProjectsInput, SetCompletedInput};

    fn subtask(conn: &Connection, parent: &str, text: &str) -> String {
        subtasks::add(
            conn,
            &AddSubtaskInput {
                task_id: parent.into(),
                text: text.into(),
            },
        )
        .expect("subtask")
        .id
    }

    fn titles(c: &RelationCandidates) -> Vec<String> {
        c.tasks
            .iter()
            .map(|t| match &t.parent_title {
                Some(p) => format!("{p} › {}", t.title),
                None => t.title.clone(),
            })
            .collect()
    }

    #[test]
    fn every_task_in_order_with_its_subtasks_but_not_the_task_itself() {
        let conn = open_in_memory().expect("db");
        let globex = subject(&conn, "Globex");
        let client = subject(&conn, "Client");
        subjects::group_projects(
            &conn,
            &GroupProjectsInput {
                project_ids: vec![client.clone()],
                group_id: None,
                name: Some("Clients".into()),
            },
        )
        .expect("group");
        let billing = section(&conn, &globex, "Facturation");
        let current = task(&conn, "Rapport mensuel", Some(&globex), Some(&billing));
        subtask(&conn, &current, "Sa propre sous-tâche");
        let export = task(&conn, "Exporter les temps", Some(&globex), Some(&billing));
        subtask(&conn, &export, "Arrondir les durées");
        let done = subtask(&conn, &export, "Choisir les colonnes");
        tasks::set_completed(
            &conn,
            &SetCompletedInput {
                id: done,
                completed: true,
            },
        )
        .expect("complete");
        task(&conn, "Sans section", Some(&globex), None);
        task(&conn, "Audit", Some(&client), None);
        task(&conn, "Répondre au comptable", None, None);

        let c = relation_candidates(&conn, &current).expect("candidates");
        assert_eq!(
            titles(&c),
            [
                "Sans section",
                "Exporter les temps",
                "Exporter les temps › Arrondir les durées",
                "Exporter les temps › Choisir les colonnes",
                "Audit",
                "Répondre au comptable",
            ]
        );
        let audit = c.tasks.iter().find(|t| t.title == "Audit").expect("audit");
        assert_eq!(audit.project.as_deref(), Some("Clients › Client"));
        let export_row = &c.tasks[1];
        assert_eq!(
            export_row.section.as_ref().map(|s| s.name.as_str()),
            Some("Facturation")
        );
        assert!(c.tasks[3].completed);
        assert!(c.tasks.iter().all(|t| t.id != current));
        // « Récentes »: open ones, never the task nor its own subtasks.
        assert!(c.recent.iter().all(|id| *id != current));
        assert!(!c.recent.is_empty());
        assert!(c
            .recent
            .iter()
            .all(|id| c.tasks.iter().any(|t| t.id == *id && !t.completed)));
    }

    #[test]
    fn from_a_subtask_its_siblings_and_parent_are_offered() {
        let conn = open_in_memory().expect("db");
        let parent = task(&conn, "Migration", None, None);
        let me = subtask(&conn, &parent, "Exporter l'ancienne base");
        subtask(&conn, &parent, "Script de reprise");
        let c = relation_candidates(&conn, &me).expect("candidates");
        assert_eq!(titles(&c), ["Migration", "Migration › Script de reprise"]);
    }
}
