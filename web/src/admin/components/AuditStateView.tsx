// Renders an audit log entry's before_state/after_state pair. Used by both
// ListingDetail's per-listing history and AuditLog's global table so the
// two never drift apart on how this is presented.
//
// The raw data was never the problem — before_state/after_state are always
// present and correct (full listing-row snapshots, or the smaller
// {reason, affected_report_ids, ...} shape for resolve_report). The bug
// was purely presentational: a bare <details><summary>before / after
// </summary> gives zero visible content until clicked, and a collapsed
// row with nothing under it reads as broken/empty rather than
// "click to expand" — confirmed directly (expanding it always showed the
// real ~2KB of JSON that was there all along). Fixing this by summarizing
// which fields actually changed *in the collapsed summary text itself*,
// so there's something to see before ever clicking, with the full raw
// JSON still available one click away — no data is hidden or dropped,
// only better organized.

type Props = {
  beforeState: unknown;
  afterState: unknown;
  requestMetadata?: unknown;
};

const NOISY_KEYS = new Set(['updated_at']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function changedFields(before: unknown, after: unknown): string[] {
  if (!isPlainObject(before) || !isPlainObject(after)) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (NOISY_KEYS.has(key)) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changed.push(key);
  }
  return changed.sort();
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v.length > 60 ? v.slice(0, 60) + '…' : v;
  return JSON.stringify(v);
}

export default function AuditStateView({ beforeState, afterState, requestMetadata }: Props) {
  const isCreate = beforeState === null || beforeState === undefined;
  const changed = isCreate ? [] : changedFields(beforeState, afterState);

  const summary = isCreate
    ? 'Created — view details'
    : changed.length === 0
      ? 'No field changes recorded — view raw data'
      : `Changed: ${changed.join(', ')}`;

  return (
    <details className="admin-audit-state">
      <summary>{summary}</summary>

      {!isCreate && changed.length > 0 ? (
        <table className="admin-diff-table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            {changed.map((key) => (
              <tr key={key}>
                <td className="admin-mono">{key}</td>
                <td>{formatValue((beforeState as Record<string, unknown>)[key])}</td>
                <td>{formatValue((afterState as Record<string, unknown>)[key])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <details className="admin-audit-raw">
        <summary>Full raw before / after JSON</summary>
        <pre className="admin-json">
          {JSON.stringify(
            requestMetadata === undefined
              ? { before: beforeState, after: afterState }
              : { before: beforeState, after: afterState, request: requestMetadata },
            null,
            2
          )}
        </pre>
      </details>
    </details>
  );
}
