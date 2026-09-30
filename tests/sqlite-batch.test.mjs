import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

/**
 * The Node runtime's D1-compatible database (server/runtime/sqlite-database.ts): batch() must
 * be one atomic transaction that nothing else runs inside. The first two tests reproduce the
 * defects found in the A5.2.0 preflight, where batch() awaited between BEGIN and COMMIT:
 * another caller's write could run inside the transaction and be rolled back with it after
 * being reported as successful, and a second batch could fail with a nested BEGIN.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDirectory = mkdtempSync(join(root, "node_modules", "mailflare-sqlite-batch-"));
await build({
	stdin: {
		contents: `
			export { SqliteDatabase } from "./server/runtime/sqlite-database.ts";
			export { drizzle } from "drizzle-orm/d1";
			export { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
			export { eq } from "drizzle-orm";
		`,
		resolveDir: root,
		sourcefile: "sqlite-batch-test-entry.ts",
		loader: "ts",
	},
	outfile: join(bundleDirectory, "entry.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	packages: "external",
	logLevel: "silent",
});
const app = await import(pathToFileURL(join(bundleDirectory, "entry.mjs")).href);
test.after(() => rmSync(bundleDirectory, { recursive: true, force: true }));

function open(t) {
	const directory = mkdtempSync(join(tmpdir(), "mailflare-sqlite-batch-"));
	const database = new app.SqliteDatabase(join(directory, "batch.sqlite"));
	database.db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, v INTEGER NOT NULL)");
	t.after(() => {
		database.db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	return database;
}

const ids = (database) => database.db.prepare("SELECT id FROM t ORDER BY id").all().map((row) => row.id);
const insert = (database, id, v = 1) => database.prepare("INSERT INTO t (id, v) VALUES (?, ?)").bind(id, v);

test("A: an unrelated write is never absorbed into, and rolled back with, a failing batch", async (t) => {
	const database = open(t);
	// Another caller whose write is ready to run on the next microtask, while the batch runs.
	const other = (async () => {
		await null;
		return insert(database, "other").run();
	})();
	const failing = database.batch([insert(database, "a", 1), insert(database, "a", 2)]);
	await assert.rejects(failing, /UNIQUE constraint failed/);
	const result = await other;
	assert.equal(result.success, true);
	assert.equal(result.meta.changes, 1);
	assert.deepEqual(ids(database), ["other"], "the other caller's reported success stands; only the batch's own work is gone");
	assert.equal(database.db.inTransaction, false);
});

test("B: concurrent batches never fail because another batch has a transaction open", async (t) => {
	const database = open(t);
	const started = [];
	for (let index = 0; index < 20; index += 1) {
		started.push((async () => {
			for (let hop = 0; hop < index % 4; hop += 1) await null;
			return database.batch([insert(database, `x${String(index).padStart(2, "0")}`), insert(database, `y${String(index).padStart(2, "0")}`)]);
		})());
	}
	const results = await Promise.allSettled(started);
	assert.deepEqual(results.filter((result) => result.status === "rejected").map((result) => String(result.reason)), []);
	assert.equal(ids(database).length, 40);
	assert.equal(database.db.inTransaction, false);
});

test("a successful batch commits every statement and returns each statement's result in order", async (t) => {
	const database = open(t);
	const results = await database.batch([
		insert(database, "a", 1),
		insert(database, "b", 2),
		database.prepare("UPDATE t SET v = v + 10 WHERE id = ? RETURNING id, v").bind("b"),
		database.prepare("SELECT COUNT(*) AS n FROM t"),
	]);
	assert.equal(results.length, 4);
	assert.equal(results[0].meta.changes, 1);
	assert.deepEqual(results[2].results, [{ id: "b", v: 12 }], "RETURNING rows come back like D1's");
	assert.deepEqual(results[3].results, [{ n: 2 }], "later statements see earlier ones");
	assert.deepEqual(database.db.prepare("SELECT id, v FROM t ORDER BY id").all(), [{ id: "a", v: 1 }, { id: "b", v: 12 }]);
});

test("a failed batch rolls back all of its own statements, including those before the failure", async (t) => {
	const database = open(t);
	await insert(database, "kept").run();
	await assert.rejects(database.batch([insert(database, "n1"), database.prepare("UPDATE t SET v = 5 WHERE id = 'kept'"), insert(database, "n2"), database.prepare("INSERT INTO t (id, v) VALUES ('bad', NULL)")]), /NOT NULL/);
	assert.deepEqual(database.db.prepare("SELECT id, v FROM t").all(), [{ id: "kept", v: 1 }]);
	assert.equal(database.db.inTransaction, false);
	await database.batch([insert(database, "after")]);
	assert.deepEqual(ids(database), ["after", "kept"], "the database is usable after a rollback");
});

test("single statements still work: run, all, first, raw", async (t) => {
	const database = open(t);
	assert.equal((await insert(database, "a", 7).run()).meta.changes, 1);
	assert.deepEqual((await database.prepare("SELECT id, v FROM t").all()).results, [{ id: "a", v: 7 }]);
	assert.deepEqual(await database.prepare("SELECT v FROM t WHERE id = ?").bind("a").first(), { v: 7 });
	assert.equal(await database.prepare("SELECT v FROM t WHERE id = ?").bind("a").first("v"), 7);
	assert.deepEqual(await database.prepare("SELECT id, v FROM t").raw({ columnNames: true }), [["id", "v"], ["a", 7]]);
	assert.deepEqual(await database.batch([]), []);
});

test("existing callers stay compatible: drizzle's D1 batch over the wrapper", async (t) => {
	const database = open(t);
	const table = app.sqliteTable("t", { id: app.text("id").primaryKey(), v: app.integer("v").notNull() });
	const db = app.drizzle(database);
	const [inserted, updated, selected] = await db.batch([
		db.insert(table).values([{ id: "a", v: 1 }, { id: "b", v: 2 }]),
		db.update(table).set({ v: 3 }).where(app.eq(table.id, "a")).returning(),
		db.select().from(table).orderBy(table.id),
	]);
	assert.equal(inserted.meta.changes, 2);
	assert.deepEqual(updated, [{ id: "a", v: 3 }]);
	assert.deepEqual(selected, [{ id: "a", v: 3 }, { id: "b", v: 2 }]);
});
