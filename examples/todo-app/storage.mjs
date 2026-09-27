import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export class TodoStorage {
  constructor(path = fileURLToPath(new URL("./todos.json", import.meta.url))) {
    this.path = path;
    this.todos = [];
    this.reload();
  }

  reload() {
    if (!existsSync(this.path)) {
      this.todos = [];
      return;
    }
    const parsed = JSON.parse(readFileSync(this.path, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("Invalid todos JSON: expected an array");
    const todos = parsed.map((todo) => {
      if (!todo || typeof todo.id !== "string" || typeof todo.title !== "string" || typeof todo.done !== "boolean") {
        throw new Error("Invalid todos JSON: malformed todo");
      }
      return { id: todo.id, title: todo.title, done: todo.done };
    });
    this.todos = todos;
  }

  persist() {
    const tempPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(this.todos, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, this.path);
  }

  list() {
    this.reload();
    return this.todos.map((todo) => ({ ...todo }));
  }

  create(title) {
    this.reload();
    const todo = { id: randomUUID(), title, done: false };
    this.todos.push(todo);
    this.persist();
    return { ...todo };
  }

  get(id) {
    this.reload();
    const todo = this.todos.find((item) => item.id === id);
    return todo ? { ...todo } : null;
  }

  update(id, changes) {
    this.reload();
    const todo = this.todos.find((item) => item.id === id);
    if (!todo) return null;
    if (changes.title !== undefined) todo.title = changes.title;
    if (changes.done !== undefined) todo.done = changes.done;
    this.persist();
    return { ...todo };
  }

  delete(id) {
    this.reload();
    const index = this.todos.findIndex((item) => item.id === id);
    if (index === -1) return false;
    this.todos.splice(index, 1);
    this.persist();
    return true;
  }

  close() {}
}
