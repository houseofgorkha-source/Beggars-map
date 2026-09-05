import { Candidate, isReviewed } from '../lib/discoveryApi';

export type CandidateFilter = 'all' | 'reviewed' | 'unreviewed' | 'no-answer';

type Props = {
  candidates: Candidate[];
  selectedPlaceId: string | null;
  onSelect: (placeId: string) => void;
  filter: CandidateFilter;
  onFilterChange: (filter: CandidateFilter) => void;
  search: string;
  onSearchChange: (search: string) => void;
};

// Plain, unpaginated list — batches are ≤~100 rows (default 50), so the
// admin panel's offset-pagination (ListingsList.tsx's PAGE_SIZE/page pager)
// solves a scale problem that doesn't exist here and isn't borrowed.
export default function CandidateList({ candidates, selectedPlaceId, onSelect, filter, onFilterChange, search, onSearchChange }: Props) {
  return (
    <div className="discovery-list">
      <div className="admin-filters">
        <input
          className="admin-input"
          placeholder="Search by name…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        <select className="admin-select" value={filter} onChange={(e) => onFilterChange(e.target.value as CandidateFilter)}>
          <option value="all">All</option>
          <option value="reviewed">Reviewed</option>
          <option value="unreviewed">Unreviewed</option>
          <option value="no-answer">No Answer</option>
        </select>
      </div>
      <ul className="discovery-candidate-list">
        {candidates.map((candidate) => {
          const reviewed = isReviewed(candidate);
          return (
            <li key={candidate.place_id}>
              <button
                type="button"
                className={`discovery-candidate-row ${candidate.place_id === selectedPlaceId ? 'discovery-candidate-row-selected' : ''}`}
                onClick={() => onSelect(candidate.place_id)}
              >
                <span className={reviewed ? 'discovery-status-done' : 'discovery-status-pending'}>{reviewed ? '✓' : '○'}</span>
                <span className="discovery-candidate-name">{candidate.name}</span>
              </button>
            </li>
          );
        })}
        {candidates.length === 0 ? <li className="admin-muted discovery-list-empty">No candidates match.</li> : null}
      </ul>
    </div>
  );
}
