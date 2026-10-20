'use strict';

const db = require('./db');

// --- Row <-> API object mapping ---
function rowToTask(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    dueDate: row.due_date,
    completed: !!row.completed,
    order: row.order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const stmts = {
  // Default ordering favors what actually matters for a to-do list over the
  // manual "order" column links/notes use for drag-and-drop: tasks with a
  // due date come first (soonest first), tasks without one come last
  // (newest first) — "order" is kept as a stable tie-breaker rather than
  // the primary sort, since there's no drag-and-drop UI to set it here.
  allTasks: db.prepare(`
    SELECT * FROM tasks
    ORDER BY
      (due_date IS NULL) ASC,
      due_date ASC,
      created_at DESC,
      "order" ASC
  `),
  taskById: db.prepare('SELECT * FROM tasks WHERE id = ?'),
  insertTask: db.prepare(`
    INSERT INTO tasks (id, title, description, due_date, completed, "order", created_at, updated_at)
    VALUES (@id, @title, @description, @dueDate, @completed, @order, @createdAt, @updatedAt)
  `),
  deleteTask: db.prepare('DELETE FROM tasks WHERE id = ?'),
  maxOrder: db.prepare('SELECT MAX("order") AS maxOrder FROM tasks'),
};

// --- Array-based interface ---
// Mirrors lib/notes-persistence.js's readNotes(): convenient for routes that
// filter/search over the whole collection. No writeTasks() counterpart, by
// design — lib/persistence.js and lib/notes-persistence.js both grew (and
// then had to remove) an unused writeX()/ensureOrder() pair; every write
// path here goes through the direct SQL helpers below instead.
function readTasks() {
  return stmts.allTasks.all().map(rowToTask);
}

// --- Direct SQL helpers ---

function getTaskById(id) {
  const row = stmts.taskById.get(id);
  return row ? rowToTask(row) : null;
}

function insertTask(task) {
  stmts.insertTask.run({
    id: task.id,
    title: task.title,
    description: task.description || '',
    dueDate: task.dueDate || null,
    completed: task.completed ? 1 : 0,
    order: task.order ?? 0,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });
  return getTaskById(task.id);
}

function nextOrderValue() {
  const row = stmts.maxOrder.get();
  return (row.maxOrder ?? -1) + 1;
}

function deleteTaskById(id) {
  const info = stmts.deleteTask.run(id);
  return info.changes > 0;
}

module.exports = {
  readTasks,
  getTaskById,
  insertTask,
  deleteTaskById,
  nextOrderValue,
  rowToTask,
  stmts,
};
