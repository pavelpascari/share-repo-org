import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Guards the E2E GitHub seam (decision 0006): only the local `e2e` wrangler environment may point
// sign-in at a fake GitHub, and CI must never deploy it. This lives in the Node `scripts` project
// because it reads repository files, which the Workers test pool cannot.

const repoFile = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** Removes `//` and `/* *\/` comments and trailing commas outside strings, so JSON.parse accepts JSONC. */
function stripJsonc(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === '"') {
      const start = i;
      i++;
      while (i < source.length && source[i] !== '"') i += source[i] === "\\" ? 2 : 1;
      i++;
      out += source.slice(start, i);
    } else if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else {
      out += char;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

interface WranglerEnv {
  vars?: Record<string, string>;
  secrets?: { required?: string[] };
  d1_databases?: unknown[];
}
interface WranglerConfig extends WranglerEnv {
  env?: Record<string, WranglerEnv>;
}

const E2E_ONLY_VARS = ["GITHUB_OAUTH_BASE_URL", "GITHUB_API_BASE_URL"];
const REQUIRED_SECRETS = ["BETTER_AUTH_SECRET", "GITHUB_CLIENT_SECRET"];

describe("stripJsonc", () => {
  it("removes line and block comments and trailing commas", () => {
    const source = `{
      // line
      "a": 1, /* block */ "b": [1, 2,],
      /* multi
         line */
      "c": { "d": true, },
    }`;
    expect(JSON.parse(stripJsonc(source))).toEqual({ a: 1, b: [1, 2], c: { d: true } });
  });

  it("keeps comment-like text and escaped quotes inside strings", () => {
    const source = `{ "url": "https://x//y", "glob": "a/*b*/c", "q": "say \\"//hi\\"" }`;
    expect(JSON.parse(stripJsonc(source))).toEqual({
      url: "https://x//y",
      glob: "a/*b*/c",
      q: 'say "//hi"',
    });
  });

  it("drops an unterminated block comment to the end", () => {
    expect(stripJsonc('{"a": 1} /* open')).toBe('{"a": 1} ');
  });
});

describe("apps/web/wrangler.jsonc", () => {
  const config: WranglerConfig = JSON.parse(stripJsonc(repoFile("apps/web/wrangler.jsonc")));
  const deployed: Array<[string, WranglerEnv | undefined]> = [
    ["top level (dev)", config],
    ["production", config.env?.production],
  ];

  it.each(deployed)("%s exists and is not the e2e environment", (_, env) => {
    expect(env?.vars?.ENVIRONMENT).toBeDefined();
    expect(env?.vars?.ENVIRONMENT).not.toBe("e2e");
  });

  it.each(deployed)("%s never sets the GitHub endpoint overrides", (_, env) => {
    for (const key of E2E_ONLY_VARS) expect(env?.vars).not.toHaveProperty(key);
  });

  it("production uses https for BETTER_AUTH_URL", () => {
    expect(config.env?.production?.vars?.BETTER_AUTH_URL).toMatch(/^https:\/\//);
  });

  it("every environment declares the required auth secrets", () => {
    const all: Array<[string, WranglerEnv]> = [
      ["top level", config],
      ...Object.entries(config.env ?? {}),
    ];
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const [, env] of all) {
      expect(env.secrets?.required).toEqual(expect.arrayContaining(REQUIRED_SECRETS));
    }
  });

  it("only the e2e environment runs as e2e", () => {
    for (const [name, env] of Object.entries(config.env ?? {})) {
      expect(env.vars?.ENVIRONMENT === "e2e").toBe(name === "e2e");
    }
    expect(config.env?.e2e?.vars?.ENVIRONMENT).toBe("e2e");
  });

  it("e2e uses the same local database as the top level, where E2E applies migrations", () => {
    expect(config.env?.e2e?.d1_databases).toEqual(config.d1_databases);
  });
});

describe("apps/jobs/wrangler.jsonc", () => {
  const config: WranglerConfig = JSON.parse(stripJsonc(repoFile("apps/jobs/wrangler.jsonc")));

  it.each([
    ["top level (dev)", config],
    ["production", config.env?.production],
  ] as const)("%s is not e2e and never overrides the GitHub API", (_, env) => {
    expect(env?.vars?.ENVIRONMENT).toBeDefined();
    expect(env?.vars?.ENVIRONMENT).not.toBe("e2e");
    expect(env?.vars).not.toHaveProperty("GITHUB_API_BASE_URL");
  });

  it("only the e2e environment runs as e2e, on the top-level local database", () => {
    for (const [name, env] of Object.entries(config.env ?? {})) {
      expect(env.vars?.ENVIRONMENT === "e2e").toBe(name === "e2e");
    }
    expect(config.env?.e2e?.d1_databases).toEqual(config.d1_databases);
  });

  it("every environment sets the claim links' origin and sender; production uses https", () => {
    for (const env of [config, ...Object.values(config.env ?? {})]) {
      expect(env.vars?.PUBLIC_BASE_URL).toBeDefined();
      expect(env.vars?.MAIL_FROM).toBeDefined();
    }
    expect(config.env?.production?.vars?.PUBLIC_BASE_URL).toMatch(/^https:\/\//);
  });
});

describe(".github/workflows/ci.yml", () => {
  const workflow = repoFile(".github/workflows/ci.yml");

  it("never selects the e2e wrangler environment", () => {
    expect(workflow).not.toMatch(/--env[\s=]+["']?e2e\b/);
    expect(workflow).not.toMatch(/CLOUDFLARE_ENV\s*[:=]\s*["']?e2e\b/);
  });

  it("does build and deploy web (so the check above is meaningful)", () => {
    expect(workflow).toMatch(/@sharerepo\/web run deploy/);
  });
});
