insert into brain_dev.recall_lab_relation_types
  (predicate, human_label, aliases, inverse_predicate, subject_kinds, object_kinds, is_temporal)
values
  ('partner_of', 'girlfriend', array['girlfriend', 'partner'], 'partner_of', array['person'], array['person'], true),
  ('lives_in', 'lives in', array['home', 'residence', 'based in'], null, array['person'], array['city'], true),
  ('located_in', 'located in', array['inside', 'part of'], 'contains', array['city'], array['state'], false)
on conflict (predicate) do nothing;

insert into brain_dev.recall_lab_episodes
  (id, source_kind, source_locator, raw, occurred_at, is_synthetic)
values
  ('10000000-0000-4000-8000-000000000001', 'synthetic_conversation', 'lab://conversation/residence',
   'My girlfriend Doan lives in Safford, Arizona.', '2026-07-10T12:00:00Z', true),
  ('10000000-0000-4000-8000-000000000002', 'synthetic_reference', 'lab://reference/safford',
   'Safford is a city in Arizona.', '2026-07-10T12:01:00Z', true),
  ('10000000-0000-4000-8000-000000000003', 'synthetic_conversation', 'lab://conversation/history',
   'Doan lived in Tucson before moving to Safford.', '2026-07-10T12:02:00Z', true),
  ('10000000-0000-4000-8000-000000000004', 'synthetic_conversation', 'lab://conversation/founder',
   'Tony is exploring what kind of company he wants to build.', '2026-07-10T12:03:00Z', true)
on conflict (id) do nothing;

insert into brain_dev.recall_lab_evidence_spans
  (id, episode_id, start_offset, end_offset, quote, source_locator)
values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 0, 45,
   'My girlfriend Doan lives in Safford, Arizona.', 'lab://conversation/residence#0-45'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 0, 29,
   'Safford is a city in Arizona.', 'lab://reference/safford#0-29'),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 0, 46,
   'Doan lived in Tucson before moving to Safford.', 'lab://conversation/history#0-46')
on conflict (id) do update set
  start_offset = excluded.start_offset,
  end_offset = excluded.end_offset,
  quote = excluded.quote,
  source_locator = excluded.source_locator;

insert into brain_dev.recall_lab_entities (id, kind, canonical_name, aliases)
values
  ('30000000-0000-4000-8000-000000000001', 'person', 'Tony', array['me', 'myself']),
  ('30000000-0000-4000-8000-000000000002', 'person', 'Doan', array['my girlfriend', 'my partner']),
  ('30000000-0000-4000-8000-000000000003', 'city', 'Safford', array[]::text[]),
  ('30000000-0000-4000-8000-000000000004', 'state', 'Arizona', array['AZ']),
  ('30000000-0000-4000-8000-000000000005', 'city', 'Tucson', array[]::text[])
on conflict (id) do nothing;

insert into brain_dev.recall_lab_claims
  (id, subject_entity_id, predicate, object_entity_id, evidence_span_id,
   authority, status, valid_from, valid_to, recorded_at)
values
  ('40000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000001', 'partner_of',
   '30000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-000000000001',
   'tony_ratified', 'ratified', '2025-01-01T00:00:00Z', null, '2026-07-10T12:00:00Z'),
  ('40000000-0000-4000-8000-000000000002',
   '30000000-0000-4000-8000-000000000002', 'lives_in',
   '30000000-0000-4000-8000-000000000003',
   '20000000-0000-4000-8000-000000000001',
   'tony_ratified', 'ratified', '2025-01-01T00:00:00Z', null, '2026-07-10T12:00:00Z'),
  ('40000000-0000-4000-8000-000000000003',
   '30000000-0000-4000-8000-000000000003', 'located_in',
   '30000000-0000-4000-8000-000000000004',
   '20000000-0000-4000-8000-000000000002',
   'source_asserted', 'ratified', null, null, '2026-07-10T12:01:00Z'),
  ('40000000-0000-4000-8000-000000000004',
   '30000000-0000-4000-8000-000000000002', 'lives_in',
   '30000000-0000-4000-8000-000000000005',
   '20000000-0000-4000-8000-000000000003',
   'tony_ratified', 'ratified', '2024-01-01T00:00:00Z', '2025-01-01T00:00:00Z', '2026-07-10T12:02:00Z')
on conflict (id) do nothing;

insert into brain_dev.recall_lab_search_documents
  (id, document_kind, source_id, body, embedding, metadata)
values
  ('50000000-0000-4000-8000-000000000001', 'sentence_only',
   '10000000-0000-4000-8000-000000000001',
   'Tony''s girlfriend Doan currently lives in Safford, Arizona.',
   '[1,0,0,0,0,0,0,0]',
   '{"variant":"sentence_only","anchor_entity_id":"30000000-0000-4000-8000-000000000002"}'),
  ('50000000-0000-4000-8000-000000000002', 'claim_projection',
   '40000000-0000-4000-8000-000000000002',
   'Doan, Tony''s partner, is based in Safford in Arizona.',
   '[0.99,0.01,0,0,0,0,0,0]',
   '{"variant":"hybrid","anchor_entity_id":"30000000-0000-4000-8000-000000000002"}'),
  ('50000000-0000-4000-8000-000000000003', 'claim_projection',
   '40000000-0000-4000-8000-000000000003',
   'Safford is located in the state of Arizona.',
   '[0.75,0,0.25,0,0,0,0,0]',
   '{"variant":"hybrid","anchor_entity_id":"30000000-0000-4000-8000-000000000003"}'),
  ('50000000-0000-4000-8000-000000000004', 'episode_projection',
   '10000000-0000-4000-8000-000000000004',
   'Tony is exploring startup and founder directions.',
   '[0,1,0,0,0,0,0,0]',
   '{"variant":"distractor"}')
on conflict (id) do nothing;

insert into brain_dev.recall_lab_resolution_paths
  (id, subject_entity_id, predicate, source_kind, source_locator,
   required_scope, authorized, lookup_hint, priority)
values
  ('60000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000002', 'exact_address',
   'delivery_history', 'connector://uber-eats/orders',
   'orders.read', true, 'Match the recipient, then inspect the latest Arizona delivery.', 10),
  ('60000000-0000-4000-8000-000000000002',
   '30000000-0000-4000-8000-000000000002', 'phone_number',
   'messages', 'connector://messages/conversation',
   'messages.read', false, 'Search the conversation only after access is approved.', 20)
on conflict (id) do nothing;
