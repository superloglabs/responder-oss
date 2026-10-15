import { useEffect, useState } from "react";

// Symbols that stand in for characters not revealed yet.
const scrambleCharacters = "-_~`!@#$%^&*()+=[]{}|;:,.<>?";
const stepMilliseconds = 32;
// Long text reveals several characters per step, so none takes much over 1.5 s.
const maxSteps = 48;

// The text with its first `revealed` characters shown and the rest masked by
// symbols. Whitespace stays in place. The symbols change with each step.
export function scrambleFrame(text: string, revealed: number): string {
  return Array.from(text, (character, index) => {
    if (index < revealed || /\s/u.test(character)) return character;
    const symbol = (character.charCodeAt(0) * 31 + index * 17 + revealed * 13) % scrambleCharacters.length;
    return scrambleCharacters[symbol];
  }).join("");
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

// Reveals the text left to right from behind symbols each time it changes,
// and when it first appears if `animateOnMount` is set.
export function useScrambledText(text: string, animateOnMount = false): string {
  const [progress, setProgress] = useState(() => ({
    revealed: animateOnMount && !prefersReducedMotion() ? 0 : text.length,
    text,
  }));
  const revealed = progress.text === text ? progress.revealed : prefersReducedMotion() ? text.length : 0;
  const scrambling = revealed < text.length;
  useEffect(() => {
    if (!scrambling) return;
    const step = Math.max(1, Math.ceil(text.length / maxSteps));
    const timer = window.setInterval(() => {
      setProgress((current) => ({ revealed: (current.text === text ? current.revealed : 0) + step, text }));
    }, stepMilliseconds);
    return () => window.clearInterval(timer);
  }, [scrambling, text]);
  return scrambling ? scrambleFrame(text, revealed) : text;
}
