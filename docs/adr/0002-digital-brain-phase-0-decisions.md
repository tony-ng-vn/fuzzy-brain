# ADR 0002: Phase 0 decisions for the digital brain

Date: 2026-07-13
Status: accepted

## Context

The digital-brain master plan (docs/superpowers/specs/2026-07-13-digital-brain-master-plan.md) named four decisions that only Tony could make before any ingestion work begins (Phase 0).
M4 (raw slicing) is tracked in its own home, docs/node-structuring.md, since that notebook already had a dedicated format for it.
This ADR records the other three, decided in conversation on 2026-07-13.

## Decision

### 1. Companion-memory isolation (resolves issue #6)

One Polygres database, one more schema alongside `public` (name TBD at implementation time, e.g. `companion`), with its own Postgres role granted access only to that schema -- the exact pattern already proven in this repo: `brain_dev_role` is granted `usage on schema brain_dev` and table privileges scoped to that schema only (scripts/migrate.mjs), and a fresh Postgres role has zero privileges anywhere until granted, so the isolation is enforced by Postgres itself, not by application discipline alone.
No second Polygres instance is needed.

Separately, and more importantly: whatever an AI notices or infers about Tony -- a pattern, a guess, an opinion -- is never itself treated as true about him and never becomes raw.
If an AI thinks something is worth checking, it asks Tony.
Only Tony's own reply, in his own words, can become raw; the AI's original observation was just the question that prompted it.
This is the meaning rule (AGENTS.md rule 7) applied to AI-noticed patterns as a candidate source, not a new rule.

### 2. Deleted-content ethic

When ingesting sources where another person can delete a message after sending it (iMessage, WhatsApp), the evidence store keeps a copy of what was seen, but flags it clearly as deleted by the sender.
Neither silently drops it nor silently keeps it looking un-deleted.

### 3. Evidence exclusion rules

Two different mechanisms for two different kinds of sensitive content, not one:

- Content with an exact, checkable shape (SSN format, credit card format) is caught by a deterministic pattern filter that runs locally, before anything is sent to any AI model (Claude, Codex, or otherwise).
  This is not merely more reliable than AI judgment for this class of data (a pattern match is deterministic; an LLM reading a long message can miss it, the same way a person skimming can) -- it also matters for exposure: by the time an AI reads something, it has already left the machine and gone to a third-party API.
  Catching the exact-shape stuff first, locally, means it never leaves at all.
- Content that could be damaging but has no fixed shape (health information, anything about specific people, anything embarrassing) has no reliable automated detector -- this is a documented failure mode, not a hypothetical one (Microsoft Recall's own sensitive-content filter still indexed a full credit card number including the CVV in testing; docs/research/2026-07-13-digital-brain-landscape.md, dimension 5).
  For this class, Tony names specific people, threads, or topics as fully excluded, ahead of time.
  No AI classifier is trusted to catch fuzzy sensitive content on its own.

## Consequences

Phase 0 of the master plan is complete; Phase 1 (the evidence store, issue #11) may begin.
Issue #6 is resolved in design; the schema and role themselves are not created yet -- that is Phase 1/2 implementation work, not this decision.
The pattern-filter-before-any-AI-model principle is a hard requirement for every ingestion pipeline built later (issues #11, #12), not an optional nice-to-have.
Before the first source that touches personal messages goes live (iMessage/WhatsApp), Tony needs to actually name his fuzzy-exclusion list; that is a prerequisite task for that specific source's issue, not a blocker on Phase 1's schema work.
