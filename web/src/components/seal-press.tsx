"use client";

import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { SealArt } from "./seal";

/**
 * The one orchestrated moment: the seal presses onto the paper. On the letter it plays on load; on the docket it
 * plays when the Delegate's Cast arrives. Reduced motion shows the pressed seal without the press.
 */
export function SealPress({
  label,
  delay = 0.3,
  className = "",
}: {
  label: string;
  delay?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <LazyMotion features={domAnimation} strict>
      <m.svg
        className={`seal-mark ${className}`}
        viewBox="0 0 100 100"
        role="img"
        aria-label={label}
        initial={reduce ? false : { scale: 1.18, opacity: 0, rotate: -8 }}
        animate={{ scale: [1.18, 0.97, 1], opacity: [0, 1, 1], rotate: -8 }}
        transition={
          reduce ? { duration: 0 } : { duration: 0.42, times: [0, 0.6, 1], ease: [0.2, 0.8, 0.2, 1], delay }
        }
      >
        <SealArt />
      </m.svg>
    </LazyMotion>
  );
}
