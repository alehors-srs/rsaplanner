CREATE TABLE IF NOT EXISTS sections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  section_id TEXT REFERENCES sections(id),
  revision INTEGER NOT NULL DEFAULT 1,
  data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_section_idx ON tasks(section_id);
