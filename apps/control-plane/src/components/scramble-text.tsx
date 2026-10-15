import { useScrambledText } from "../use-scrambled-text";

// Screen readers get the text once, without the symbols.
export function ScrambleText({ animateOnMount, text }: { animateOnMount?: boolean; text: string }) {
  const shown = useScrambledText(text, animateOnMount);
  return (
    <>
      <span aria-hidden="true">{shown}</span>
      <span className="srOnly">{text}</span>
    </>
  );
}
