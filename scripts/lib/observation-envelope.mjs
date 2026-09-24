// These wrappers describe another session; their user-role transport is not authorship.
// Keep the prefix shared with PostgreSQL so old evidence and future captures agree.
export const observationEnvelopePattern = String.raw`^\s*(Hello memory agent,[^\n]*\s+)?<observed_from_primary_session>`;
const envelope = new RegExp(observationEnvelopePattern);

export function isObservationEnvelope(text) {
  return envelope.test(text);
}
