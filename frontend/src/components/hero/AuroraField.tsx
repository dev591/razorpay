"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import {
  Canvas,
  extend,
  useFrame,
  useThree,
  type ThreeElement,
} from "@react-three/fiber";
import { shaderMaterial } from "@react-three/drei";
import {
  auroraFragment,
  auroraVertex,
  packetFragment,
  packetVertex,
} from "@/components/hero/shaders/aurora";

/**
 * The hero's ground, as a declarative R3F scene: a full-bleed mesh-gradient
 * aurora plus a GPU-animated packet stream (the buyer -> merchant wire, read
 * abstractly).
 *
 * Deliberately WHITE-grounded rather than the usual dark-hero treatment —
 * razorpay.com is a light site, so the blues have to sit as accents on paper
 * or the page stops reading as Razorpay. The shader vignettes back to pure
 * white at the edges so the canvas has no visible boundary against the page.
 *
 * `progress` (0 -> 1, from the hero's scroll scrub) zooms the field and pushes
 * packets outward past the camera — the "travelling into the page" beat.
 */

const AuroraMaterial = shaderMaterial(
  {
    uTime: 0,
    uAspect: 1,
    uProgress: 0,
    uIntensity: 1,
    uPointer: new THREE.Vector2(0, 0),
  },
  auroraVertex,
  auroraFragment
);

const PacketMaterial = shaderMaterial(
  { uTime: 0, uAspect: 1, uProgress: 0, uDpr: 1 },
  packetVertex,
  packetFragment
);

extend({ AuroraMaterial, PacketMaterial });

declare module "@react-three/fiber" {
  interface ThreeElements {
    auroraMaterial: ThreeElement<typeof AuroraMaterial>;
    packetMaterial: ThreeElement<typeof PacketMaterial>;
  }
}

type AuroraUniforms = THREE.ShaderMaterial & {
  uTime: number;
  uAspect: number;
  uProgress: number;
  uPointer: THREE.Vector2;
};

type PacketUniforms = THREE.ShaderMaterial & {
  uTime: number;
  uAspect: number;
  uProgress: number;
  uDpr: number;
};

/**
 * Pointer is tracked on `window` rather than through R3F's own event system:
 * the canvas sits at -z behind the hero copy, so it never receives pointer
 * events of its own.
 */
function usePagePointer(enabled: boolean) {
  const target = useRef(new THREE.Vector2(0, 0));

  useEffect(() => {
    if (!enabled) return;
    const onMove = (event: PointerEvent) => {
      target.current.set(
        (event.clientX / window.innerWidth - 0.5) * 2,
        -(event.clientY / window.innerHeight - 0.5) * 2
      );
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [enabled]);

  return target;
}

function Aurora({
  progress,
  animate,
}: {
  progress: number;
  animate: boolean;
}) {
  const ref = useRef<AuroraUniforms>(null);
  const { size } = useThree();
  const pointer = usePagePointer(animate);

  useFrame((state) => {
    const mat = ref.current;
    if (!mat) return;
    mat.uAspect = size.width / size.height;
    if (animate) {
      mat.uTime = state.clock.elapsedTime;
      mat.uPointer.lerp(pointer.current, 0.045);
    }
    // Ease toward the scrubbed value so a flung scroll doesn't snap the field.
    mat.uProgress += (progress - mat.uProgress) * 0.08;
  });

  return (
    <mesh frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <auroraMaterial ref={ref} />
    </mesh>
  );
}

const PACKET_COUNT = 120;

/**
 * mulberry32 — a fixed-seed PRNG so packet attributes are deterministic.
 * `Math.random()` during render is impure (and would differ between the
 * server and client render); a stable seed also means a shader tweak can be
 * compared against the previous frame with the same particle layout.
 */
function makeRandom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function PacketStream({
  progress,
  animate,
}: {
  progress: number;
  animate: boolean;
}) {
  const ref = useRef<PacketUniforms>(null);
  const { size, viewport } = useThree();

  const attrs = useMemo(() => {
    const seeds = new Float32Array(PACKET_COUNT);
    const lanes = new Float32Array(PACKET_COUNT);
    const speeds = new Float32Array(PACKET_COUNT);
    const sizes = new Float32Array(PACKET_COUNT);
    const random = makeRandom(0x9f3ca71e);
    for (let i = 0; i < PACKET_COUNT; i += 1) {
      seeds[i] = random();
      // Cluster lanes toward the middle band where the negotiation UI sits.
      lanes[i] = (random() - 0.5) * 2 * random();
      speeds[i] = 0.5 + random() * 1.4;
      sizes[i] = 1.5 + random() * 4.5;
    }
    return {
      // Points still need `position` to establish the draw count, even though
      // the vertex shader ignores it and derives xy from uTime.
      position: new Float32Array(PACKET_COUNT * 3),
      seeds,
      lanes,
      speeds,
      sizes,
    };
  }, []);

  useFrame((state) => {
    const mat = ref.current;
    if (!mat) return;
    mat.uAspect = size.width / size.height;
    mat.uDpr = viewport.dpr;
    if (animate) mat.uTime = state.clock.elapsedTime;
    mat.uProgress += (progress - mat.uProgress) * 0.08;
  });

  return (
    <points frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[attrs.position, 3]}
        />
        <bufferAttribute attach="attributes-aSeed" args={[attrs.seeds, 1]} />
        <bufferAttribute attach="attributes-aLane" args={[attrs.lanes, 1]} />
        <bufferAttribute attach="attributes-aSpeed" args={[attrs.speeds, 1]} />
        <bufferAttribute attach="attributes-aSize" args={[attrs.sizes, 1]} />
      </bufferGeometry>
      <packetMaterial ref={ref} transparent depthWrite={false} />
    </points>
  );
}

export default function AuroraField({
  className,
  progress = 0,
}: {
  className?: string;
  progress?: number;
}) {
  // Resolved after mount so server and first client render agree; the field
  // animates only once we know the user hasn't asked us not to.
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setAnimate(!media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  return (
    <div className={className} aria-hidden="true">
      <Canvas
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        // Positions are written straight to clip space in both vertex shaders,
        // so the camera is a formality — no projection to keep in sync.
        camera={{ position: [0, 0, 1] }}
        style={{ width: "100%", height: "100%", display: "block" }}
      >
        <Aurora progress={progress} animate={animate} />
        <PacketStream progress={progress} animate={animate} />
      </Canvas>
    </div>
  );
}
