-- By design: folders are now automatic. Every folder link made by hand is
-- forgotten (projects, tasks, section sub-folders); at startup the app gives every project
-- its folder in `~/Documents/Todo` (sub-projects inside their parent's), and tasks without
-- project work in `~/Documents/Todo/Sans projet`. Nothing is deleted on disk.
UPDATE subjects SET root_path = NULL;
UPDATE tasks SET workdir_override = NULL;
UPDATE sections SET subpath = NULL;
