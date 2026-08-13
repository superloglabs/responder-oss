import { useEffect, useState } from "react";

const chevron = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

const orbitOrder = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, index) => {
  const position = orbitOrder.indexOf(index);
  return position === -1 ? null : position * 110;
});

const patterns = {
  Drive: { delays: chevron, duration: 650, round: false },
  Dots: { delays: chevron, duration: 650, round: true },
  Orbit: { delays: orbit, duration: 950, round: false },
} as const;

type InvestigationThinkingVariant = keyof typeof patterns;

function useElapsed() {
  const [deciseconds, setDeciseconds] = useState(0);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setDeciseconds((current) => current + 1);
    }, 100);
    return () => window.clearInterval(interval);
  }, []);

  const totalSeconds = deciseconds / 10;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  return `${Math.floor(totalSeconds / 60)}m ${(totalSeconds % 60).toFixed(1)}s`;
}

export function InvestigationThinking({
  label = "Churning",
  variant = "Drive",
}: {
  label?: string;
  variant?: InvestigationThinkingVariant;
}) {
  const elapsed = useElapsed();
  const { delays, duration, round } = patterns[variant];

  return (
    <div className="investigationThinking" role="status">
      <span aria-hidden="true" className="investigationThinking__matrix">
        {delays.map((delay, index) => (
          <span
            className={`investigationThinking__dot${
              round ? " investigationThinking__dot--round" : ""
            }${
              delay === null ? " investigationThinking__dot--inactive" : ""
            }`}
            key={index}
            style={{
              animation:
                delay === null
                  ? "none"
                  : `investigationPixelOn ${duration}ms ease-in-out ${delay}ms infinite`,
              opacity: delay === null ? 0.07 : 0.15,
            }}
          />
        ))}
      </span>
      <span aria-hidden="true" className="investigationThinking__label">
        {label}
      </span>
      <span
        aria-hidden="true"
        className="investigationThinking__elapsed"
      >
        {elapsed}
      </span>
      <span className="srOnly">
        Investigation in progress. This page refreshes automatically.
      </span>
    </div>
  );
}
