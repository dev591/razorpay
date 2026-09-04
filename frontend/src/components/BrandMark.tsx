import Image from "next/image";

/**
 * Razorpay's logomark beside the product name.
 *
 * The mark signals what this is built on and for; the name keeps the work
 * identifiably ours. Showing the mark *alone* would read as an official
 * Razorpay product, which this is not — the footer disclaimer exists for the
 * same reason and should stay wherever this is used.
 */
export default function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <span
      className="relative flex shrink-0 items-center justify-center transition-transform group-hover:scale-110"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <Image
        src="/razorpay-mark.png"
        alt=""
        width={72}
        height={87}
        priority
        style={{ width: "auto", height: size }}
      />
    </span>
  );
}

/**
 * The Razorpay wordmark without its logomark, for the "built for" lockups.
 * The icon is dropped deliberately: these sit next to `BrandMark`, and the
 * full lockup would show the same mark twice a centimetre apart.
 */
export function RazorpayWordmark({ height = 14 }: { height?: number }) {
  return (
    <Image
      src="/razorpay-wordmark.png"
      alt="Razorpay"
      width={464}
      height={94}
      style={{ width: "auto", height }}
    />
  );
}
