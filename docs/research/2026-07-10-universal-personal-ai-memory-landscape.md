# Universal personal AI memory: what exists, what Fuzzy Brain can reuse, and what may still be new

Date: 2026-07-10

Status: research note based only on primary sources, including official specifications, official documentation, source repositories, and original papers.

## Executive answer

Retrieval is a necessary engineering question, but it is not the product's north-star question.

The north-star question is:

> Can any authorized agent form a response that is more correct, relevant, and useful for this particular human because it can access a faithful, current, user-owned model of that human, while remaining able to show what evidence justified the personalization?

That question contains retrieval, but it also contains coverage, truth, time, interpretation, privacy, portability, and response quality.

A system can retrieve the right sentence and still personalize badly by applying it when it is irrelevant, treating an old preference as current, turning a temporary feeling into a permanent trait, or speaking with false psychological certainty.

A system can also retrieve nothing from the brain and still appear knowledgeable because the current model platform has its own private memory, which makes a cross-platform evaluation especially important.

The research supports four high-confidence conclusions.

1. A graph can support the associative, sequential process Tony describes, but only if access is an iterative reconstruction process rather than a one-shot nearest-neighbor lookup.
2. A large narrative node is not inherently a mistake, because it is valuable as an intact episode and source of truth, but it is a mistake if it is also the only addressable retrieval unit and the only semantic unit.
3. Most of the required technical mechanisms already exist in partial form, so Fuzzy Brain should reuse them rather than build an entire memory stack from first principles.
4. The clearest potentially novel contribution is the combination of portable cross-agent personal memory, immutable source evidence, human-ratified meaning, and query-time associative reconstruction under one owner-controlled protocol.

No individual component can safely be claimed as unprecedented.

The closest recent systems already cover ground-truth-preserving episodes, provenance-linked claims, evolving persona graphs, associative graph traversal, model-independent APIs, and personal data pods.

What is not yet visible as a mature standard product is a user-owned "personal epistemic graph" where machines may build retrieval aids but only the person can promote interpretations into the durable meaning layer, and where the same memory contract is usable by unrelated agents and model providers.

## The right way to define success

Retrieval answers, "Did the system find a relevant memory?"

Personalization answers, "Did knowledge of this person improve this response for this situation?"

Those are related but different outcomes.

A useful evaluation model for Fuzzy Brain is:

`personalization quality = fidelity x relevance x currentness x appropriate use x response fit`

This is a conceptual product equation rather than a statistical formula.

If any factor is near zero, the answer can feel generic, wrong, invasive, manipulative, or overconfident even when retrieval recall is high.

The brain should therefore be evaluated on seven capabilities.

1. **Coverage:** The source information needed for a personalized response exists in the brain or the brain knows an authorized source that can resolve it.
2. **Epistemic fidelity:** The system distinguishes Tony's exact words, Tony's normalized factual assertions, Tony-ratified meanings, model hypotheses, and third-party evidence.
3. **Associative reachability:** The system can move from an initial cue through related people, events, places, sources, and prior meanings when the answer is not directly indexed by the query wording.
4. **Temporal coherence:** The system knows what happened when, what is current, what changed, and what was superseded without erasing history.
5. **Personalization judgment:** The agent uses only the memories that materially improve the current response and does not force personal callbacks into every answer.
6. **Cross-agent consistency:** Different authorized agents receive the same evidence and epistemic status even when their harnesses, models, and speaking styles differ.
7. **Owner control:** Tony can inspect, correct, revoke, export, scope, and audit the memory independently of any model company.

This reframing is consistent with the research trend.

[LongMemEval](https://arxiv.org/abs/2410.10813) evaluates extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention, which is broader than nearest-neighbor recall.

[PersonaMem](https://arxiv.org/abs/2504.14225) evaluates whether models infer evolving user profiles and choose personalized responses for new situations, and its authors report that frontier systems still struggled badly enough to achieve only about 50 percent overall accuracy in their setup.

[PERMA](https://arxiv.org/abs/2603.23231) explicitly argues that many memory evaluations reduce personalization to a needle-in-a-haystack problem even though real preferences emerge across connected events over time.

[PersonalLLM](https://proceedings.iclr.cc/paper_files/paper/2025/hash/a730abbcd6cf4a371ca9545db5922442-Abstract-Conference.html) also finds that coarse persona prompting can homogenize preferences instead of capturing individual, idiosyncratic choice.

These results support Tony's instinct that factual retrieval alone is too small a goal.

## What existing systems already solve

### MemGPT and Letta: memory management around a model

[MemGPT](https://arxiv.org/abs/2310.08560) introduced virtual context management, with an agent moving information between limited in-context memory and larger external memory in a way inspired by operating-system paging.

Its central contribution is control over what occupies the model's working context, not a user-owned theory of personal truth.

Current [Letta memory blocks](https://docs.letta.com/guides/core-concepts/memory/memory-blocks) are persistent structured sections that remain in context, can be edited by an agent or marked read-only, and can be shared by multiple Letta agents.

Letta's [context hierarchy](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy) separates always-visible blocks, searchable files, archival memory, and external databases accessible through tools or MCP.

Fuzzy Brain should reuse the separation between working context, durable external memory, and model-controlled memory tools.

Fuzzy Brain should not inherit the assumption that the agent may autonomously rewrite the durable description of the human.

Letta's `human` and `persona` blocks are useful harness inputs, but they are compressed agent context rather than an auditable source-of-truth model.

### Mem0: a practical cross-model memory service

[Mem0](https://github.com/mem0ai/mem0) presents itself as a universal memory layer and exposes add, search, list, update, delete, and history operations scoped by identifiers such as user, agent, and run.

Its current repository documents user, session, and agent memory, self-hosted and managed deployments, and integrations across multiple agent frameworks and model providers.

Its April 2026 algorithm description reports an add-only extraction path plus semantic, BM25 keyword, entity, and temporal signals for retrieval.

Those are valuable implementation patterns for Fuzzy Brain's machine-owned retrieval projection.

The key difference is authority.

Mem0 is optimized to automatically extract and serve useful memories, while Fuzzy Brain's durable meaning graph is intended to contain only what Tony said or approved.

Fuzzy Brain can borrow Mem0's namespace model, API ergonomics, hybrid search, and evaluation harness while rejecting automatic promotion of inferred memory into human truth.

### Zep and Graphiti: temporal graph memory with provenance

[Graphiti](https://github.com/getzep/graphiti) is the strongest mature reference for an evolving graph memory.

It stores raw episodes, extracted entities, and factual relationships with validity windows, and it traces derived facts back to the episodes that produced them.

It also performs incremental graph construction and combines semantic search, full-text search, and graph traversal.

The original [Zep architecture paper](https://arxiv.org/abs/2501.13956) describes a bi-temporal model, episode-to-fact provenance, entity resolution, contradiction handling, and a search-rerank-context-construction pipeline.

This is highly reusable for temporal facts, source lineage, and hybrid candidate generation.

The boundary problem is also clear in the paper.

Graphiti uses LLMs to extract facts, resolve entities, and decide when a new edge invalidates an old edge.

That is reasonable for an application context graph, but it is too much authority for Fuzzy Brain's ratified meaning layer.

A safe adaptation would let Graphiti-like processes populate a rebuildable candidate index or quarantine while the human-approved graph remains structurally separate.

### MemMachine, TierMem, and MemIR: the closest provenance architecture

[MemMachine](https://arxiv.org/abs/2604.04853) is a particularly close reference because it preserves whole conversational episodes, indexes at finer granularity, expands matched sentences with surrounding conversational context, separates episodic and profile memory, and exposes REST, SDK, and MCP interfaces.

It also includes an adaptive retrieval agent that chooses direct retrieval, decomposition, or iterative chain-of-query strategies.

Its authors report that retrieval-stage choices such as depth, formatting, prompts, and query bias correction mattered more than sentence chunking in their LongMemEval ablation.

That is a useful warning against assuming that smaller nodes alone will solve the problem.

[TierMem](https://arxiv.org/abs/2602.17913) identifies a "write-before-query" problem in summaries, because a summarizer cannot know which details a future query will need.

It keeps an immutable raw store, links compact summaries back to raw pages, and escalates to raw evidence when the summary is insufficient.

[MemIR](https://arxiv.org/abs/2605.25869) goes one step further by separating raw evidence, retrieval cues, and truth-bearing claims into typed memory atoms, then allowing factual use only through supported claim atoms.

These systems validate the architectural direction of preserving raw data and linking abstractions back to evidence.

Fuzzy Brain's remaining distinction is that support is not sufficient for durable personal meaning.

Tony's approval is an additional authorization event, not merely a confidence score produced by the extraction model.

### GraphRAG: combine graph structure with raw source text

Microsoft's [GraphRAG indexing pipeline](https://microsoft.github.io/graphrag/index/overview/) extracts entities, relationships, claims, communities, and summaries from document chunks.

Its [local search](https://microsoft.github.io/graphrag/query/local_search/) combines graph entities and relationships with the raw text units connected to them.

Its [global search](https://microsoft.github.io/graphrag/query/overview/) reasons over community reports for corpus-wide questions.

The original [GraphRAG paper](https://arxiv.org/abs/2404.16130) primarily targets query-focused summarization of large private document collections rather than a changing human life.

The reusable lesson is that a graph should not replace source text.

The non-reusable default is unrestricted LLM extraction and summarization into an authoritative graph.

Fuzzy Brain does not currently need community detection or global map-reduce summaries, but it should preserve GraphRAG's graph-to-source-text path.

### Working, episodic, semantic, and procedural memory should not be collapsed

The cognitive labels are useful only if they define different authority and lifecycle rules.

[Episodic-memory research for long-term agents](https://arxiv.org/abs/2502.06975) emphasizes the importance of instance-specific context, including what happened, when, how, why, and with whom.

[Generative Agents](https://arxiv.org/abs/2304.03442) implemented a complete natural-language memory stream, retrieved records using relevance, recency, and importance, synthesized higher-level reflections, and used those reflections for planning.

Its authors also reported failures from missed memories, fabricated embellishments, and model-inherited speech patterns, which shows why believable behavior is not the same as faithful understanding.

For Fuzzy Brain, the memory families should map to different system boundaries.

- Working memory is the temporary context assembled for the current turn and belongs to the harness or model runtime.
- Episodic memory is the immutable record of specific conversations, events, observations, and external source evidence.
- Semantic memory is the durable set of normalized facts, preferences, beliefs, tensions, and meanings supported by episodes and ratified by Tony.
- Procedural memory is the companion's learned way of working, including how it speaks, asks, retrieves, uses tools, and responds to feedback, and it belongs in the model or companion brain rather than Tony's life graph.

This separation prevents a model's speaking habit from becoming a claim about Tony and prevents a temporary episode from silently becoming a permanent identity statement.

It also provides a clean basis for the planned human-brain and model-brain isolation.

### HippoRAG, A-MEM, GAM, HeLa-Mem, and MRAgent: associative access instead of one-shot retrieval

[HippoRAG](https://arxiv.org/abs/2405.14831) combines a knowledge graph with Personalized PageRank to spread activation from query-linked concepts across related nodes for multi-hop retrieval.

This is close to Tony's intuition that one remembered fact should activate another.

[A-MEM](https://arxiv.org/abs/2502.12110) builds Zettelkasten-like notes with contextual descriptions, keywords, tags, and automatically generated links, and lets new memories evolve the representations of older ones.

Its flexible linking is useful as a candidate-generation idea, but its autonomous linking and rewriting conflict with Fuzzy Brain's ratification rule.

[GAM](https://arxiv.org/abs/2604.12285) separates an active event progression graph from a stable topic associative network, then consolidates an event only when a semantic shift occurs.

That event-versus-stable-network split is highly relevant to long raw conversations, although GAM still lets an LLM generate semantic relations, summaries, confidence values, and edge weights.

[HeLa-Mem](https://aclanthology.org/2026.acl-long.625/) is a peer-reviewed ACL 2026 system that strengthens graph associations through repeated co-activation, performs spreading activation at retrieval time, and distills dense episodic regions into semantic memory.

Its association, consolidation, and spreading-activation loop is probably the closest computational analogue to the "I remember Arizona, then Uber Eats, then the receipt" process in Tony's example.

The newest and most directly aligned work is the June 2026 preprint [MRAgent](https://arxiv.org/abs/2606.06036).

MRAgent represents memory as a Cue-Tag-Content graph and treats recall as active reconstruction, where an LLM iteratively explores and prunes paths based on evidence found so far instead of accepting a static top-k retrieval result.

This is the right retrieval paradigm for Fuzzy Brain's vision.

The graph is not the answer database.

The graph is a navigable set of cues that helps an agent discover the next useful place to look.

### MCP and Solid: transport and ownership are separate layers

The [Model Context Protocol architecture](https://modelcontextprotocol.io/docs/learn/architecture) standardizes how an AI host connects to servers that expose resources, tools, and prompts.

MCP explicitly does not dictate how an AI application should use retrieved context, so MCP can make Fuzzy Brain available to agents but cannot guarantee good personalization.

The stable [MCP resource specification](https://modelcontextprotocol.io/specification/2025-11-25/server/resources) provides discoverable resources with URIs, metadata, priority hints, and access checks.

The stable [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) uses OAuth discovery and recommends least-privilege scopes for remote servers.

MCP is therefore the best current interoperability surface for Fuzzy Brain, but it is a transport contract rather than a personal-memory semantic standard.

[Solid](https://solidproject.org/about) takes the opposite side of the problem by separating applications from user-controlled personal online data stores called Pods.

The [Solid Protocol](https://solid.github.io/specification/protocol) defines interoperable resource access, WebID identity, authentication, and permissioned external storage.

Solid does not define episodic memory, ratified meaning, associative traversal, or personalized response construction.

Fuzzy Brain should borrow Solid's principle that data survives application changes and remains controlled by the person, but it does not need to adopt RDF or the full Solid ecosystem before its memory semantics are stable.

For highly sensitive remote use, the 2026 [Agent-Memory Protocol](https://proceedings.mlr.press/v317/wu26a.html) is also relevant.

It proposes deterministic "redact at rest, pack for purpose, hydrate on return" operations so personal identifiers can remain inside the user's boundary while an external model reasons over de-identified context.

## How Tony's Safford example should work

The example reveals three distinct states that a useful brain must represent.

1. **The brain knows the answer:** A ratified claim says that Tony's girlfriend lives in Safford, Arizona, and the claim points to the exact source evidence.
2. **The brain does not know the answer but knows how to resolve it:** The graph links Tony's girlfriend to an Uber Eats delivery history and a Messenger conversation as possible evidence sources, with authorized search capabilities for each.
3. **The brain does not know and has no authorized resolution path:** The agent says so instead of completing a plausible address from model probability.

The second state is missing from most memory systems.

It suggests that Fuzzy Brain should store not only memories but also source locators and resolution paths.

A query-time path could look like this:

`girlfriend -> lives in -> Arizona -> city unknown -> evidence source -> Uber Eats orders -> matching recipient -> Safford address`

Another path could look like this:

`girlfriend -> Messenger conversation -> search term "Arizona" -> address-bearing message -> Safford`

The retrieved receipt or message then becomes evidence for a proposed claim.

It should not silently become a ratified meaning edge.

This is better described as an **epistemic navigation graph** than as a conventional knowledge graph.

The graph records what is known, why it is known, what is merely suggested, and where missing knowledge might be resolved.

## The correct role of a large node such as "here but not here"

The large node is valuable as an intact episode because its order, language, uncertainty, and emotional texture are part of the source.

Destroying it into independent facts would lose context and make future interpretation less trustworthy.

The problem appears only when the system asks that one row to perform every role.

One source episode should have several addressable projections.

- The immutable raw episode preserves Tony's exact words.
- The approved readable preserves a human-usable description without adding interpretation.
- Source spans let the system cite exact portions of the episode.
- Machine-owned cues expose names, places, dates, aliases, and candidate topics for recall.
- Ratified claims normalize facts that Tony explicitly accepts.
- Ratified meaning nodes and why-edges capture interpretations or connections Tony explicitly approves.

These projections should not all be ordinary brain nodes with equal authority.

Machine cues are rebuildable index artifacts.

Source spans are provenance records.

Ratified claims and meanings are durable human-authorized knowledge.

The source episode remains whole, so atomization improves addressability without destroying narrative context.

## A reference architecture for Fuzzy Brain

### 1. Evidence plane

The evidence plane stores immutable raw episodes, external source records, exact spans, speakers, capture time, event time when known, and source locators.

It records "Tony said X" without automatically claiming that X is eternally true or that an inferred explanation is correct.

This plane is append-mostly and audit-oriented.

### 2. Cue plane

The cue plane contains machine-generated, rebuildable search artifacts such as chunks, aliases, named entities, lexical terms, embeddings, dates, co-occurrence signals, and connector capabilities.

It may also contain learned co-activation weights inspired by HeLa-Mem or candidate cue-tag links inspired by MRAgent.

These are not meaning edges and must never be displayed or traversed as Tony-ratified truth.

This separation preserves the repo's "never auto-link" rule because machine associations are index mechanics, not brain connections.

### 3. Ratified semantic plane

The ratified semantic plane contains normalized claims, personal preferences, beliefs, tensions, revisions, and why-edges that Tony explicitly approved.

Every item points down to supporting evidence spans or to a recorded approval event.

Old claims are superseded or revised rather than overwritten when Tony changes.

Model hypotheses remain outside this plane until discussed and approved.

### 4. Access and policy plane

The access plane exposes scoped read and suggestion operations to agents through MCP and a stable API.

It distinguishes the human brain from each model or companion brain with explicit `owner_id`, `brain_id`, `principal_id`, and role or scope boundaries.

Useful scopes would include `brain.search`, `brain.read_readable`, `brain.read_raw`, `brain.suggest`, and a human-only `brain.ratify` capability.

The access plane also records which memories were returned to which agent for which request.

### 5. Query-time memory reconstruction

A query should begin with hybrid anchors from lexical, semantic, entity, temporal, and recency signals.

The agent should then perform a bounded traversal that can formulate the next cue from evidence already found, prune irrelevant paths, and stop when the evidence is sufficient.

The final memory package should contain claims, epistemic status, exact evidence, relevant neighboring whys, and missing-information warnings.

The harness then decides how to speak, what opinion to offer, and whether a personal callback helps.

This keeps the brain as a source of truth and the companion harness as the source of voice, identity, and interaction policy.

## What should be reused now

1. Reuse Graphiti's episode, provenance, bi-temporal, and hybrid-search concepts, but keep automatic extraction in a non-authoritative projection.
2. Reuse MemMachine and TierMem's intact episodes, fine-grained search, surrounding-context expansion, and escalation from compact evidence to raw source.
3. Reuse MemIR's explicit separation among evidence, cues, and factual claims.
4. Reuse MRAgent's active reconstruction pattern so retrieval can change direction after intermediate evidence appears.
5. Reuse HippoRAG or HeLa-Mem style graph spreading only as a candidate-ranking mechanism, not as authority to create meaning.
6. Reuse Mem0's API and namespace ergonomics for user, agent, session, and run isolation.
7. Reuse MCP for cross-agent access and Solid's owner-controlled, application-independent data principle.
8. Reuse LongMemEval, PersonaMem, PersonalLLM, and PERMA as templates for different parts of the evaluation, while building a Tony-specific held-out set.

## What should not be adopted yet

1. Do not run a full GraphRAG community-summarization pipeline over a six-node personal graph.
2. Do not let an LLM-generated entity graph, confidence score, or contradiction decision become the human's source of truth automatically.
3. Do not delete the full episode after fact extraction or treat a readable summary as sufficient evidence.
4. Do not equate more atomic nodes with better personalization, because retrieval strategy and evidence packaging can matter more than ingestion granularity.
5. Do not train or fine-tune an open model until the external memory and harness can demonstrate measurable personalization gains across existing models.
6. Do not adopt a complex universal ontology before real personal data reveals which distinctions are stable.
7. Do not expose the remote brain without per-agent authorization, least-privilege scopes, audit logs, and a human-only ratification path.

## A better evaluation program

The primary outcome should be **personalized response fidelity**, with retrieval reported as a diagnostic layer.

### Evaluation conditions

Run the same prompts under at least these conditions.

1. Use the base model with no Fuzzy Brain and no companion harness.
2. Use the base model with the companion harness but no Fuzzy Brain.
3. Use the base model with Fuzzy Brain but a neutral answer harness.
4. Use the base model with both Fuzzy Brain and the companion harness.
5. Repeat the four conditions across Claude, Codex or OpenAI, Gemini, and eventually an open-weight model when practical.

The comparison separates what the brain knows from how the companion speaks.

### Prompt classes

The test set should contain more than direct factual questions.

- Direct facts test exact recall and currentness.
- Connected facts test graph and multi-hop reachability.
- Advice prompts test whether personal history changes the recommendation for a legitimate reason.
- Reflection prompts test whether the system distinguishes Tony's words from model interpretation.
- Update prompts test whether newer information supersedes older information without erasing it.
- Irrelevance prompts test whether the agent avoids gratuitous personalization.
- Missing-information prompts test abstention and source-resolution planning.
- Cross-agent prompts test whether different models receive consistent evidence.

### Scoring dimensions

Tony should blindly compare responses without knowing which condition produced them.

Each response should be scored for usefulness, felt personalization, factual support, currentness, relevance of callbacks, overreach, and tone.

An evaluator should separately mark every personal claim as supported, contradicted, inferred, or unsupported.

The system should also record the memory path used, the evidence spans returned, the number of reconstruction steps, and whether an external source was consulted.

### The most important metric

A useful headline metric is:

`supported personalization rate = helpful personalized claims / all personalized claims`

This should be paired with a personalization gain score from Tony's blind preference, because a perfectly grounded response can still be generic or unhelpful.

Retrieval recall at k remains useful, but only to explain why a response succeeded or failed.

### A strong research question

The clearest original experiment is:

> Does a human-ratified personal semantic graph reduce unsupported personalization and improve cross-model response preference compared with automatic memory extraction, without losing useful personalization?

That question directly tests the product's core belief instead of testing whether a graph can answer trivia.

## What may genuinely be new

The honest answer is that the field is now moving very close to this vision.

MemMachine preserves ground truth and works across model changes.

MemIR separates evidence, cues, and claims.

Graphiti provides temporal provenance graphs.

MRAgent reconstructs memories through associative paths.

[PGMem](https://yukyunglee.com/publication/2026-pgmem/) links persona signals to the events that support or revise them.

Solid separates a person's data from the applications that use it.

MCP lets unrelated agents access a common external service.

The potentially original product and research contribution is the composition of those ideas under a stricter human-authority rule.

That contribution could be described as:

> A portable, human-ratified personal epistemic graph that lets any authorized agent reconstruct relevant context from immutable life evidence, while separating retrieval cues, factual claims, personal meaning, model hypotheses, and external resolution paths.

Five properties make that more than another memory API.

1. The memory belongs to the human rather than to the companion or model provider.
2. The database encodes epistemic authority, not just confidence, so a machine cannot promote interpretation into personal truth.
3. The graph stores both known information and authorized paths for resolving unknown information.
4. Personal meaning remains traceable to exact life evidence and explicit ratification.
5. Different agents may have different voices and identities while consuming the same human-owned evidence contract, and their own brains remain isolated from the human brain.

The hard new work is therefore not inventing another graph database or vector index.

It is defining and validating the semantic and authorization contract between a human, their memory, and any agent that wants to personalize itself to them.

## Recommended next step

Build one thin vertical experiment before expanding the ontology.

1. Keep each current raw node intact as an episode.
2. Add exact source spans and a rebuildable cue index without adding automatic meaning edges.
3. Add a query tool that returns evidence bundles with epistemic status and supports one or two bounded follow-up searches.
4. Expose that read path through a local MCP server with the write and ratification paths disabled for agents.
5. Create ten high-value advice and reflection prompts, ten factual or temporal prompts, five irrelevant-personalization traps, and five deliberately unanswerable prompts.
6. Compare current full-context reading, one-shot retrieval, and active associative reconstruction across at least two models.
7. Let Tony blindly judge the responses and inspect the evidence paths behind the winners and failures.

That experiment will reveal whether the next bottleneck is node structure, graph coverage, retrieval policy, evidence packaging, harness behavior, or simply missing life data.

It will also test the actual vision: not whether the system can fetch a stored sentence, but whether a model-independent personal brain can make different agents understand and help Tony better without inventing him.

## Source maturity note

Several of the closest systems cited here are 2026 preprints, including MRAgent, MemIR, TierMem, MemMachine, GAM, PERMA, and PGMem.

Their benchmark results are author-reported and were not independently reproduced for this note.

HeLa-Mem is published in ACL 2026 proceedings, LongMemEval in ICLR 2025, PersonaMem in COLM 2025, PersonalLLM in ICLR 2025, and the Agent-Memory Protocol in PMLR 2026.

The MCP and Solid citations are official specifications or project documentation.
