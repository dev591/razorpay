import MerchantConsole from "@/components/merchant/MerchantConsole";

export const metadata = {
  title: "Merchant",
  description:
    "The seller's side of a negotiated deal: approve the order, watch the payment land, confirm dispatch.",
};

export default function MerchantPage() {
  return (
    <main className="flex-1">
      <MerchantConsole />
    </main>
  );
}
