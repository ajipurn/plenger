import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileFacts, GuardFact, Value } from "../src/facts/model.ts";
import { scan } from "../src/scan.ts";
import { argument, assigned, callTo, definition, entry, factsOf, refName } from "./helpers.ts";
import { temporaryDir } from "./support/tmp.ts";

const php = (source: string) => factsOf("php", `<?php\n${source}`);

/** `scope test subject allowed` for each guard. */
function guards(facts: FileFacts): string[] {
  const text = (value: Value) =>
    value.kind === "name" ? value.text : value.kind === "string" ? value.value : value.kind;
  return (facts.guards ?? []).map(
    (guard: GuardFact) =>
      `${guard.scope ?? "<module>"} ${guard.test ?? "in"} ${text(guard.subject)} ${text(guard.allowed)}`,
  );
}

describe("PHP facts: names", async () => {
  const facts = await php(`namespace App\\Http;

use GuzzleHttp\\Client;
use App\\Models\\{User, Post as P};
use App\\Support;
use function App\\Support\\helper;
use const App\\Support\\LIMIT;

$client = new Client(['base_uri' => 'https://api.example.com']);
$client->get('/status');
User::find(1);
P::all();
Support\\Text::slug('x');
helper(LIMIT);
strtoupper('x');
new \\PDO('sqlite::memory:');
new Mailer();
require 'config.php';
require_once __DIR__ . '/bootstrap.php';
`);

  it("records each use clause and literal require as an import", () => {
    expect(facts.imports.map(({ module, local, kind }) => [module, local, kind])).toEqual([
      ["GuzzleHttp\\Client", "Client", "module"],
      ["App\\Models\\User", "User", "module"],
      ["App\\Models\\Post", "P", "module"],
      ["App\\Support", "Support", "module"],
      ["App\\Support\\helper", "helper", "module"],
      ["App\\Support\\LIMIT", "LIMIT", "module"],
      ["config.php", null, "require"],
    ]);
  });

  it("resolves classes through use aliases and the namespace, functions to the global one", () => {
    expect(facts.calls.map((call) => call.ref?.name)).toEqual([
      "GuzzleHttp\\Client",
      "GuzzleHttp\\Client().get",
      "App\\Models\\User.find",
      "App\\Models\\Post.all",
      "App\\Support\\Text.slug",
      "App\\Support\\helper",
      "strtoupper",
      "PDO",
      "App\\Http\\Mailer",
      "require",
      "require_once",
    ]);
    expect(callTo(facts, "GuzzleHttp\\Client").new).toBe(true);
    expect(refName(argument(callTo(facts, "App\\Support\\helper"), 0))).toBe("App\\Support\\LIMIT");
  });

  it("links a call on a variable to the assignment it is made through", () => {
    const get = callTo(facts, "GuzzleHttp\\Client().get");
    expect(get.callee).toBe("$client->get");
    expect(facts.assignments[get.receiver as number]?.target).toBe("$client");
    expect(entry(argument(callTo(facts, "GuzzleHttp\\Client"), 0), "base_uri")).toEqual({
      kind: "string",
      value: "https://api.example.com",
    });
  });

  it("passes the path of include and require as the call's argument", () => {
    expect(argument(callTo(facts, "require_once"), 0)).toMatchObject({
      kind: "concat",
      parts: [
        { kind: "name", text: "__DIR__" },
        { kind: "string", value: "/bootstrap.php" },
      ],
    });
  });
});

describe("PHP facts: classes and functions", async () => {
  const facts = await php(`
/** Pages of the site. */
#[Route('/pages', methods: ['GET'])]
final class PageController extends Controller implements Responsable
{
    private const LAYOUTS = ['plain', 'wide'];
    private $cache = null;

    public function __construct(private Client $http)
    {
        $this->client = new \\GuzzleHttp\\Client();
    }

    public function show(string $slug, int $id, ...$rest)
    {
        $this->client->get($slug);
        self::render(static::LAYOUTS);
        parent::boot();
        return $this->cache;
    }

    public static function render($layout) {}
}

function helper(?int $limit = 10): bool
{
    return false;
}

helper();
`);

  it("records classes, methods and functions with their parameters", () => {
    expect(facts.definitions.map((item) => [item.id, item.kind, item.exported])).toEqual([
      ["PageController", "class", true],
      ["PageController.__construct", "method", false],
      ["PageController.show", "method", false],
      ["PageController.render", "method", false],
      ["helper", "function", true],
    ]);
    const show = definition(facts, "PageController.show");
    expect(show.params).toEqual(["$slug", "$id", "$rest"]);
    expect(show.scalars).toEqual(["$id"]);
    expect(definition(facts, "helper").scalars).toEqual(["$limit"]);
  });

  it("reads PHPDoc, attributes and base classes", () => {
    const page = definition(facts, "PageController");
    expect(page.doc).toBe("Pages of the site.");
    expect(page.decorators).toMatchObject([
      {
        text: "Route('/pages', methods: ['GET'])",
        ref: { name: "Route" },
        arguments: [
          { keyword: null, value: { kind: "string", value: "/pages" } },
          { keyword: "$methods", value: { kind: "list" } },
        ],
      },
    ]);
    expect(page.bases.map(refName)).toEqual(["Controller", "Responsable"]);
  });

  it("resolves $this members, self and static, and leaves parent unresolved", () => {
    expect(callTo(facts, "\\GuzzleHttp\\Client".slice(1)).scope).toBe("PageController.__construct");
    const get = callTo(facts, "GuzzleHttp\\Client().get");
    expect(get.scope).toBe("PageController.show");
    expect(facts.assignments[get.receiver as number]?.target).toBe("$this->client");
    const render = callTo(facts, "PageController.render");
    expect(assigned(facts, argument(render, 0))).toMatchObject({ kind: "list" });
    expect(facts.calls.find((call) => call.callee === "parent::boot")?.ref).toBeNull();
    expect(callTo(facts, "helper").ref).toMatchObject({ kind: "local", definition: "helper" });
  });

  it("records returned values and whether they are falsy", () => {
    expect(definition(facts, "PageController.show").returns).toMatchObject([
      { kind: "name", text: "$this->cache" },
    ]);
    expect(definition(facts, "helper").returns).toEqual([{ kind: "literal", text: "false" }]);
  });
});

describe("PHP facts: variables and values", async () => {
  const facts = await php(`
$base = '/srv/pages';
$name = $_GET['name'] ?? 'home';
$items = [];

function outer($arg) {
    return $base . $arg;
}

$closure = function ($x) use ($base) {
    return $base . "/{$x}.html";
};
$arrow = fn($y) => $name . $y;

$items['k'] = 1;
foreach ($_POST['files'] as $key => $file) {
    file_get_contents($file);
}
[$first, $second] = explode(',', $name);
$text = "Hello $name, {$user->name}!\\n";
$quoted = 'it\\'s';
$page = <<<HTML
<h1>{$name}</h1>
HTML;
$listing = \`ls -la $base\`;
printf(format: '%s', values: $name);
`);

  it("keeps a function's variables apart from the file's, and closures to their use list", () => {
    expect(definition(facts, "outer").returns).toEqual([
      {
        kind: "concat",
        parts: [
          { kind: "name", text: "$base", ref: null },
          { kind: "name", text: "$arg", ref: null, param: true },
        ],
      },
    ]);
    const [closure] = definition(facts, "closure").returns ?? [];
    expect(closure?.kind === "concat" && assigned(facts, closure.parts[0])).toEqual({
      kind: "string",
      value: "/srv/pages",
    });
    const [arrow] = definition(facts, "arrow").returns ?? [];
    expect(arrow?.kind === "concat" && arrow.parts[0]).toMatchObject({
      text: "$name",
      assignment: 1,
    });
  });

  it("reads superglobals as globals, keyed by the string they are read with", () => {
    expect(assigned(facts, argument(callTo(facts, "file_get_contents"), 0))).toMatchObject({
      kind: "name",
      ref: { kind: "global", name: "$_POST.files" },
    });
    expect(facts.assignments.find((item) => item.target === "$file")?.member).toBe("[*]");
    expect(facts.assignments.find((item) => item.target === "$second")?.member).toBe("[*]");
  });

  it("marks an array the code changes in place", () => {
    expect(facts.assignments.find((item) => item.target === "$items")?.mutated).toBe(true);
    expect(facts.assignments.find((item) => item.target === "$base")?.mutated).toBeUndefined();
  });

  it("reads strings, interpolations, heredocs and backticks", () => {
    const value = (target: string) =>
      facts.assignments.find((item) => item.target === target)?.value;
    expect(value("$text")).toMatchObject({
      kind: "string",
      value: "Hello {$name}, {$user->name}!\n",
      template: [
        { kind: "name", text: "$name" },
        { kind: "name", text: "$user->name" },
      ],
    });
    expect(value("$quoted")).toEqual({ kind: "string", value: "it's" });
    expect(value("$page")).toMatchObject({ kind: "string", value: "<h1>{$name}</h1>" });
    const listing = callTo(facts, "shell_exec");
    expect(listing.callee).toBe("`ls -la $base`");
    expect(argument(listing, 0)).toMatchObject({ kind: "string", value: "ls -la {$base}" });
  });

  it("keeps the $ on named arguments, as on the parameters they fill", () => {
    expect(callTo(facts, "printf").arguments.map((arg) => arg.keyword)).toEqual([
      "$format",
      "$values",
    ]);
  });
});

describe("PHP facts: guards", async () => {
  const facts = await php(`
const PAGES = ['home', 'about'];

function show($page) {
    if (!in_array($page, PAGES, true)) {
        abort(404);
    }
    return $page;
}

function read($path) {
    if (str_contains($path, '..') || str_starts_with($path, '/')) {
        throw new InvalidArgumentException('bad path');
    }
    if (strpos($path, '~') !== false) {
        return null;
    }
    if (str_ends_with($path, '.json')) {
        echo $path;
    }
}

function choose($kind) {
    if (in_array($kind, ['a', 'b']) === false) {
        exit(1);
    }
    if ($kind !== 'a') {
        return;
    }
}

function allowed($name) {
    return in_array($name, PAGES, true);
}
`);

  it("reads membership, path and equality limits from if statements", () => {
    expect(guards(facts)).toEqual([
      "show in $page PAGES",
      "read excludes $path ..",
      "read relative $path /",
      "read excludes $path ~",
      "read ends $path .json",
      "choose in $kind list",
      "choose differs $kind a",
      "choose in $kind a",
    ]);
  });

  it("links a constant to its value and reads a function's returned check", () => {
    const [guard] = facts.guards ?? [];
    expect(assigned(facts, guard?.allowed)).toMatchObject({ kind: "list" });
    expect(definition(facts, "allowed").checks).toMatchObject([
      { subject: { text: "$name" }, allowed: { text: "PAGES" } },
    ]);
  });
});

describe("PHP in a scan", () => {
  it("parses .php files, mixed with HTML, as PHP and finds nothing it has no rules for", async () => {
    const root = await temporaryDir("plenger-php-");
    await mkdir(join(root, "public"), { recursive: true });
    await writeFile(
      join(root, "public/index.php"),
      "<html><?php echo shell_exec('ls ' . $_GET['dir']); ?></html>\n",
    );
    await writeFile(join(root, "public/view.phtml"), "<p><?= $title ?></p>\n");
    const result = await scan(root, { texts: true });
    expect(result.files.map((file) => [file.path, file.language, file.syntaxErrors])).toEqual([
      ["public/index.php", "php", false],
    ]);
    expect(result.textFiles?.map((file) => file.path)).toEqual(["public/view.phtml"]);
    expect(result.findings).toEqual([]);
  });
});
