/** The wax outline, drawn once and reused by the wordmark, the letter seal and the cast record. */
export const WAX_PATH =
  "M96.3 56.8 Q96.2 63.6 92.0 68.9 Q87.8 74.3 83.5 79.0 Q79.2 83.7 74.4 88.3 Q69.6 92.9 63.3 95.8 Q57.0 98.7 50.3 96.7 Q43.6 94.7 37.0 93.8 Q30.4 93.0 24.7 89.4 Q19.0 85.7 15.1 80.4 Q11.1 75.0 6.6 69.5 Q2.1 64.1 2.7 57.0 Q3.3 50.0 3.8 43.3 Q4.3 36.6 8.4 31.2 Q12.4 25.8 16.3 20.8 Q20.3 15.7 24.8 10.1 Q29.2 4.5 36.3 4.0 Q43.3 3.5 49.8 5.1 Q56.2 6.7 62.9 7.0 Q69.5 7.3 74.8 11.3 Q80.0 15.4 86.5 18.9 Q93.0 22.4 94.3 29.5 Q95.6 36.6 96.1 43.3 Q96.5 50.0 96.3 56.8Z";

export function SealArt({ rings = true }: { rings?: boolean }) {
  return (
    <>
      <path className="wax" d={WAX_PATH} />
      {rings ? (
        <>
          <circle className="ring" cx="50" cy="50" r="35" />
          <circle className="ring" cx="50" cy="50" r="31.5" />
        </>
      ) : null}
      <text x="50" y="63" textAnchor="middle" fontSize="36" fontStyle="italic">
        M
      </text>
    </>
  );
}

/** A static seal. `unset` draws the dashed outline used before anything is sealed. */
export function Seal({
  unset = false,
  label,
  className = "",
}: {
  unset?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <svg
      className={`seal-mark ${unset ? "unset" : ""} ${className}`}
      viewBox="0 0 100 100"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <SealArt />
    </svg>
  );
}

export function Wordmark() {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <path fill="var(--seal)" stroke="var(--seal-edge)" strokeWidth="2.5" d={WAX_PATH} />
      <text
        x="50"
        y="66"
        textAnchor="middle"
        fontSize="46"
        fontStyle="italic"
        fill="var(--seal-ink)"
        fontFamily="var(--font-serif)"
      >
        M
      </text>
    </svg>
  );
}
