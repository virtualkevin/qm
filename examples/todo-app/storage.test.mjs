import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TodoStorage } from "./storage.mjs";

test("stores, updates, deletes todos and persists across reopen as JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "todo-storage-"));
  const dbPath = join(dir, "todos.json");
  try {
    let store = new TodoStorage(dbPath);
    const created = store.create("Buy tea");
    assert.match(created.id, /^[\da-f-]{36}$/i);
    assert.deepEqual(created, { id: created.id, title: "Buy tea", done: false });
    assert.deepEqual(store.list(), [created]);
    assert.deepEqual(store.update(created.id, { done: true, title: "Buy coffee" }), {
      id: created.id,
      title: "Buy coffee",
      done: true,
    });
    store.close();

    assert.deepEqual(JSON.parse(readFileSync(dbPath, "utf8")), [{ id: created.id, title: "Buy coffee", done: true }]);
    store = new TodoStorage(dbPath);
    assert.deepEqual(store.list(), [{ id: created.id, title: "Buy coffee", done: true }]);
    assert.equal(store.delete(created.id), true);
    assert.equal(store.delete(created.id), false);
    assert.deepEqual(store.list(), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loads existing JSON data and rejects malformed JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "todo-storage-"));
  const path = join(dir, "todos.json");
  try {
    const todos = [{ id: "seed", title: "Existing task", done: true }];
    writeFileSync(path, JSON.stringify(todos));
    const store = new TodoStorage(path);
    assert.deepEqual(store.list(), todos);
    store.create("Another task");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).length, 2);
    writeFileSync(path, "{");
    assert.throws(() => new TodoStorage(path), SyntaxError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("same instance sees external JSON migration and preserves it on create", () => {
  const dir = mkdtempSync(join(tmpdir(), "todo-storage-"));
  const path = join(dir, "todos.json");
  try {
    const store = new TodoStorage(path);
    const migrated = [{ id: "migrated", title: "Migrated task", done: true }];
    writeFileSync(path, JSON.stringify(migrated));
    assert.deepEqual(store.list(), migrated);
    const created = store.create("New task");
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(persisted, [...migrated, created]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
