import AboutContent from './AboutContent';

type Props = {
  onClose: () => void;
};

export default function AboutModal({ onClose }: Props) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal about-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>About</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body about-modal-body">
          <AboutContent />
        </div>
      </div>
    </div>
  );
}
