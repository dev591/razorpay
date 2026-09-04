import NegotiationConsole from "@/components/console/NegotiationConsole";

export const metadata = {
  title: "Try it",
  description:
    "Compose an intent, approve it, and watch merchant agents negotiate a real order — bounded, gated and recorded end to end.",
};

/** The console, full page. The landing page explains it; this is where it runs. */
export default function TryItPage() {
  return (
    <main className="flex-1">
      <NegotiationConsole />
    </main>
  );
}
