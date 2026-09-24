# Recall provenance corrections

## Problem

Session capture can append several episodes for one conversation.
Retrieval used each episode ID as an observation group, so several excerpts from that conversation appeared to come from different observations.
Recall also returned a containing episode's date as the message date when the message had no recorded timestamp.
Passage readback and lexical search disagreed on which legacy speaker names established roles.
A missing node ID produced the same error as unavailable storage.

## Changes

Keep portable archive groups based on their registered source ID and source key.
For known session kinds, derive the group from source ID and the original session locator after removing a recognized generated continuation suffix.
Unknown source kinds, missing locators, and unavailable portable archive metadata keep episode groups.
This groups source identity without creating semantic links or asserting that different groups are independent evidence.

Use recorded archive roles when available.
For known session parsers, map their stored `tony` and `assistant` speakers to their actual roles.
Other legacy role assignments remain unknown, including arbitrary source records named `tony`.
Keep legacy fidelity unknown because a recognized parser does not establish byte-for-byte source fidelity.

Return the actual message timestamp and separate containing source date bounds.
Keep recall's existing source-date fallback for dated retrieval and report its basis explicitly.
Lexical search's explicit date filters continue to require message timestamps.
Keep passage neighbors within their saved episode and label that limit instead of claiming cross-fragment chronological adjacency.
Return `not_found` when a node lookup completes without finding the requested ID.

## Validation

Use disposable database fixtures containing base sessions, both generated suffix formats, duplicate locators in different sources, unknown source kinds, missing locators, and unavailable archive metadata.
Compare source groups and role behavior across recall, lexical search, and passage readback.
Verify dated and undated messages retain their distinct timestamps and source dates.
Verify exact date search excludes undated messages while contextual recall can find them through a dated episode.
Exercise missing and existing node reads through a real MCP connection.
Preserve existing archive provenance and database round-trip checks.

## Deployment

This release changes reads and tool guidance only.
No schema migration, backfill, or rewrite of retained evidence is required.
Refresh the pinned runtime after merging, then verify through fresh read-only MCP connections.
