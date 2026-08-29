import Logo from './Logo';

export default function AboutContent() {
  return (
    <>
      <div className="about-logo-block">
        <Logo size={60} />
        <span className="about-logo-word">Beggars Map</span>
      </div>

      <h2 className="about-lead">About Us</h2>
      <p className="about-body">
        <strong>Great food, ₹100 or less.</strong>
        <br />
        A map of Bengaluru’s most affordable eats, built by the people who eat there.
      </p>
      <p className="about-body">
        <strong>Tastiest. Healthiest. Best value for money.</strong>
        <br />
        Affordable shouldn’t mean settling for less.
      </p>
      <p className="about-body">
        <strong>One rule: ₹100.</strong>
        <br />
        If it costs more, it doesn’t go on the map.
      </p>
      <p className="about-body">
        <strong>Nothing here is for sale.</strong>
        <br />
        No ads. No promoted spots. No paying your way to the top.
      </p>

      <h2 className="about-lead">A Message to Our Community</h2>
      <p className="about-body">
        <strong>This map runs on you.</strong>
        <br />
        Every listing came from someone who took a minute to add it.
      </p>
      <p className="about-body">
        <strong>Tastiest? Healthiest? Best value for money? Under ₹100?</strong>
        <br />
        Then it belongs on the map. <strong>Add it.</strong>
      </p>
      <p className="about-body">
        <strong>Found a ₹60 breakfast? An ₹80 thali?</strong>
        <br />
        Put it on the map. It takes a minute.
      </p>
      <p className="about-body">
        <strong>Prices change. Places close.</strong>
        <br />
        If something is out of date, fix it. That’s what keeps this useful for everyone.
      </p>
      <p className="about-body">
        <strong>You don’t need to be a critic.</strong>
        <br />
        Just know good value when you find it.
      </p>

      <p className="about-tagline">Found by the community. Kept true by the community.</p>
    </>
  );
}
