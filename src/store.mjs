// Both runtimes supply the same two SQL operations.
export function createStore(db) {
  return {
    async snapshot() {
      const rows = await db.all(`
        SELECT 'section' AS kind, id, name, color, NULL AS section_id, NULL AS revision, NULL AS data FROM sections
        UNION ALL
        SELECT 'task', id, NULL, NULL, section_id, revision, data FROM tasks
        ORDER BY name, id
      `);
      return {
        sections: rows.filter(row => row.kind === 'section').map(({ id, name, color }) => ({ id, name, color })),
        tasks: rows.filter(row => row.kind === 'task').map(({ id, section_id, revision, data }) => ({
          ...JSON.parse(data), id, sectionId: section_id, revision
        }))
      };
    },
    async saveSection(id, { name, color }) {
      if (id) return db.run('UPDATE sections SET name = ?, color = ? WHERE id = ?', name, color, id);
      return db.run('INSERT INTO sections VALUES (?, ?, ?)', crypto.randomUUID(), name, color);
    },
    async saveTask(id, revision, sectionId, task) {
      const data = JSON.stringify(task);
      if (id) {
        return db.run(
          'UPDATE tasks SET section_id = ?, data = ?, revision = revision + 1 WHERE id = ? AND revision = ?',
          sectionId, data, id, revision
        );
      }
      return db.run('INSERT INTO tasks VALUES (?, ?, 1, ?)', crypto.randomUUID(), sectionId, data);
    },
    deleteTask(id, revision) {
      return db.run('DELETE FROM tasks WHERE id = ? AND revision = ?', id, revision);
    }
  };
}
