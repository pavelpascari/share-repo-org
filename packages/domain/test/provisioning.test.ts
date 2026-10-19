import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  classifyMutationFailure,
  GRANT_STATES,
  type GrantFields,
  type GrantObservationChange,
  INVITATION_BUDGET,
  INVITATION_LIFETIME_MS,
  INVITATION_WINDOW_MS,
  invitationBudget,
  MUTATION_OPERATIONS,
  type MutationOperation,
  nextReconcileAt,
  OBSERVATION_GRACE_MS,
  type ObservableGrant,
  type ObservedCollaborator,
  type ObservedInvitation,
  observeGrants,
  type ProviderFailure,
  planReconciliation,
  RECONCILE_IDLE_MS,
  RECONCILE_POLL_MS,
  RETRY_CLASSES,
  type RepositoryObservation,
  retryBackoff,
} from "../src/index.ts";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LONG_AGO = NOW - HOUR;

const SUBJECTS = [{ id: "s1", externalSubjectId: "101" }];

const stored = (overrides: Partial<ObservableGrant> = {}): ObservableGrant => ({
  id: "g1",
  subjectId: "s1",
  accessLevel: "write",
  state: "absent",
  managed: false,
  indirect: false,
  externalGrantId: null,
  expiresAt: null,
  lastErrorCode: null,
  retryClass: null,
  nextAttemptAt: null,
  updatedAt: LONG_AGO,
  lastOperation: null,
  ...overrides,
});

const collaborator = (overrides: Partial<ObservedCollaborator> = {}): ObservedCollaborator => ({
  userId: "101",
  login: "octocat",
  accessLevel: "write",
  direct: true,
  ...overrides,
});

const invitation = (overrides: Partial<ObservedInvitation> = {}): ObservedInvitation => ({
  invitationId: "i1",
  userId: "101",
  login: "octocat",
  createdAt: LONG_AGO,
  expired: false,
  ...overrides,
});

const lapse = (createdAt: number) => createdAt + INVITATION_LIFETIME_MS;

interface Observe {
  readonly grants?: readonly ObservableGrant[];
  readonly collaborators?: readonly ObservedCollaborator[];
  readonly invitations?: readonly ObservedInvitation[];
  readonly subjects?: readonly { id: string; externalSubjectId: string }[];
  readonly now?: number;
}

function observe(input: Observe = {}): GrantObservationChange[] {
  let n = 0;
  return observeGrants({
    now: input.now ?? NOW,
    subjects: input.subjects ?? SUBJECTS,
    grants: input.grants ?? [],
    observation: {
      collaborators: input.collaborators ?? [],
      invitations: input.invitations ?? [],
    },
    newGrantId: () => `n${++n}`,
  });
}

const fieldsOf = (g: ObservableGrant): GrantFields => ({
  state: g.state,
  accessLevel: g.accessLevel,
  managed: g.managed,
  indirect: g.indirect,
  externalGrantId: g.externalGrantId,
  expiresAt: g.expiresAt,
  lastErrorCode: g.lastErrorCode,
  retryClass: g.retryClass,
  nextAttemptAt: g.nextAttemptAt,
});

const NO_ERROR = { lastErrorCode: null, retryClass: null, nextAttemptAt: null } as const;

/** The single stored grant's update for an observation, or null when nothing changes. */
function update(grant: ObservableGrant, listed: Omit<Observe, "grants"> = {}) {
  const changes = observe({ ...listed, grants: [grant] });
  if (changes.length === 0) return null;
  expect(changes).toHaveLength(1);
  const [change] = changes as [GrantObservationChange];
  if (change.kind !== "update") throw new Error("expected an update");
  expect(change.from).toEqual(fieldsOf(grant));
  expect(change.grantId).toBe(grant.id);
  // `set` only names what changes.
  for (const [key, value] of Object.entries(change.set)) {
    expect(value).not.toEqual(change.from[key as keyof GrantFields]);
  }
  return { fields: { ...change.from, ...change.set }, settlesIntent: change.settlesIntent };
}

const ACTIVE = { state: "active", externalGrantId: null, expiresAt: null, ...NO_ERROR } as const;
const ABSENT = {
  state: "absent",
  managed: false,
  indirect: false,
  externalGrantId: null,
  expiresAt: null,
  ...NO_ERROR,
} as const;
const PENDING = {
  state: "pending_invitation",
  indirect: false,
  externalGrantId: "i1",
  expiresAt: lapse(LONG_AGO),
  ...NO_ERROR,
} as const;

describe("observeGrants: a subject with no grant", () => {
  it("stores nothing when nothing is listed", () => {
    expect(observe()).toEqual([]);
  });

  it("records a listed collaborator as unmanaged, active access", () => {
    expect(observe({ collaborators: [collaborator({ accessLevel: "read" })] })).toEqual([
      {
        kind: "create",
        grantId: "n1",
        subjectId: "s1",
        set: {
          state: "active",
          accessLevel: "read",
          managed: false,
          indirect: false,
          externalGrantId: null,
          expiresAt: null,
          ...NO_ERROR,
        },
      },
    ]);
  });

  it("records a collaborator only the full list has as indirect", () => {
    expect(observe({ collaborators: [collaborator({ direct: false })] })).toEqual([
      expect.objectContaining({ set: expect.objectContaining({ indirect: true, managed: false }) }),
    ]);
  });

  it("records a listed invitation as an unmanaged pending invitation", () => {
    expect(observe({ invitations: [invitation()] })).toEqual([
      {
        kind: "create",
        grantId: "n1",
        subjectId: "s1",
        set: {
          state: "pending_invitation",
          accessLevel: "write",
          managed: false,
          indirect: false,
          externalGrantId: "i1",
          expiresAt: lapse(LONG_AGO),
          ...NO_ERROR,
        },
      },
    ]);
  });

  it("records an invitation the provider calls expired as lapsed by now at the latest", () => {
    const expiresAt = (createdAt: number) =>
      observe({ invitations: [invitation({ createdAt, expired: true })] })[0]?.set.expiresAt;
    expect(expiresAt(LONG_AGO)).toBe(NOW);
    const old = NOW - INVITATION_LIFETIME_MS - HOUR;
    expect(expiresAt(old)).toBe(lapse(old));
  });

  it("prefers a listed collaborator over an invitation for the same person", () => {
    expect(observe({ collaborators: [collaborator()], invitations: [invitation()] })).toEqual([
      expect.objectContaining({ set: expect.objectContaining({ state: "active" }) }),
    ]);
  });

  it("matches people by immutable user ID, never by login", () => {
    expect(observe({ collaborators: [collaborator({ userId: "202" })] })).toEqual([]);
    expect(observe({ invitations: [invitation({ userId: "202" })] })).toEqual([]);
    expect(
      observe({ collaborators: [collaborator({ login: "someone-else" })] }).map((c) => c.subjectId),
    ).toEqual(["s1"]);
  });

  it("stores grants only for the given subjects, sorted by subject, with fresh IDs", () => {
    const changes = observe({
      subjects: [
        { id: "s3", externalSubjectId: "303" },
        { id: "s2", externalSubjectId: "202" },
        { id: "s1", externalSubjectId: "101" },
      ],
      collaborators: [
        collaborator({ userId: "303" }),
        collaborator({ userId: "999" }),
        collaborator({ userId: "202" }),
      ],
    });
    expect(changes.map((c) => [c.subjectId, c.grantId])).toEqual([
      ["s2", "n1"],
      ["s3", "n2"],
    ]);
  });
});

describe("observeGrants: what is listed for a person", () => {
  const created = (listed: Omit<Observe, "grants">, grants: ObservableGrant[] = []) =>
    observe({ ...listed, grants })[0]?.set as Partial<GrantFields>;

  it("prefers direct access, then the higher level", () => {
    const level = (...collaborators: ObservedCollaborator[]) => {
      const set = created({ collaborators });
      return `${set.accessLevel}/${set.indirect ? "indirect" : "direct"}`;
    };
    expect(level(collaborator({ accessLevel: "read" }), collaborator({ direct: false }))).toBe(
      "read/direct",
    );
    expect(level(collaborator({ direct: false }), collaborator({ accessLevel: "read" }))).toBe(
      "read/direct",
    );
    expect(level(collaborator({ accessLevel: "read" }), collaborator())).toBe("write/direct");
    expect(level(collaborator(), collaborator({ accessLevel: "read" }))).toBe("write/direct");
    expect(
      level(
        collaborator({ accessLevel: "read", direct: false }),
        collaborator({ accessLevel: "write", direct: false }),
      ),
    ).toBe("write/indirect");
    expect(level(collaborator({ accessLevel: "read", direct: false }))).toBe("read/indirect");
  });

  it("prefers the grant's own invitation, then a live one, the newest, the lowest ID", () => {
    const chosen = (invitations: ObservedInvitation[], grants: ObservableGrant[] = []) =>
      created({ invitations }, grants)?.externalGrantId ??
      (observe({ invitations, grants }).length === 0 ? "unchanged" : "none");
    const pending = stored({ state: "pending_invitation", externalGrantId: "i3", expiresAt: NOW });
    expect(
      chosen(
        [invitation({ invitationId: "i2" }), invitation({ invitationId: "i3", expired: true })],
        [pending],
      ),
    ).toBe("unchanged");
    expect(
      chosen([
        invitation({ invitationId: "i1", expired: true, createdAt: NOW - 1 }),
        invitation({ invitationId: "i2", createdAt: LONG_AGO }),
      ]),
    ).toBe("i2");
    expect(
      chosen([
        invitation({ invitationId: "i2", createdAt: LONG_AGO }),
        invitation({ invitationId: "i1", expired: true, createdAt: NOW - 1 }),
      ]),
    ).toBe("i2");
    expect(
      chosen([
        invitation({ invitationId: "i1", createdAt: LONG_AGO }),
        invitation({ invitationId: "i2", createdAt: LONG_AGO + 1 }),
      ]),
    ).toBe("i2");
    expect(
      chosen([
        invitation({ invitationId: "i2", createdAt: LONG_AGO + 1 }),
        invitation({ invitationId: "i1", createdAt: LONG_AGO }),
      ]),
    ).toBe("i2");
    expect(chosen([invitation({ invitationId: "i2" }), invitation({ invitationId: "i1" })])).toBe(
      "i1",
    );
    expect(chosen([invitation({ invitationId: "i1" }), invitation({ invitationId: "i2" })])).toBe(
      "i1",
    );
  });

  it("keeps the lapse instant stored for an expired invitation, so it does not move", () => {
    const earlier = NOW - 10 * MINUTE;
    const grant = stored({
      state: "pending_invitation",
      externalGrantId: "i1",
      expiresAt: earlier,
    });
    expect(update(grant, { invitations: [invitation({ expired: true })] })).toBeNull();
    // A stored instant not yet passed is brought forward to now.
    const later = stored({ ...grant, expiresAt: NOW + MINUTE });
    expect(update(later, { invitations: [invitation({ expired: true })] })?.fields.expiresAt).toBe(
      NOW,
    );
    // Another invitation's instant is not reused.
    const other = stored({ ...grant, externalGrantId: "i0" });
    expect(update(other, { invitations: [invitation({ expired: true })] })?.fields.expiresAt).toBe(
      NOW,
    );
    // Without a stored instant, now.
    const none = stored({ ...grant, expiresAt: null });
    expect(update(none, { invitations: [invitation({ expired: true })] })?.fields.expiresAt).toBe(
      NOW,
    );
  });

  it("keeps the preferred grant's level when another of the subject's grants holds the listed one", () => {
    const grants = [stored({ id: "g1", accessLevel: "read" }), stored({ id: "g2" })];
    expect(observe({ grants, collaborators: [collaborator({ accessLevel: "read" })] })).toEqual([
      expect.objectContaining({
        grantId: "g2",
        set: expect.not.objectContaining({ accessLevel: "read" }),
      }),
    ]);
    const settled = [grants[0] as ObservableGrant, stored({ id: "g2", ...ACTIVE })];
    expect(
      observe({ grants: settled, collaborators: [collaborator({ accessLevel: "read" })] }),
    ).toEqual([]);
    // Without a sibling at that level, the level follows the listing.
    expect(
      observe({
        grants: [stored({ id: "g2", ...ACTIVE })],
        collaborators: [collaborator({ accessLevel: "read" })],
      }),
    ).toEqual([expect.objectContaining({ set: { accessLevel: "read" } })]);
  });

  it("updates only the preferred grant when a subject has several", () => {
    const grants = [
      stored({ id: "g3", accessLevel: "read" }),
      stored({ id: "g2" }),
      stored({ id: "g1", accessLevel: "read" }),
      stored({ id: "g4" }),
    ];
    expect(observe({ grants, collaborators: [collaborator()] }).map((c) => c.grantId)).toEqual([
      "g2",
    ]);
  });
});

describe("observeGrants: unknown and absent grants", () => {
  it("records nothing listed as absent", () => {
    expect(update(stored({ state: "unknown", managed: true }))).toEqual({
      fields: { ...fieldsOf(stored()), ...ABSENT },
      settlesIntent: false,
    });
    expect(update(stored({ state: "absent" }))).toBeNull();
  });

  it.each(["unknown", "absent"] as const)(
    "records access found on a %s grant as unmanaged",
    (state) => {
      const grant = stored({ state, managed: true });
      expect(update(grant, { collaborators: [collaborator({ accessLevel: "read" })] })).toEqual({
        fields: { ...fieldsOf(grant), ...ACTIVE, accessLevel: "read", managed: false },
        settlesIntent: false,
      });
      expect(update(grant, { invitations: [invitation()] })).toEqual({
        fields: { ...fieldsOf(grant), ...PENDING, managed: false },
        settlesIntent: false,
      });
    },
  );
});

describe("observeGrants: provisioning (ShareRepo's intent)", () => {
  const provisioning = stored({ state: "provisioning", managed: true, lastOperation: "invite" });

  it("makes the access it finds managed and settles the intent", () => {
    expect(update(provisioning, { collaborators: [collaborator({ direct: false })] })).toEqual({
      fields: { ...fieldsOf(provisioning), ...ACTIVE, managed: true, indirect: true },
      settlesIntent: true,
    });
    expect(update(provisioning, { invitations: [invitation()] })).toEqual({
      fields: { ...fieldsOf(provisioning), ...PENDING, managed: true },
      settlesIntent: true,
    });
  });

  it("waits out the grace window before deciding the invitation never landed", () => {
    const at = (updatedAt: number) => update(stored({ ...provisioning, updatedAt }));
    expect(at(NOW)).toBeNull();
    expect(at(NOW - OBSERVATION_GRACE_MS + 1)).toBeNull();
    expect(at(NOW - OBSERVATION_GRACE_MS)).toEqual({
      fields: { ...fieldsOf(provisioning), ...ABSENT },
      settlesIntent: true,
    });
  });

  it("settles at once when the access is listed within the grace window", () => {
    const fresh = stored({ ...provisioning, updatedAt: NOW });
    expect(update(fresh, { invitations: [invitation()] })?.settlesIntent).toBe(true);
  });
});

describe("invitation/pending-is-not-active", () => {
  const pending = stored({ ...PENDING, managed: true });

  it("keeps a listed invitation pending, never active", () => {
    expect(update(pending, { invitations: [invitation()] })).toBeNull();
    expect(observe({ invitations: [invitation()] })[0]?.set).toEqual(
      expect.objectContaining({ state: "pending_invitation" }),
    );
  });

  it("makes the grant active only once the collaborator is listed, keeping ownership", () => {
    for (const managed of [true, false]) {
      const grant = stored({ ...pending, managed });
      expect(update(grant, { collaborators: [collaborator()] })).toEqual({
        fields: { ...fieldsOf(grant), ...ACTIVE },
        settlesIntent: false,
      });
    }
  });

  it("makes a fresh invitation accepted at once active, grace window or not", () => {
    const fresh = stored({ ...pending, expiresAt: lapse(NOW) });
    expect(update(fresh, { collaborators: [collaborator()] })?.fields.state).toBe("active");
    expect(update(fresh, { invitations: [invitation({ createdAt: NOW })] })).toBeNull();
  });

  it("plans to wait for a pending invitation, not to verify it", () => {
    const [decision] = planReconciliation({
      now: NOW,
      entitlements: [
        { id: "e1", subjectId: "s1", resourceId: "r1", accessLevel: "write", validUntil: null },
      ],
      grants: [
        {
          ...stored({ ...pending }),
          resourceId: "r1",
          connectionId: "c1",
        },
      ],
      resources: [],
      connections: [],
    });
    expect(decision).toEqual(
      expect.objectContaining({ action: "wait", reason: "invitation_pending" }),
    );
  });
});

describe("observeGrants: pending invitations", () => {
  const pending = stored({ ...PENDING, managed: true });

  it("refreshes the invitation and keeps ownership only of its own invitation", () => {
    const listed = { invitations: [invitation({ invitationId: "i2", createdAt: NOW - MINUTE })] };
    const refreshed = { externalGrantId: "i2", expiresAt: lapse(NOW - MINUTE) };
    expect(update(pending, listed)).toEqual({
      fields: { ...fieldsOf(pending), ...refreshed, managed: false },
      settlesIntent: false,
    });
    // A managed grant that has not recorded its invitation yet takes the first one listed.
    const unrecorded = stored({ ...pending, externalGrantId: null });
    expect(update(unrecorded, listed)).toEqual({
      fields: { ...fieldsOf(unrecorded), ...refreshed, managed: true },
      settlesIntent: false,
    });
    // An unmanaged grant never becomes managed.
    for (const externalGrantId of ["i2", null]) {
      const unmanaged = stored({ ...pending, managed: false, externalGrantId });
      expect(update(unmanaged, listed)?.fields.managed ?? false).toBe(false);
    }
    // Its own invitation, with a new lapse instant.
    const own = { invitations: [invitation({ createdAt: NOW - MINUTE })] };
    expect(update(pending, own)).toEqual({
      fields: { ...fieldsOf(pending), expiresAt: lapse(NOW - MINUTE) },
      settlesIntent: false,
    });
  });

  it("records an invitation no longer listed as absent and no longer managed", () => {
    expect(update(pending)).toEqual({
      fields: { ...fieldsOf(pending), ...ABSENT },
      settlesIntent: false,
    });
  });

  it("waits out the grace window for ShareRepo's own fresh invitation", () => {
    const sent = (createdAt: number, managed = true) =>
      update(stored({ ...pending, managed, expiresAt: lapse(createdAt) }));
    expect(sent(NOW)).toBeNull();
    expect(sent(NOW - OBSERVATION_GRACE_MS + 1)).toBeNull();
    expect(sent(NOW - OBSERVATION_GRACE_MS)?.fields.state).toBe("absent");
    expect(sent(NOW, false)?.fields.state).toBe("absent");
    expect(update(stored({ ...pending, expiresAt: null }))?.fields.state).toBe("absent");
  });
});

describe("observeGrants: active grants", () => {
  const active = stored({ ...ACTIVE, managed: true });

  it("changes nothing while the collaborator is listed as stored", () => {
    expect(update(active, { collaborators: [collaborator()] })).toBeNull();
  });

  it("follows the listed level and indirectness, keeping ownership", () => {
    expect(update(active, { collaborators: [collaborator({ accessLevel: "read" })] })).toEqual({
      fields: { ...fieldsOf(active), accessLevel: "read" },
      settlesIntent: false,
    });
    const unmanaged = stored({ ...active, managed: false });
    expect(update(unmanaged, { collaborators: [collaborator({ direct: false })] })).toEqual({
      fields: { ...fieldsOf(unmanaged), indirect: true },
      settlesIntent: false,
    });
  });

  it("records a collaborator removed by hand as absent and no longer managed (drift)", () => {
    expect(update(active)).toEqual({
      fields: { ...fieldsOf(active), ...ABSENT },
      settlesIntent: false,
    });
  });

  it("records an invitation instead as pending, managed only if it is the grant's own", () => {
    const listed = { invitations: [invitation()] };
    expect(update(active, listed)?.fields).toEqual({
      ...fieldsOf(active),
      ...PENDING,
      managed: false,
    });
    const own = stored({ ...active, externalGrantId: "i1" });
    expect(update(own, listed)?.fields).toEqual({ ...fieldsOf(own), ...PENDING, managed: true });
    const unmanaged = stored({ ...own, managed: false });
    expect(update(unmanaged, listed)?.fields.managed).toBe(false);
  });
});

describe("observeGrants: revoking (ShareRepo's intent)", () => {
  const revoking = stored({
    state: "revoking",
    managed: true,
    lastOperation: "remove_collaborator",
  });

  it("records the access gone as absent and settles the intent, at once", () => {
    for (const updatedAt of [NOW, LONG_AGO]) {
      expect(update(stored({ ...revoking, updatedAt }))).toEqual({
        fields: { ...fieldsOf(revoking), ...ABSENT },
        settlesIntent: true,
      });
    }
  });

  it("restores access still listed after the grace window, keeping ownership", () => {
    expect(update(revoking, { collaborators: [collaborator()] })).toEqual({
      fields: { ...fieldsOf(revoking), ...ACTIVE },
      settlesIntent: true,
    });
    const unmanaged = stored({ ...revoking, managed: false });
    expect(update(unmanaged, { invitations: [invitation()] })).toEqual({
      fields: { ...fieldsOf(unmanaged), ...PENDING },
      settlesIntent: true,
    });
  });

  it("leaves access still listed within the grace window alone", () => {
    const at = (updatedAt: number) =>
      update(stored({ ...revoking, updatedAt }), { collaborators: [collaborator()] });
    expect(at(NOW)).toBeNull();
    expect(at(NOW - OBSERVATION_GRACE_MS + 1)).toBeNull();
    expect(at(NOW - OBSERVATION_GRACE_MS)?.fields.state).toBe("active");
  });
});

describe("observeGrants: errors", () => {
  const ERROR = {
    state: "error",
    lastErrorCode: "provider_unavailable",
    retryClass: "retryable",
    nextAttemptAt: NOW + MINUTE,
  } as const;
  const failed = (
    lastOperation: MutationOperation | null,
    overrides: Partial<ObservableGrant> = {},
  ) => stored({ ...ERROR, managed: true, lastOperation, ...overrides });

  it("settles a failed invitation that landed after all as managed access", () => {
    const grant = failed("invite");
    expect(update(grant, { collaborators: [collaborator()] })).toEqual({
      fields: { ...fieldsOf(grant), ...ACTIVE, managed: true },
      settlesIntent: true,
    });
    expect(update(grant, { invitations: [invitation()] })).toEqual({
      fields: { ...fieldsOf(grant), ...PENDING, managed: true },
      settlesIntent: true,
    });
  });

  it("keeps a failed invitation's error while nothing is listed", () => {
    expect(update(failed("invite"))).toBeNull();
    expect(update(failed(null))).toBeNull();
  });

  it.each(["remove_collaborator", "cancel_invitation"] as const)(
    "settles a failed %s once the access is gone",
    (operation) => {
      const grant = failed(operation, { ...PENDING, ...ERROR });
      expect(update(grant)).toEqual({
        fields: { ...fieldsOf(grant), ...ABSENT },
        settlesIntent: true,
      });
    },
  );

  it.each(["remove_collaborator", "cancel_invitation"] as const)(
    "keeps a failed %s's error while the access is listed, refreshing its details",
    (operation) => {
      const grant = failed(operation, { ...PENDING, ...ERROR });
      expect(update(grant, { invitations: [invitation()] })).toBeNull();
      expect(
        update(grant, { collaborators: [collaborator({ accessLevel: "read", direct: false })] }),
      ).toEqual({
        fields: {
          ...fieldsOf(grant),
          accessLevel: "read",
          indirect: true,
          externalGrantId: null,
          expiresAt: null,
        },
        settlesIntent: false,
      });
      const later = invitation({ invitationId: "i2", createdAt: NOW - MINUTE });
      expect(update(grant, { invitations: [later] })).toEqual({
        fields: {
          ...fieldsOf(grant),
          externalGrantId: "i2",
          expiresAt: lapse(NOW - MINUTE),
          managed: false,
        },
        settlesIntent: false,
      });
    },
  );

  it("treats an error with no known mutation like unknown, never as managed", () => {
    const grant = failed(null);
    expect(update(grant, { collaborators: [collaborator()] })).toEqual({
      fields: { ...fieldsOf(grant), ...ACTIVE, managed: false },
      settlesIntent: false,
    });
    expect(update(grant, { invitations: [invitation()] })).toEqual({
      fields: { ...fieldsOf(grant), ...PENDING, managed: false },
      settlesIntent: false,
    });
  });
});

// Property tests over any stored grant and any listing.

const USERS = ["101", "202", "303"] as const;
const PROPERTY_SUBJECTS = [
  { id: "s1", externalSubjectId: "101" },
  { id: "s2", externalSubjectId: "202" },
];
const instantArb = fc.integer({ min: NOW - 2 * OBSERVATION_GRACE_MS, max: NOW });

const grantArb: fc.Arbitrary<ObservableGrant> = fc
  .record({
    subjectId: fc.constantFrom("s1", "s2"),
    accessLevel: fc.constantFrom("read" as const, "write" as const),
    state: fc.constantFrom(...GRANT_STATES),
    managed: fc.boolean(),
    indirect: fc.boolean(),
    externalGrantId: fc.option(fc.constantFrom("i1", "i2")),
    expiresAt: fc.option(fc.integer({ min: NOW - 1, max: lapse(NOW) })),
    retryClass: fc.constantFrom(...RETRY_CLASSES),
    nextAttemptAt: fc.option(instantArb),
    updatedAt: instantArb,
    lastOperation: fc.option(fc.constantFrom(...MUTATION_OPERATIONS)),
  })
  .map((g) => ({
    ...g,
    id: "",
    // The grants CHECK: an error, and only an error, is classified.
    lastErrorCode: g.state === "error" ? "provider_unavailable" : null,
    retryClass: g.state === "error" ? g.retryClass : null,
    nextAttemptAt: g.state === "error" ? g.nextAttemptAt : null,
  }));

const observationArb: fc.Arbitrary<RepositoryObservation> = fc.record({
  collaborators: fc.array(
    fc.record({
      userId: fc.constantFrom(...USERS),
      login: fc.constant("someone"),
      accessLevel: fc.constantFrom("read" as const, "write" as const),
      direct: fc.boolean(),
    }),
    { maxLength: 3 },
  ),
  // The provider lists each invitation once.
  invitations: fc.uniqueArray(
    fc.record({
      invitationId: fc.constantFrom("i1", "i2", "i3"),
      userId: fc.constantFrom(...USERS),
      login: fc.constant("someone"),
      createdAt: fc.integer({ min: NOW - INVITATION_LIFETIME_MS - 1, max: NOW }),
      expired: fc.boolean(),
    }),
    { maxLength: 3, selector: (i) => i.invitationId },
  ),
});

const scenarioArb = fc.record({
  grants: fc
    // The grants unique key: one grant per subject and level.
    .uniqueArray(grantArb, { maxLength: 4, selector: (g) => `${g.subjectId}/${g.accessLevel}` })
    .map((grants) => grants.map((g, i) => ({ ...g, id: `g${i}` }))),
  observation: observationArb,
});

function run(grants: readonly ObservableGrant[], observation: RepositoryObservation) {
  let n = 0;
  return observeGrants({
    now: NOW,
    subjects: PROPERTY_SUBJECTS,
    grants,
    observation,
    newGrantId: () => `new${++n}`,
  });
}

/** The grants after the changes, as the caller would store them. */
function applied(
  grants: readonly ObservableGrant[],
  changes: readonly GrantObservationChange[],
): ObservableGrant[] {
  const byId = new Map(grants.map((g) => [g.id, g]));
  for (const change of changes) {
    const base =
      byId.get(change.grantId) ?? stored({ id: change.grantId, subjectId: change.subjectId });
    byId.set(change.grantId, { ...base, ...change.set, updatedAt: NOW });
  }
  return [...byId.values()];
}

const PROPERTY_TIMEOUT = 60_000;

describe("observeGrants properties", () => {
  it(
    "never makes access managed without ShareRepo's intent",
    () => {
      fc.assert(
        fc.property(scenarioArb, ({ grants, observation }) => {
          const byId = new Map(grants.map((g) => [g.id, g]));
          for (const change of run(grants, observation)) {
            if (change.kind === "create") {
              expect(change.set.managed).toBe(false);
              continue;
            }
            if (change.set.managed !== true) continue;
            const before = byId.get(change.grantId) as ObservableGrant;
            const intended =
              before.managed ||
              before.state === "provisioning" ||
              (before.state === "error" && before.lastOperation === "invite");
            expect(intended).toBe(true);
          }
        }),
      );
    },
    PROPERTY_TIMEOUT,
  );

  it(
    "is idempotent: observing the same lists again changes nothing",
    () => {
      fc.assert(
        fc.property(scenarioArb, ({ grants, observation }) => {
          const after = applied(grants, run(grants, observation));
          expect(run(after, observation)).toEqual([]);
        }),
      );
    },
    PROPERTY_TIMEOUT,
  );

  it(
    "keeps every grant classified as an error exactly when it is one",
    () => {
      fc.assert(
        fc.property(scenarioArb, ({ grants, observation }) => {
          for (const g of applied(grants, run(grants, observation))) {
            expect(g.lastErrorCode !== null).toBe(g.state === "error");
            expect(g.retryClass !== null).toBe(g.state === "error");
            if (g.state !== "error") expect(g.nextAttemptAt).toBeNull();
          }
        }),
      );
    },
    PROPERTY_TIMEOUT,
  );

  it(
    "prefers a listed collaborator over an invitation, and an invitation is never active",
    () => {
      fc.assert(
        fc.property(scenarioArb, ({ grants, observation }) => {
          for (const change of run(grants, observation)) {
            const subject = PROPERTY_SUBJECTS.find((s) => s.id === change.subjectId);
            const userId = subject?.externalSubjectId;
            const listed = observation.collaborators.some((c) => c.userId === userId);
            const invited = observation.invitations.some((i) => i.userId === userId);
            if (listed) expect(change.set.state).not.toBe("pending_invitation");
            if (!listed && invited) expect(change.set.state).not.toBe("active");
            if (!listed && !invited) expect(change.set.managed ?? false).toBe(false);
          }
        }),
      );
    },
    PROPERTY_TIMEOUT,
  );

  it(
    "only stores grants for the given subjects, one change per subject",
    () => {
      fc.assert(
        fc.property(scenarioArb, ({ grants, observation }) => {
          const subjects = run(grants, observation).map((c) => c.subjectId);
          expect(subjects).toEqual([...new Set(subjects)].sort());
          for (const s of subjects) expect(["s1", "s2"]).toContain(s);
        }),
      );
    },
    PROPERTY_TIMEOUT,
  );
});

describe("classifyMutationFailure", () => {
  const classify = (operation: MutationOperation, failure: ProviderFailure, attempt = 1) =>
    classifyMutationFailure({ operation, failure, attempt, now: NOW });

  it.each(["transient", "malformed_response"] as const)(
    "retries a %s failure with backoff by attempt",
    (kind) => {
      for (const operation of MUTATION_OPERATIONS) {
        expect(classify(operation, { kind, status: 502 }, 2)).toEqual({
          outcome: "failed",
          errorCode: "provider_unavailable",
          retryClass: "retryable",
          nextAttemptAt: NOW + 5 * MINUTE,
          stopRun: false,
        });
      }
    },
  );

  it("backs off 1, 5, 15 and 60 minutes, then stays at 60", () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(retryBackoff)).toEqual(
      [1, 1, 5, 15, 60, 60, 60].map((m) => m * MINUTE),
    );
  });

  it("honours the provider's retry-after for a rate limit, at least a minute, and stops", () => {
    const limited = (retryAfterMs?: number) =>
      classify(
        "invite",
        retryAfterMs === undefined
          ? { kind: "rate_limited" }
          : { kind: "rate_limited", retryAfterMs },
      );
    expect(limited(5 * MINUTE)).toEqual({
      outcome: "failed",
      errorCode: "rate_limited",
      retryClass: "rate_limited",
      nextAttemptAt: NOW + 5 * MINUTE,
      stopRun: true,
    });
    expect(limited(MINUTE + 1)).toEqual(
      expect.objectContaining({ nextAttemptAt: NOW + MINUTE + 1 }),
    );
    expect(limited(1_000)).toEqual(expect.objectContaining({ nextAttemptAt: NOW + MINUTE }));
    expect(limited()).toEqual(expect.objectContaining({ nextAttemptAt: NOW + MINUTE }));
  });

  it.each([
    ["invite", 422, "invitation_rejected", "user_action_required"],
    ["invite", 403, "app_permission_missing", "user_action_required"],
    ["remove_collaborator", 403, "app_permission_missing", "user_action_required"],
    ["cancel_invitation", 403, "app_permission_missing", "user_action_required"],
    ["remove_collaborator", 422, "provider_rejected", "terminal"],
    ["cancel_invitation", 422, "provider_rejected", "terminal"],
    ["invite", 400, "provider_rejected", "terminal"],
    ["invite", undefined, "provider_rejected", "terminal"],
  ] as const)(
    "classifies %s rejected with %s as %s",
    (operation, status, errorCode, retryClass) => {
      const failure: ProviderFailure =
        status === undefined ? { kind: "rejected" } : { kind: "rejected", status };
      expect(classify(operation, failure)).toEqual({
        outcome: "failed",
        errorCode,
        retryClass,
        nextAttemptAt: null,
        stopRun: false,
      });
    },
  );

  it("asks a person to act when the invitee's account is gone", () => {
    for (const failure of [
      { kind: "not_found", target: "account" },
      { kind: "not_found" },
    ] as const) {
      expect(classify("invite", failure)).toEqual({
        outcome: "failed",
        errorCode: "account_not_found",
        retryClass: "user_action_required",
        nextAttemptAt: null,
        stopRun: false,
      });
    }
  });

  it.each(["remove_collaborator", "cancel_invitation"] as const)(
    "counts %s of something already gone as done",
    (operation) => {
      expect(classify(operation, { kind: "not_found", target: "account" })).toEqual({
        outcome: "already_done",
      });
      expect(classify(operation, { kind: "not_found", status: 404 })).toEqual({
        outcome: "already_done",
      });
    },
  );

  it.each(MUTATION_OPERATIONS)("stops the run for a missing repository on %s", (operation) => {
    expect(classify(operation, { kind: "not_found", target: "repository" })).toEqual({
      outcome: "stop_run",
      reason: "repository_not_found",
    });
  });

  it.each(MUTATION_OPERATIONS)("stops the run for a suspended installation on %s", (operation) => {
    expect(classify(operation, { kind: "suspended", status: 403 })).toEqual({
      outcome: "stop_run",
      reason: "suspended",
    });
  });
});

describe("invitationBudget", () => {
  const starts = (count: number, at: (i: number) => number) =>
    Array.from({ length: count }, (_, i) => at(i));

  it("allows the full budget when nothing was sent", () => {
    expect(invitationBudget([], NOW)).toEqual({ remaining: INVITATION_BUDGET, opensAt: null });
  });

  it("counts starts within the rolling window only", () => {
    expect(
      invitationBudget(
        [NOW - INVITATION_WINDOW_MS, NOW - INVITATION_WINDOW_MS + 1, NOW, NOW + 1],
        NOW,
      ),
    ).toEqual({ remaining: INVITATION_BUDGET - 2, opensAt: null });
  });

  it("reports when a spent budget opens again", () => {
    const full = starts(INVITATION_BUDGET, (i) => NOW - 1000 + i).reverse();
    expect(invitationBudget(full, NOW)).toEqual({
      remaining: 0,
      opensAt: NOW - 1000 + INVITATION_WINDOW_MS,
    });
    expect(invitationBudget(full.slice(1), NOW)).toEqual({ remaining: 1, opensAt: null });
  });

  it("waits for enough starts to leave the window when over budget", () => {
    const over = starts(INVITATION_BUDGET + 2, (i) => NOW - 1000 + i);
    expect(invitationBudget(over, NOW)).toEqual({
      remaining: 0,
      opensAt: NOW - 1000 + 2 + INVITATION_WINDOW_MS,
    });
  });

  it("opens exactly when the oldest start leaves the window", () => {
    const full = starts(INVITATION_BUDGET, (i) => NOW + i * 10);
    const { opensAt } = invitationBudget(full, NOW + 1000);
    expect(invitationBudget(full, (opensAt as number) - 1).remaining).toBe(0);
    expect(invitationBudget(full, opensAt as number).remaining).toBe(1);
  });
});

describe("nextReconcileAt", () => {
  type Grant = Parameters<typeof nextReconcileAt>[0]["grants"][number];
  const g = (overrides: Partial<Grant> = {}): Grant => ({
    state: "active",
    nextAttemptAt: null,
    expiresAt: null,
    retryClass: null,
    ...overrides,
  });
  const next = (
    grants: Grant[],
    budget: { remaining: number; opensAt: number | null } | null = null,
  ) => nextReconcileAt({ now: NOW, grants, budget, leftover: false });

  it("runs again at once when decisions were left over", () => {
    expect(
      nextReconcileAt({
        now: NOW,
        grants: [g({ state: "provisioning" })],
        budget: null,
        leftover: true,
      }),
    ).toBe(NOW);
  });

  it("waits the idle interval when nothing is in flight", () => {
    expect(next([])).toBe(NOW + RECONCILE_IDLE_MS);
    expect(next([g(), g({ state: "absent" }), g({ state: "unknown" })])).toBe(
      NOW + RECONCILE_IDLE_MS,
    );
    expect(next([g({ state: "error", retryClass: "user_action_required" })])).toBe(
      NOW + RECONCILE_IDLE_MS,
    );
    expect(next([g({ state: "error", retryClass: "terminal" })])).toBe(NOW + RECONCILE_IDLE_MS);
  });

  it.each(["pending_invitation", "provisioning", "revoking"] as const)(
    "polls soon while a grant is %s",
    (state) => {
      expect(next([g(), g({ state })])).toBe(NOW + RECONCILE_POLL_MS);
    },
  );

  it.each(["retryable", "rate_limited"] as const)("polls soon after a %s error", (retryClass) => {
    expect(next([g({ state: "error", retryClass })])).toBe(NOW + RECONCILE_POLL_MS);
    // Only an errored grant's retry class counts.
    expect(next([g({ retryClass })])).toBe(NOW + RECONCILE_IDLE_MS);
  });

  it("runs at an error's retry time when that is sooner", () => {
    expect(
      next([g({ state: "error", retryClass: "retryable", nextAttemptAt: NOW + MINUTE })]),
    ).toBe(NOW + MINUTE);
    expect(next([g({ state: "error", retryClass: "terminal", nextAttemptAt: NOW + HOUR })])).toBe(
      NOW + HOUR,
    );
    expect(next([g({ nextAttemptAt: NOW + MINUTE })])).toBe(NOW + RECONCILE_IDLE_MS);
  });

  it("runs when a pending invitation lapses, if that is still ahead", () => {
    const pending = (expiresAt: number | null) =>
      next([g({ state: "pending_invitation", expiresAt })]);
    expect(pending(NOW + MINUTE)).toBe(NOW + MINUTE);
    expect(pending(NOW)).toBe(NOW + RECONCILE_POLL_MS);
    expect(pending(null)).toBe(NOW + RECONCILE_POLL_MS);
    expect(next([g({ expiresAt: NOW + MINUTE })])).toBe(NOW + RECONCILE_IDLE_MS);
  });

  it("runs when a spent invitation budget opens", () => {
    expect(next([], { remaining: 0, opensAt: NOW + HOUR })).toBe(NOW + HOUR);
    expect(next([], { remaining: 3, opensAt: null })).toBe(NOW + RECONCILE_IDLE_MS);
  });

  it("is never earlier than now", () => {
    expect(next([g({ state: "error", retryClass: "retryable", nextAttemptAt: NOW - HOUR })])).toBe(
      NOW,
    );
    expect(next([], { remaining: 0, opensAt: NOW - 1 })).toBe(NOW);
  });
});
