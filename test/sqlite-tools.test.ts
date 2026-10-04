import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scan } from "../src/scan.ts";

describe("SQLite effects through a tool's returned store", () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });

  async function project(
    options: { readOnly?: boolean; approval?: boolean; statementAlias?: boolean } = {},
  ) {
    const root = await mkdtemp(join(tmpdir(), "plenger-sqlite-tools-"));
    roots.push(root);
    const files = {
      "lib/store.ts": `import Database from "better-sqlite3";
export const createStore = () => {
  const db = new Database(":memory:");
  return {
    change: (id: string, amount: number) => {
      ${options.statementAlias ? 'const statement = db.prepare("UPDATE invoices SET amount = ? WHERE id = ?"); return statement.run(amount, id);' : 'return db.prepare("UPDATE invoices SET amount = ? WHERE id = ?").run(amount, id);'}
    },
    lookup: (id: string) =>
      db.prepare("SELECT amount FROM invoices WHERE id = ?").get(id),
  };
};
export const store = createStore();
`,
      "app/api/chat/route.ts": `import { streamText, tool } from "ai";
import { store } from "../../../lib/store";
const GUARD = false;
const tools = {
  ${
    options.readOnly
      ? ""
      : `change: tool({ ${options.approval ? "needsApproval: true," : ""} execute: async ({ id, amount }) => {
    if (GUARD) return { error: "Changes disabled" };
    return store.change(id, amount);
  } }),`
  }
  lookup: tool({ execute: async ({ id }) => store.lookup(id) }),
};
export async function POST(req: Request) {
  const { messages } = await req.json();
  return streamText({ model: "test", messages, tools });
}
`,
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }
    return scan(root);
  }

  it("links an imported factory-returned method to its SQLite write and flags the model's access", async () => {
    const result = await project();
    expect(result.inventory.tools.find((tool) => tool.name === "change")?.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "database",
          location: expect.objectContaining({ path: "lib/store.ts" }),
        }),
      ]),
    );
    expect(result.inventory.dataStores).toHaveLength(1);
    const write = result.inventory.tools.find((tool) => tool.name === "change")?.capabilities[0];
    expect(write).toMatchObject({ operation: "write", inputs: [] });
    expect(write?.dataInputs?.map((input) => input.text)).toEqual(["amount", "id"]);
    expect(result.findings.map((finding) => finding.rule)).toContain("PLG201");
    // Parameterized SQL is still a business write, but is not SQL injection.
    expect(result.findings.map((finding) => finding.rule)).not.toContain("PLG106");
  });

  it("keeps read-only parameterized queries out of action/approval findings", async () => {
    const result = await project({ readOnly: true });
    expect(result.inventory.tools[0]?.capabilities[0]).toMatchObject({
      kind: "database",
      operation: "read",
    });
    expect(result.findings).toHaveLength(0);
  });

  it("preserves the framework's approval boundary", async () => {
    const result = await project({ approval: true });
    expect(result.inventory.tools.find((tool) => tool.name === "change")?.approval).toBe(
      "needsApproval",
    );
    expect(result.findings.map((finding) => finding.rule)).not.toContain("PLG201");
  });

  it("follows an assigned prepared statement to execution", async () => {
    const result = await project({ statementAlias: true });
    expect(
      result.inventory.tools.find((tool) => tool.name === "change")?.capabilities[0],
    ).toMatchObject({ operation: "write" });
    expect(result.findings.map((finding) => finding.rule)).toContain("PLG201");
  });
});
