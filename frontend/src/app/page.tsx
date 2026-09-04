import Hero from "@/components/Hero";
import HowItWorks from "@/components/sections/HowItWorks";
import Guarantees from "@/components/sections/Guarantees";
import ClosingCTA from "@/components/sections/ClosingCTA";

/**
 * The landing page explains; it doesn't operate.
 *
 * It used to embed the whole console and the vendor editor, which meant the
 * two things you can actually *do* had no address of their own and no room to
 * breathe. They now live at /try and /vendors, and this page does the job a
 * landing page is for: say what the system guarantees, and show the real
 * numbers it has produced, before handing you a door.
 */
export default function Home() {
  return (
    <main className="flex-1">
      <Hero />
      <HowItWorks />
      <Guarantees />
      <ClosingCTA />
    </main>
  );
}
