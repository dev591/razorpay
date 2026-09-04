import MarketplaceSection from "@/components/sections/MarketplaceSection";

export const metadata = {
  title: "Vendors",
  description:
    "Every merchant the buyer agent bids against, and the catalog an AI buyer queries. Add your own and it joins the next negotiation.",
};

export default function VendorsPage() {
  return (
    <main className="flex-1">
      <MarketplaceSection />
    </main>
  );
}
