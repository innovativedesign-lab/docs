/**
 * check-integration-guides.ts
 *
 * Type-checks the framework integration guides (Svelte, Vue, Solid) against the
 * installed `@wraith-protocol/sdk`. The generic snippet checker
 * (scripts/check-snippets.ts) wraps every fence in `// @ts-nocheck`, so it only
 * catches syntax errors. These guides document the receive/scan flow call by
 * call, so a drifting SDK signature should fail the build, not ship.
 *
 * Every `ts`/`typescript` fence in a guide is compiled unless it is marked
 * `no-check` (framework glue that imports packages the docs repo does not
 * install). Each fence becomes its own module, so fences may repeat imports.
 *
 * CI installs the published `@wraith-protocol/sdk` tarball before running the
 * Snippet checks workflow, so this validates the guides against the exact
 * package developers will install.
 *
 * Usage
 *   pnpm run check:integration-guides
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();

const guides = [
  "guides/integrations/svelte.mdx",
  "guides/integrations/vue.mdx",
  "guides/integrations/solid.mdx",
];

const checkableLanguages = new Set(["ts", "typescript"]);

type Fence = {
  lang: string;
  attrs: string;
  code: string;
  /** 1-based MDX line of the opening fence. */
  line: number;
};

type Module = {
  name: string;
  /** Repo-relative guide this module was generated from. */
  file: string;
  /** 1-based MDX line of the fence's opening delimiter. */
  fenceLine: number;
  source: string;
  /** Number of source lines inside the fence. */
  lines: number;
};

async function main() {
  const modules: Module[] = [];
  const errors: string[] = [];

  for (const [fileIndex, file] of guides.entries()) {
    const markdown = await readFile(path.join(repoRoot, file), "utf8");
    const fences = parseFences(markdown).filter(
      (fence) => checkableLanguages.has(fence.lang) && !/\bno-check\b/.test(fence.attrs),
    );

    if (fences.length === 0) {
      errors.push(
        `${file}: no checked TypeScript fences. Add the SDK-facing code without a \`no-check\` marker.`,
      );
      continue;
    }

    fences.forEach((fence, fenceIndex) => {
      const name = `guide-${fileIndex}-${fenceIndex}.ts`;
      const body = fence.code.replace(/\s+$/, "");
      modules.push({
        name,
        file,
        fenceLine: fence.line,
        source: `// ${file}:${fence.line}\n${body}\nexport {};\n`,
        lines: body.split("\n").length,
      });
    });
  }

  if (errors.length > 0) fail(errors);

  const tmp = await mkdtemp(path.join(tmpdir(), "wraith-integration-guides-"));
  try {
    await writeFile(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }), "utf8");
    await symlink(path.join(repoRoot, "node_modules"), path.join(tmp, "node_modules"), "dir");
    await writeFile(
      path.join(tmp, "tsconfig.json"),
      JSON.stringify(createTsConfig(modules.map((module) => module.name)), null, 2),
      "utf8",
    );
    for (const module of modules) {
      await writeFile(path.join(tmp, module.name), module.source, "utf8");
    }

    const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
    const result = await run(
      process.execPath,
      [tsc, "--project", "tsconfig.json", "--pretty", "false"],
      tmp,
    );

    if (result.exitCode !== 0) {
      fail([`Type check failed:\n\n${mapLocations(result.output.trim(), modules)}`]);
    }
  } finally {
    await rm(tmp, { force: true, recursive: true });
  }

  console.log(
    [
      `Guides checked : ${guides.length}`,
      `Fences compiled: ${modules.length}`,
      `SDK            : @wraith-protocol/sdk`,
      "",
      "Integration guide check passed.",
    ].join("\n"),
  );
}

/** Collects fenced code blocks. Mirrors scripts/check-api-examples.ts. */
function parseFences(markdown: string): Fence[] {
  const fences: Fence[] = [];
  const lines = markdown.split("\n");
  let open: { lang: string; attrs: string; line: number; body: string[] } | null = null;

  lines.forEach((line, index) => {
    if (open === null) {
      const match = /^```([A-Za-z0-9_-]*)([^\n]*)$/.exec(line);
      if (match) {
        open = { lang: match[1].toLowerCase(), attrs: match[2] ?? "", line: index + 1, body: [] };
      }
      return;
    }
    if (/^```\s*$/.test(line)) {
      fences.push({ lang: open.lang, attrs: open.attrs, code: open.body.join("\n"), line: open.line });
      open = null;
      return;
    }
    open.body.push(line);
  });

  return fences;
}

function createTsConfig(files: string[]) {
  return {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022", "DOM"],
      types: ["node"],
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      noEmit: true,
    },
    files,
  };
}

/** Rewrites `guide-0-1.ts(12,5)` to the MDX location that produced the line. */
function mapLocations(text: string, modules: Module[]) {
  const byName = new Map(modules.map((module) => [module.name, module]));

  return text.replace(/(guide-\d+-\d+\.ts)\((\d+),(\d+)\)/g, (_, name: string, line, column) => {
    const module = byName.get(name);
    if (!module) return `${name}(${line},${column})`;
    const generated = Number(line);
    // Generated line 1 is the source-mapping comment; source line 1 is fenceLine + 1.
    const mdxLine = module.fenceLine + (generated - 1);
    return `${module.file}:${mdxLine}:${column}`;
  });
}

function run(command: string, args: string[], cwd: string) {
  return new Promise<{ exitCode: number; output: string }>((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env, shell: false });
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, output });
    });
  });
}

function fail(errors: string[]): never {
  console.error(`Integration guide check failed:\n\n${errors.join("\n\n")}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
