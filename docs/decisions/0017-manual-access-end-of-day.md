# 0017 — A manual access ends after its date everywhere on Earth

**Status:** Accepted (product decision, 2026-10-26)

## Context

[Decision 0016](0016-manual-access-source.md) lets an owner give manual access an optional end date. The first version ended access at 00:00 UTC on the chosen date. The product owner asked for: "let's pick end of day at the recipients timezone".

ShareRepo cannot know a recipient's time zone. Many recipients have no ShareRepo account, and GitHub does not expose one.

## Decision

- An owner chooses a **date**. Access ends at the **end of that date anywhere on Earth** (AoE, UTC−12), which is **12:00 UTC on the next day**. No recipient, in any time zone, loses access before their own day is over.
- The stored `manual_accesses.ends_at` stays a UTC instant. `parseManualAccessEndDate` turns `YYYY-MM-DD` into it, and `manualAccessEndDate` turns it back for the edit form. Both are domain functions with literal tests.
- The page says "Access ends after <date>" and explains the rule to the creator.
- The recipient's **My access** page shows the instant the same way it shows a purchase's scheduled cancellation.
- **Stored rows:** nothing has shipped, so no row holds a 00:00 UTC end and no migration is needed. A row written before this decision would read as ending one and a half days earlier than the new rule.

## Consequences

- A recipient east of UTC−12 keeps access for up to about a day after their own date ends. This is accepted: it never ends early.
- The end still passes through the minute sweep (decision 0013 timer), so access ends within about a minute of 12:00 UTC.
