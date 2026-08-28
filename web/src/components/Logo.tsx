type Props = {
  size?: number;
};

// The mark: one continuous stroke — a vertical spine (the B's vertical
// line), then two rounded arches sharing that exact spine coordinate at
// their start/end points, so they read as fused to it rather than floating
// nearby. Those two arches are a lowercase "m"'s two rounded humps, rotated
// 90° so they stack vertically instead of sitting side by side — turning
// "stem + two humps" into "spine + two bowls," which is what a B is.
//
// viewBox is cropped tight to the actual stroked ink (not the full 64x64
// drawing space) so the rendered box has no built-in padding — otherwise a
// small CSS gap next to this element still looks like a big gap, because
// the empty margin inside the SVG counts too.
export default function Logo({ size = 28 }: Props) {
  return (
    <svg width={size} height={size} viewBox="8 2 48 60" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M14,8 L14,56 M14,8 C50,8 50,26 14,32 M14,32 C50,38 50,50 14,56"
        stroke="var(--pink-accent)"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
