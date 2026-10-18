import { env } from "cloudflare:workers";
import { normalizeWorkspaceSlug, parseWorkspaceName, parseWorkspaceSlug } from "@sharerepo/domain";
import { describe, expect, it } from "vitest";
import {
  insertMembershipRow,
  insertUserRow,
  insertWorkspaceRow,
  T0,
  uniqueId,
  uniqueSlug,
} from "./support/rows.ts";

async function seedWorkspaceAndUser() {
  const workspaceId = uniqueId("ws");
  const userId = uniqueId("usr");
  await insertWorkspaceRow({ id: workspaceId });
  await insertUserRow(userId);
  return { workspaceId, userId };
}

describe("users constraints", () => {
  it("accepts updated_at equal to created_at", async () => {
    await expect(insertUserRow(uniqueId("usr"), T0, T0)).resolves.toMatchObject({ success: true });
  });

  it("CHECK users_updated_after_created rejects updated_at before created_at", async () => {
    await expect(insertUserRow(uniqueId("usr"), T0, T0 - 1)).rejects.toThrow(
      /CHECK constraint failed: users_updated_after_created/,
    );
  });

  it("PRIMARY KEY rejects a duplicate user id", async () => {
    const id = uniqueId("usr");
    await insertUserRow(id);
    await expect(insertUserRow(id)).rejects.toThrow(/UNIQUE constraint failed: users.id/);
  });

  it("NOT NULL rejects a missing created_at", async () => {
    await expect(insertUserRow(uniqueId("usr"), null as unknown as number, T0)).rejects.toThrow(
      /NOT NULL constraint failed: users.created_at/,
    );
  });
});

describe("workspaces constraints", () => {
  // The CHECK must agree with the domain rule for every already-normalised slug.
  const slugCases = [
    "abc",
    "a-b",
    "123",
    "acme-co-2",
    "a".repeat(48),
    "ab",
    "a".repeat(49),
    "-abc",
    "abc-",
    "ab--cd",
    "ab_cd",
    "ab cd",
    "ab.cd",
    "abç",
    "ABC",
    "aBc",
    "ab[c",
    "ab*c",
    "ab?c",
    "ab^c",
    "---",
  ];

  it.each(slugCases)("CHECK workspaces_slug_format agrees with the domain for %j", async (slug) => {
    const domainAccepts =
      normalizeWorkspaceSlug(slug) === slug && parseWorkspaceSlug(slug).ok === true;
    const insert = insertWorkspaceRow({ slug });
    if (domainAccepts) {
      await expect(insert).resolves.toMatchObject({ success: true });
    } else {
      await expect(insert).rejects.toThrow(/CHECK constraint failed: workspaces_slug_format/);
    }
  });

  it("UNIQUE rejects a duplicate slug", async () => {
    const slug = uniqueSlug();
    await insertWorkspaceRow({ slug });
    await expect(insertWorkspaceRow({ slug })).rejects.toThrow(
      /UNIQUE constraint failed: workspaces.slug/,
    );
  });

  it("PRIMARY KEY rejects a duplicate workspace id", async () => {
    const id = uniqueId("ws");
    await insertWorkspaceRow({ id });
    await expect(insertWorkspaceRow({ id })).rejects.toThrow(
      /UNIQUE constraint failed: workspaces.id/,
    );
  });

  const nameCases = [
    "a",
    "Acme Co",
    "a".repeat(100),
    "🚀".repeat(100),
    "",
    "a".repeat(101),
    "🚀".repeat(101),
    " Acme",
    "Acme ",
    "\tAcme",
    "Acme\n",
    "Acme\r",
  ];

  it.each(nameCases)("CHECK workspaces_name_format agrees with the domain for %j", async (name) => {
    const parsed = parseWorkspaceName(name);
    const domainAccepts = parsed.ok && parsed.value === name;
    const insert = insertWorkspaceRow({ name });
    if (domainAccepts) {
      await expect(insert).resolves.toMatchObject({ success: true });
    } else {
      await expect(insert).rejects.toThrow(/CHECK constraint failed: workspaces_name_format/);
    }
  });

  it.each(["active", "suspended"])("CHECK workspaces_status_valid accepts %j", async (status) => {
    await expect(insertWorkspaceRow({ status })).resolves.toMatchObject({ success: true });
  });

  it.each(["", "Active", "deleted"])("CHECK workspaces_status_valid rejects %j", async (status) => {
    await expect(insertWorkspaceRow({ status })).rejects.toThrow(
      /CHECK constraint failed: workspaces_status_valid/,
    );
  });

  it("CHECK workspaces_updated_after_created rejects updated_at before created_at", async () => {
    await expect(insertWorkspaceRow({ created_at: T0, updated_at: T0 - 1 })).rejects.toThrow(
      /CHECK constraint failed: workspaces_updated_after_created/,
    );
  });
});

describe("workspace_memberships constraints", () => {
  it.each(["owner", "member"])(
    "CHECK workspace_memberships_role_valid accepts %j",
    async (role) => {
      const { workspaceId, userId } = await seedWorkspaceAndUser();
      await expect(insertMembershipRow(workspaceId, userId, role)).resolves.toMatchObject({
        success: true,
      });
    },
  );

  it.each(["", "admin", "Owner"])(
    "CHECK workspace_memberships_role_valid rejects %j",
    async (role) => {
      const { workspaceId, userId } = await seedWorkspaceAndUser();
      await expect(insertMembershipRow(workspaceId, userId, role)).rejects.toThrow(
        /CHECK constraint failed: workspace_memberships_role_valid/,
      );
    },
  );

  it("PRIMARY KEY rejects a duplicate membership", async () => {
    const { workspaceId, userId } = await seedWorkspaceAndUser();
    await insertMembershipRow(workspaceId, userId, "owner");
    await expect(insertMembershipRow(workspaceId, userId, "member")).rejects.toThrow(
      /UNIQUE constraint failed: workspace_memberships.workspace_id, workspace_memberships.user_id/,
    );
  });

  it("FOREIGN KEY rejects a membership for a missing workspace", async () => {
    const userId = uniqueId("usr");
    await insertUserRow(userId);
    await expect(insertMembershipRow(uniqueId("ws"), userId)).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it("FOREIGN KEY rejects a membership for a missing user", async () => {
    const workspaceId = uniqueId("ws");
    await insertWorkspaceRow({ id: workspaceId });
    await expect(insertMembershipRow(workspaceId, uniqueId("usr"))).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it("ON DELETE RESTRICT keeps a workspace that still has members", async () => {
    const { workspaceId, userId } = await seedWorkspaceAndUser();
    await insertMembershipRow(workspaceId, userId);
    await expect(
      env.DB.prepare("DELETE FROM workspaces WHERE id = ?").bind(workspaceId).run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("ON DELETE RESTRICT keeps a user who is still a member", async () => {
    const { workspaceId, userId } = await seedWorkspaceAndUser();
    await insertMembershipRow(workspaceId, userId);
    await expect(
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});
