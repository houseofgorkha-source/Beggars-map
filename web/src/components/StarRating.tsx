type InputProps = {
  label: string;
  value: number;
  onChange: (value: number) => void;
};

export function StarRatingInput({ label, value, onChange }: InputProps) {
  return (
    <div className="star-input-row">
      <span className="star-input-label">{label}</span>
      <div className="star-input-stars">
        {[1, 2, 3, 4, 5].map((star) => (
          <span
            key={star}
            className={`star ${star <= value ? 'star-filled' : ''}`}
            onClick={() => onChange(star)}
          >
            ★
          </span>
        ))}
      </div>
    </div>
  );
}

type DisplayProps = {
  rating: number | null;
  count: number;
  small?: boolean;
};

export function StarRatingDisplay({ rating, count, small }: DisplayProps) {
  if (rating === null || count === 0) {
    return <span className={`star-display-empty ${small ? 'small' : ''}`}>No ratings yet</span>;
  }
  return (
    <span className={`star-display ${small ? 'small' : ''}`}>
      ★ {rating.toFixed(1)} ({count})
    </span>
  );
}
