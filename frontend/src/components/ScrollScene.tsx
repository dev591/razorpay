"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Reveal from "@/components/Reveal";

gsap.registerPlugin(ScrollTrigger);

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const NARROW = "(max-width: 767px)";

function subscribeToMode(onChange: () => void) {
  const reduced = window.matchMedia(REDUCED_MOTION);
  const narrow = window.matchMedia(NARROW);
  reduced.addEventListener("change", onChange);
  narrow.addEventListener("change", onChange);
  return () => {
    reduced.removeEventListener("change", onChange);
    narrow.removeEventListener("change", onChange);
  };
}

/** Pinned scrubbing is skipped on narrow viewports and under reduced motion. */
function isScrubbable() {
  return (
    !window.matchMedia(REDUCED_MOTION).matches &&
    !window.matchMedia(NARROW).matches
  );
}

/**
 * `null` on the server and during hydration, then the resolved mode. Reading
 * the media queries through a store (rather than setting state in an effect)
 * keeps the server and hydration renders identical and lets a viewport
 * resize or an OS motion-preference change re-mode the scene live.
 */
function useScrubbed(): boolean | null {
  return useSyncExternalStore(subscribeToMode, isScrubbable, () => null);
}

type ScrollSceneProps = {
  id?: string;
  /** How much scroll (in viewport heights) it takes to play through progress 0 -> 1. */
  durationVh?: number;
  /** Applied to the pinned (desktop) or plain (mobile fallback) content wrapper. */
  className?: string;
  /**
   * Whether the non-scrubbed fallback fades in on scroll. Above-the-fold
   * scenes must set this false: `Reveal` renders at `opacity: 0` until its
   * ScrollTrigger fires, which for a scene already in view means it may never
   * fire at all.
   */
  reveal?: boolean;
  children: (props: { progress: number; scrubbed: boolean }) => ReactNode;
};

/**
 * Pins its content via CSS `position: sticky` (cheap, reliable across browsers)
 * while a GSAP ScrollTrigger tracks scroll progress through a tall "track" element
 * and hands it to `children` as a 0->1 value — like scrubbing a video.
 *
 * Falls back to a plain, non-pinned `<Reveal>`'d section on narrow viewports or
 * reduced-motion, where pinned scrubbing is more failure-prone and less necessary.
 * `scrubbed` tells the scene which mode it's in — a scene MUST render a complete,
 * legible static layout when `scrubbed` is false rather than assuming any particular
 * `progress` value looks like a sensible resting state (it usually doesn't).
 */
export default function ScrollScene({
  id,
  durationVh = 150,
  className,
  reveal = true,
  children,
}: ScrollSceneProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState(0);
  const scrubbed = useScrubbed();

  useEffect(() => {
    if (!scrubbed) return;
    const track = trackRef.current;
    if (!track) return;

    const trigger = ScrollTrigger.create({
      trigger: track,
      start: "top top",
      end: "bottom bottom",
      scrub: true,
      onUpdate: (self) => setProgress(self.progress),
    });

    return () => trigger.kill();
  }, [scrubbed]);

  // Before the mode is known — which includes the server render and first
  // paint — emit the plain static layout rather than an empty spacer. Every
  // scene must already render a complete layout at `scrubbed: false`, so this
  // costs nothing, and it means the page ships real content to crawlers and
  // paints its LCP element without waiting on JS.
  if (scrubbed === null) {
    return (
      <div id={id} className={className}>
        {children({ progress: 0, scrubbed: false })}
      </div>
    );
  }

  if (!scrubbed) {
    const content = (
      <div id={id} className={className}>
        {children({ progress: 0, scrubbed: false })}
      </div>
    );
    return reveal ? <Reveal>{content}</Reveal> : content;
  }

  return (
    <div
      id={id}
      ref={trackRef}
      className="relative"
      style={{ height: `${durationVh}vh` }}
    >
      <div
        className={className}
        style={{ position: "sticky", top: 0, height: "100vh", overflow: "hidden" }}
      >
        {children({ progress, scrubbed: true })}
      </div>
    </div>
  );
}
