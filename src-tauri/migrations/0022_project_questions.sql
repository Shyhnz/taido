-- « Demander au projet »: each question asked to a project,
-- its verified answer and sources. Local only, like the conversations of the tasks (never
-- synced). One `thread_id` per opening of the panel: follow-up questions share it.
CREATE TABLE project_questions (
  id         TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  thread_id  TEXT NOT NULL,
  agent      TEXT NOT NULL,               -- claude|codex
  question   TEXT NOT NULL,
  answer     TEXT NOT NULL,
  sources    TEXT NOT NULL DEFAULT '[]',  -- JSON array of checked sources (ask::Source)
  asked_at   TEXT NOT NULL
);
CREATE INDEX idx_project_questions_subject ON project_questions(subject_id, asked_at DESC);
CREATE INDEX idx_project_questions_thread ON project_questions(thread_id, asked_at);
