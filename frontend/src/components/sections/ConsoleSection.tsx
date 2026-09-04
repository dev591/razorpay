import NegotiationConsole from "@/components/console/NegotiationConsole";

/** Section 2: the product itself, inline — no navigation required to reach it. */
export default function ConsoleSection() {
  return (
    <section id="try" className="scroll-mt-24 border-t border-line/70">
      <NegotiationConsole embedded />
    </section>
  );
}
