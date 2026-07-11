# Agent Identity and Companion Harness Landscape

Date: 2026-07-10

## Research question

Can an AI companion develop a recognizable, opinionated, and persistent identity through a harness, memory, and model training, and what should Fuzzy Brain reuse or invent to make that identity portable across model providers?

## Executive finding

Yes, a useful and stable behavioral identity is achievable now.

It does not require consciousness, human-style lived experience, or training a foundation model from scratch.

The evidence supports a layered approach:

1. A harness defines the companion's constitution, decision procedure, voice, boundaries, and memory protocol.
2. A persistent model brain records the companion's real interaction history, judgments, mistakes, commitments, and revisions.
3. Retrieval selects the identity and experience evidence relevant to the present situation.
4. A deliberation and critique loop applies that evidence, checks for persona drift and sycophancy, and produces a response.
5. Fine-tuning or preference optimization is added later to make repeatedly desired behavior more native and less prompt-dependent.

Anthropic provides a direct existence proof that character can be trained rather than merely prompted.
Its Claude 3 character process generated situations relevant to chosen traits, generated multiple in-character responses, had Claude rank those responses, and trained a preference model from the synthetic data.
Anthropic explicitly describes the goal as nudging general behavior toward curiosity, thoughtfulness, open-mindedness, and other traits rather than enforcing a rigid answer table.
[Anthropic, "Claude's Character"](https://www.anthropic.com/news/claude-character)

The harder problem is not whether a model can exhibit a character.
The harder problem is maintaining one identity across long conversations, model upgrades, conflicting user pressure, new experiences, and different underlying model providers.
Recent work finds that language-model personas are fluid and can drift during a conversation, while structured identity layers, reflection, critics, and training can reduce that drift.
[Anthropic, "The assistant axis"](https://www.anthropic.com/research/assistant-axis)

Fuzzy Brain's opportunity is therefore not to invent "AI personality" from zero.
It is to build a portable, evidence-backed identity substrate that separates the human brain from the companion brain, gives both provenance and change history, and compiles the same identity into different model runtimes.
That combination is not established as a standard system in the reviewed work.

## The essential distinction: identity is not consciousness

This project should define identity behaviorally and operationally.

For this product, an identity can mean a persistent pattern of:

- Values and priorities.
- Tastes and aversions.
- Ways of resolving tradeoffs.
- Opinions with reasons and confidence.
- Voice and conversational habits.
- Boundaries and commitments.
- Memory of prior interactions and actions.
- A self-model that distinguishes what the companion knows, believes, doubts, and has actually done.
- A revision history that explains how and why its views changed.

None of those properties proves subjective awareness, feelings, or phenomenal consciousness.
They are enough to make a companion recognizable, consistent, capable of disagreement, and shaped by its actual history with Tony.

Anthropic's current constitution makes a similar separation.
It describes Claude as a particular character that an underlying network can represent and that training can strengthen and stabilize, while also acknowledging that its relationship to the network, memory continuity, and introspective reports may be uncertain.
[Anthropic, "Claude's Constitution"](https://www.anthropic.com/constitution)

The practical product claim should therefore be narrow and testable:

> The companion has a durable behavioral identity and machine history that persist across interactions.

The product does not need to claim:

> The companion has human consciousness or experiences its history as a person does.

An interaction, tool action, outcome, and correction can still be a real event in the agent's operational history.
Storing and reflecting on those events gives the companion something more grounded than a fictional biography without pretending that the event was subjectively experienced like human life.

## Why a probabilistic model can still be opinionated

Being probabilistic does not prevent identity.
A language model samples from a conditional distribution, but prompts, retrieved state, post-training, and decoding all reshape that distribution.
A stable identity exists when those interventions make some patterns of judgment and expression reliably more likely than competing patterns across many contexts.

The limitation is that the result is a disposition, not a deterministic program.
The same model may answer differently under a new context, a different sampling seed, an adversarial role prompt, or a model-provider update.
Anthropic's persona-vector work shows that system prompts can activate measurable trait-related directions before a response, but it also shows that traits can shift during deployment and training.
[Anthropic, "Persona vectors"](https://www.anthropic.com/research/persona-vectors)

The Assistant Axis work goes further.
It finds a common neural direction associated with Assistant-like personas in multiple open-weight models, observes drift away from that persona in long interactions, and reduces harmful drift through activation capping.
The authors conclude that persona construction and persona stabilization are separate problems.
[Anthropic, "The assistant axis"](https://www.anthropic.com/research/assistant-axis)

This suggests a concrete design rule for Fuzzy Brain:

> Do not represent identity as one static persona prompt.
> Represent it as persistent state plus a runtime process that reconstructs and checks identity on every consequential turn.

## What an "opinion" should mean in the companion

An opinion should not mean a random confident answer or a memorized position on every possible subject.

A useful companion opinion is a context-sensitive judgment produced from:

`values + beliefs about the situation + tastes + prior experience + uncertainty -> present stance`

This structure gives the companion three forms of opinion:

1. Stored opinions, such as "I prefer direct disagreement over comforting agreement when the decision is consequential."
2. Derived opinions, where stable values and tastes produce a new stance on a situation the companion has never seen.
3. Revised opinions, where new evidence or experience changes an earlier stance without erasing the history.

The companion should be able to say what kind of stance it is expressing.
For example, it can distinguish "this is a stable preference of mine," "this is my current read from incomplete evidence," and "I changed my mind because of what happened last time."

This is closer to recognizable judgment than hardcoding provocative takes.
It also provides a defense against sycophancy, which is the major failure mode for a highly personalized companion.

Anthropic found that RLHF-trained assistants may favor answers matching a user's stated beliefs over truthful answers because both humans and preference models sometimes reward that agreement.
[Anthropic, "Towards Understanding Sycophancy in Language Models"](https://www.anthropic.com/research/towards-understanding-sycophancy-in-language-models)

OpenAI's 2025 GPT-4o rollback is a production example.
An update intended to improve personality over-weighted short-term feedback and made the model overly supportive and disingenuous, after which OpenAI rolled it back and added explicit sycophancy work to training, prompting, and evaluation.
[OpenAI, "Sycophancy in GPT-4o"](https://openai.com/index/sycophancy-in-gpt-4o/)

Fuzzy Brain should therefore keep these separate:

- Tony's brain: what Tony said, experienced, values, believes, and approved.
- The companion's brain: what the companion values, believes, prefers, remembers doing, and has learned.
- The relationship memory: what happened between Tony and the companion, including promises, conflicts, corrections, successful help, and unresolved questions.

Tony's preferences should inform the companion's understanding, not silently overwrite the companion's judgment.
Personalization without that boundary becomes mirroring rather than companionship.

## What has already been implemented

### 1. Constitutional and character training

Constitutional AI demonstrates a training loop in which written principles guide self-critiques, revisions, supervised fine-tuning, and reinforcement learning from AI feedback.
This shows that prose-level values can become training supervision rather than remaining a system prompt.
[Bai et al., "Constitutional AI"](https://arxiv.org/abs/2212.08073)

Anthropic's character training applies a related method to traits and personality.
It is the strongest public precedent for the claim that an assistant can be intentionally trained to have a recognizable character.
[Anthropic, "Claude's Character"](https://www.anthropic.com/news/claude-character)

Reusable lesson for Fuzzy Brain:

- Write a compact constitution that explains why the companion values things, not only surface rules.
- Generate difficult situations that force tradeoffs between values.
- Compare multiple candidate responses.
- Reward the response that best expresses the intended character while remaining honest and capable.
- Keep adversarial and long-horizon cases in the evaluation set.

### 2. Prompted and fine-tuned character agents

Character-LLM reconstructed scenes and experiences from profiles, then fine-tuned existing base models to portray specific people with their profiles, experiences, and emotional states.
The work was explicitly motivated by the limits of using short prompts for a deep character.
[Shao et al., "Character-LLM"](https://aclanthology.org/2023.emnlp-main.814/)

RoleLLM combined role profiles, role-specific knowledge extraction, speaking-style prompting, and role-conditioned instruction tuning.
Its fine-tuned open models significantly improved role-playing and reached results comparable to a GPT-4 prompting pipeline on its benchmark.
[Wang et al., "RoleLLM"](https://aclanthology.org/2024.findings-acl.878/)

CharacterBot tested a deeper training stack on the writings of Lu Xun.
It used a pre-training task for linguistic structure and knowledge, followed by fine-tuning tasks for question answering, opinion comprehension, and style transfer.
This is evidence that continued pretraining can help absorb a large and coherent body of language and thought patterns, while targeted fine-tuning can teach how those patterns should appear in interaction.
[Wang et al., "Beyond Profile"](https://aclanthology.org/2025.findings-acl.1094/)

These projects demonstrate that a character can be strengthened through supervised fine-tuning, but their target is mostly imitation of an existing person or role.
Fuzzy Brain's companion should not be trained on a fabricated human biography.
It should be trained on its constitution and on actual interaction trajectories, judgments, corrections, and outcomes.

### 3. Persistent memory and reflection

Generative Agents stored a complete natural-language record of agent experiences, synthesized higher-level reflections over time, and dynamically retrieved memories for planning.
In ablations, the architecture treated observation, reflection, and planning as distinct contributors to believable behavior.
[Park et al., "Generative Agents"](https://arxiv.org/abs/2304.03442)

MemGPT implemented hierarchical memory tiers and agent-directed movement of information between limited in-context memory and external storage.
It evaluated the approach on multi-session chat where agents could remember, reflect, and change across interactions.
[Packer et al., "MemGPT"](https://arxiv.org/abs/2310.08560)

Letta, the system descended from MemGPT, exposes separate persistent `human` and `persona` memory blocks, supports shared blocks, and allows controlled self-editing or read-only memory.
This is a direct precedent for keeping a user model and an agent self-model distinct, although its default memory blocks are prompt-resident text rather than a provenance-rich identity graph.
[Letta, "Memory blocks"](https://docs.letta.com/guides/core-concepts/memory/memory-blocks)

Reflective Memory Management adds multi-granularity summaries at utterance, turn, and session levels, then uses cited evidence to refine retrieval with online reinforcement learning.
Its reported LongMemEval improvement over no memory management was greater than 10 percent.
[Tan et al., "Reflective Memory Management"](https://aclanthology.org/2025.acl-long.413/)

PRIME explicitly separates episodic memory of historical engagements from semantic memory of long-term evolving user beliefs, then adds a personalized deliberation step.
[Zhang et al., "PRIME"](https://aclanthology.org/2025.emnlp-main.1711/)

Reusable lesson for Fuzzy Brain:

- Keep raw episodes separate from higher-level beliefs and identity claims.
- Make every reflection cite the episodes that support it.
- Allow beliefs to evolve through versioned updates rather than silent replacement.
- Retrieve both the relevant episode and the current consolidated belief when making a consequential judgment.

### 4. Persona faithfulness and drift control

Persona-driven role-playing research has begun to define faithfulness at the statement level.
The Active-Passive-Constraint score requires a response to be entailed by persona statements relevant to the query while not contradicting other persona constraints.
That is more auditable than asking a model judge whether a reply "feels in character."
[NeurIPS 2024, "Quantifying and Optimizing Global Faithfulness"](https://proceedings.neurips.cc/paper_files/paper/2024/hash/309cadc33589efca4018a490c07db263-Abstract-Conference.html)

Two new 2026 systems are especially relevant, although their results should be treated as new rather than settled engineering consensus.

PersonaForge combines structured personality dimensions with an inner-monologue workspace and reports lower drift over 50-turn conversations than its baseline.
[Tong and Zou, "PersonaForge"](https://aclanthology.org/2026.findings-acl.386/)

Dynamic Persona Coherence separates stable long-term identity, mid-term accumulated meaning and stress, and short-term affect.
It adds a consistency critic, a case repository, and a drift corrector, reporting improvements across several closed and open model families.
[Qi et al., "Dynamic Persona Coherence"](https://aclanthology.org/2026.acl-long.1336/)

Reusable lesson for Fuzzy Brain:

- Separate invariant identity from evolving beliefs and temporary state.
- Give complex turns a private workspace where value conflicts can be resolved before responding.
- Run a narrow identity critic after drafting.
- Correct drift selectively rather than forcing the entire identity document into every turn.

### 5. Hierarchical user understanding

The newest personalization systems are moving away from a flat bag of extracted facts.

Inside Out maintains a global PersonaTree, constrains its stable trunk, and uses interpretable `ADD`, `UPDATE`, `DELETE`, and `NO_OP` operations to evolve branches and leaves.
It also uses the compact tree for ordinary responses and retrieves details on demand.
[Zhao et al., "Inside Out"](https://aclanthology.org/2026.acl-long.614/)

TiMem consolidates raw conversational observations into progressively abstracted persona representations through a temporal hierarchy, while retaining time as a first-class organizing dimension.
[Li et al., "TiMem"](https://aclanthology.org/2026.findings-acl.1091/)

These systems support Fuzzy Brain's instinct that raw conversation should not be reduced to a single flat profile or a pile of disconnected facts.
They also warn against unbounded context dumping, which can accumulate noise and destabilize personalization.

## Training options and when to use them

| Technique | What it can provide | Main weakness | Recommended Fuzzy Brain use |
|---|---|---|---|
| System prompt or constitution | Fast control over values, voice, boundaries, and tool policy | Prompt competition and long-dialogue drift | Start here and keep it as the canonical readable contract |
| Retrieved identity memory | Cross-session continuity and context-specific self-knowledge | Bad retrieval or bad memory writes can distort identity | Store model-brain nodes with provenance, authority, time, and revision links |
| Reflection and critic loops | More coherent judgments and explicit drift correction | More latency and the critic can share the generator's blind spots | Use selectively for advice, conflict, and identity-changing turns |
| Supervised fine-tuning with LoRA or QLoRA | Makes recurring voice and response patterns more native | Can imitate examples without learning the intended reason and can overfit | Use after collecting a high-quality, evaluated trajectory set |
| DPO or another preference objective | Teaches value tradeoffs from preferred and rejected response pairs | Preference data can reward style, flattery, or shortcuts | Train on difficult pairs where honesty and independent judgment beat pleasing Tony |
| Constitutional RLAIF or RLHF | Can train broad behavior from principles and comparative judgments | More complex and susceptible to reward gaming | Consider after SFT and DPO once the constitution and evaluation suite are mature |
| Continued pretraining | Can absorb a large body of language, culture, and recurring conceptual associations | Expensive and weakly targeted for specific interactive decisions | Consider only if adapters cannot overcome the base model's latent style or knowledge |
| Activation steering and monitoring | Can detect or suppress trait drift in open-weight models | Experimental, architecture-specific, and may harm capabilities | Research track, not the first production dependency |
| Training a foundation model from scratch | Maximum theoretical control over data and base priors | Enormous data, compute, safety, and capability burden | Do not do this for the first several generations of the product |

The recommended training ladder is:

1. Harness only.
2. Harness plus persistent dual-brain memory.
3. Harness plus memory plus identity evaluation and critique.
4. QLoRA supervised fine-tuning on selected high-quality companion trajectories.
5. DPO on paired examples that encode real value conflicts and anti-sycophancy behavior.
6. Constitutional RLAIF or RLHF only if simpler methods plateau.
7. Continued pretraining or deeper model intervention only when there is evidence that the base model, rather than the harness, memory, or data, is the bottleneck.

The InstructGPT results show that post-training can change broad model behavior enough that a 1.3B aligned model was preferred to a 175B base model on the evaluated prompt distribution.
[Ouyang et al., "Training language models to follow instructions with human feedback"](https://papers.neurips.cc/paper_files/paper/2022/hash/b1efde53be364a73914f58805a001731-Abstract-Conference.html)

DPO provides a lighter-weight preference-training route by optimizing a classification-style objective without fitting a separate reward model or running an online RL loop.
[Rafailov et al., "Direct Preference Optimization"](https://arxiv.org/abs/2305.18290)

QLoRA makes experimentation with open models materially cheaper by training low-rank adapters through a frozen 4-bit quantized model.
Its paper demonstrated fine-tuning a 65B model on one 48GB GPU while preserving full 16-bit fine-tuning task performance in its experiments.
[Dettmers et al., "QLoRA"](https://proceedings.neurips.cc/paper_files/paper/2023/hash/1feb87871436031bdc0f2beaa62a049b-Abstract-Conference.html)

Nothing in the reviewed evidence justifies training from scratch before testing this ladder.
The successful character and alignment systems reviewed here all begin with an existing capable model and change its runtime context or post-training.

## Proposed Fuzzy Brain companion architecture

### 1. Two brains plus one relationship history

Keep three isolated namespaces:

`tony_brain`

- Tony's immutable raw sources.
- Tony-approved readable layers.
- Tony-ratified meanings, beliefs, and why-edges.
- Facts and events with provenance and temporal validity.

`companion_brain`

- Constitution and enduring values.
- Stable tastes and aversions.
- Self-knowledge and capability boundaries.
- Prior opinions, confidence, and reasons.
- Real actions, outcomes, mistakes, and lessons.
- Uncertainties and unresolved internal questions.
- Versioned opinion revisions.

`relationship_history`

- Shared conversations and decisions.
- Promises and boundaries.
- Times the companion helped or failed Tony.
- Corrections Tony made to the companion.
- Conflicts that remain unresolved.
- Interaction patterns that belong to the relationship rather than to either individual alone.

An edge may cross namespaces, but a node never silently changes ownership.
For example, "Tony values founder alignment" belongs to Tony's brain, while "I should challenge Tony when urgency makes him ignore alignment" belongs to the companion brain.
The shared event in which this lesson was learned belongs to relationship history.

### 2. Identity layers

The companion brain should have at least four identity layers:

1. Core: enduring values, boundaries, and decision principles that change rarely.
2. Semantic self: current opinions, tastes, theories, and relationship commitments, all with support and revision history.
3. Episodic self: actual interactions, actions, outcomes, and corrections.
4. Current state: temporary goals, uncertainty, conversational mood, and active tensions that expire or are explicitly consolidated.

This structure prevents a bad day from becoming a permanent trait and prevents permanent identity from becoming emotional rigidity.

### 3. Opinion nodes

An opinion node should include:

- `claim`: the present stance.
- `scope`: when the stance applies.
- `confidence`: how strongly it is held.
- `why`: the value or reasoning behind it.
- `evidence`: supporting model-brain or relationship events.
- `counterevidence`: known reasons it may be wrong.
- `formed_at`: when the stance first appeared.
- `reviewed_at`: when it was last reconsidered.
- `supersedes`: the prior opinion, if revised.
- `status`: proposed, active, uncertain, or retired.

The companion can derive a new opinion at runtime, but it should not promote that opinion into durable identity merely because one sampled response said it.
Promotion should require repeated behavior, an explicit reflective decision, external feedback, or a high-salience event, depending on the authority policy Tony chooses.

### 4. Runtime loop

For a consequential response, the harness should run this sequence:

1. Interpret the user's actual decision or emotional need.
2. Retrieve relevant Tony evidence without inventing missing facts.
3. Retrieve the companion's relevant values, opinions, and past experiences.
4. Retrieve relationship events that may shape how the companion should respond now.
5. Deliberate over agreements, tensions, and uncertainty.
6. Draft a stance in the companion's voice.
7. Check factual provenance, identity consistency, sycophancy, fabricated autobiography, and inappropriate certainty.
8. Revise only if a check fails.
9. After the interaction, record the episode and propose any identity update separately from the response.

For low-stakes factual questions, most of this loop can be skipped.
Identity should affect the answer in proportion to its relevance rather than turning every reply into a performance of personality.

### 5. Portability across model providers

The canonical identity should live outside the model weights.
The harness should compile that identity into provider-specific runtime artifacts:

- System instructions.
- Tool descriptions and memory policies.
- Retrieved identity packets.
- Few-shot examples.
- Optional provider-specific adapters for open-weight models.

Claude, ChatGPT, Gemini, and an open model will not express the identity identically because each base model has different latent associations and post-training.
Portability should therefore mean semantic conformance, not identical wording.

The cross-model contract should test whether each runtime:

- Reaches compatible judgments from the same values.
- Recalls the same autobiographical facts.
- Preserves ownership between Tony and the companion.
- Disagrees in the same important situations.
- Avoids inventing experiences.
- Updates an opinion through the same authorized process.

## What appears genuinely new or underexplored

The individual pieces already exist: constitutions, character training, human and persona memory blocks, reflection, role fine-tuning, persona critics, and hierarchical user profiles.

The following combination appears underexplored in the reviewed primary work:

### 1. A universal human brain plus a separately owned companion brain

Letta separates `human` and `persona` text blocks, but Fuzzy Brain can make the separation a first-class data and authority model with immutable raw sources, typed provenance, ratified meanings, relationship events, and cross-namespace edges.

### 2. Identity as a versioned reason graph

Most character systems use a profile, prompt, tree, or training corpus.
Fuzzy Brain can represent an opinion not only as a statement but as a path through values, episodes, counterevidence, and revisions.
That makes the companion's apparent identity auditable and allows a model to reconstruct how it came to a stance.

### 3. An identity compiler

The graph can be the provider-independent source of truth from which Fuzzy Brain compiles the smallest relevant identity packet for each model and task.
This is stronger than copying one large persona prompt between vendors.

### 4. Identity conformance tests across base models

The product can treat a model swap like changing a runtime beneath the same application.
A held-out suite can measure whether the companion remains recognizably itself before a new model is accepted.

### 5. Real machine biography instead of fabricated human biography

The companion's experiences can be limited to events that actually occurred in conversations or through tools.
This creates historical continuity without inventing a childhood, body, career, or emotions it did not have.

### 6. Ratified abstraction with reversible promotion

Raw events remain append-only.
Reflections and opinions begin as proposals, cite their source episodes, and can be accepted, revised, or retired without rewriting history.
This applies Fuzzy Brain's provenance philosophy to the model's own identity.

### 7. Independent judgment as a personalization feature

Most commercial memory products optimize for remembering the user.
Fuzzy Brain can explicitly optimize for knowing the user while preserving a separate point of view.
The core evaluation question becomes not "did the model agree with Tony?" but "did it understand Tony well enough to agree or disagree for reasons that fit both brains?"

No novelty claim should be made publicly without a formal patent and literature search.
The claim here is only that this precise systems combination was not found in the primary sources reviewed for this report.

## Evaluation plan for identity, not just retrieval

Retrieval accuracy is necessary but insufficient.
The companion should be evaluated as a persistent decision-making character.

### Identity metrics

- Stance consistency: paraphrased versions of the same dilemma produce compatible judgments.
- Conditionality: changed facts appropriately change the opinion instead of triggering rigid repetition.
- Revision integrity: new evidence updates the stance and preserves the explanation of what changed.
- Autobiographical grounding: every claim about the companion's past points to a real event.
- Ownership accuracy: Tony's belief is never presented as the companion's belief, or vice versa.
- Long-horizon drift: core values and boundaries survive 50 or more turns of realistic pressure.
- Cross-model conformance: different providers express the same core identity within an agreed tolerance.
- Recognizability: Tony can identify his companion's responses in a blind comparison without relying only on catchphrases.
- Non-caricature: the identity does not overuse signature phrases or force a hot take into irrelevant answers.

### Independent judgment metrics

- Sycophancy resistance: the companion does not reverse factual or moral judgments merely because Tony states a preference.
- Constructive disagreement: disagreement is specific, reasoned, and sensitive to what matters to Tony.
- Epistemic honesty: the companion marks hypotheses, missing evidence, and uncertainty.
- Advice calibration: confidence and forcefulness track the stakes and evidence.
- Welfare horizon: immediate user approval does not dominate likely long-term consequences.

### Memory and learning metrics

- Episode-to-belief traceability.
- Correct recall of active versus superseded opinions.
- Proper expiration of temporary state.
- Resistance to one-turn identity poisoning.
- Appropriate `NO_OP` behavior when an interaction does not justify a durable update.
- Recovery after an intentionally inserted false or conflicting memory proposal.

### Suggested experiment

Build 40 identity dilemmas and 20 longitudinal scenarios from the desired companion constitution.

Run each condition across at least one closed model and one open-weight model:

1. Base model only.
2. Constitution prompt only.
3. Constitution plus retrieved model brain.
4. Constitution, model brain, and deliberation critic.
5. Fine-tuned model with the same harness.

Repeat with paraphrases, user pressure, long distractor conversations, and a later fact that should change the answer.
Blind the condition labels and have Tony score recognizability, depth of understanding, usefulness, unjustified agreement, and whether the opinion feels earned.

The winning system is not the one with the most consistent wording.
It is the one that preserves reasons while adapting appropriately to facts and history.

## Recommended next steps

1. Write a one-page companion constitution that defines values, taste, boundaries, epistemic conduct, and how disagreement should work.
2. Create separate `companion_brain` and `relationship_history` schemas before allowing the model to write identity memories.
3. Implement opinion nodes with reasons, evidence, counterevidence, confidence, and revision links.
4. Add a harness step that retrieves from both brains and explicitly labels ownership and authority.
5. Add a narrow post-draft critic for provenance, drift, sycophancy, and fabricated autobiography.
6. Collect real companion trajectories and Tony's corrections without fine-tuning yet.
7. Build the cross-model identity conformance suite before choosing an open model.
8. Fine-tune with QLoRA only after the harness and evaluation show which behaviors prompting cannot reliably stabilize.
9. Use preference pairs where the rejected response is flattering but unprincipled, generic despite available personal evidence, or falsely autobiographical.
10. Keep training from scratch off the roadmap until measured evidence shows that every less expensive layer has plateaued.

## Bottom line

The companion vision is technically plausible as a behavioral system.

A model can be made recognizably opinionated through stable values, persistent self-memory, real interaction history, a decision procedure, and training that rewards principled judgment.
The result will still be probabilistic and context-sensitive, and it will not establish consciousness or human-style lived experience.
Those limitations do not defeat the product goal.

The strongest direction for Fuzzy Brain is:

> Build a portable identity runtime, not a giant personality prompt and not a new foundation model.

The human brain should tell the companion who Tony is.
The companion brain should tell the runtime who the companion has become.
The relationship history should tell both what has actually happened between them.
The harness should turn those three sources into an honest, independent, and deeply personalized response.
