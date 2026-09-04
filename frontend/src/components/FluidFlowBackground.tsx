"use client";

import { useEffect, useRef } from "react";

type Particle = {
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  age: number;
  maxAge: number;
};

const PARTICLE_DENSITY = 1 / 8000; // particles per px^2
const MAX_PARTICLES = 170;
const SPEED = 2.4;
const FIELD_SCALE = 0.0022;

function fieldAngle(x: number, y: number, t: number): number {
  return (
    Math.sin(x * FIELD_SCALE + t * 0.00012) * 1.4 +
    Math.cos(y * FIELD_SCALE * 1.3 - t * 0.00009) * 1.1 +
    Math.sin((x + y) * FIELD_SCALE * 0.6 + t * 0.00015) * 0.6
  );
}

function makeParticle(width: number, height: number): Particle {
  const x = Math.random() * width;
  const y = Math.random() * height;
  return {
    x,
    y,
    prevX: x,
    prevY: y,
    age: Math.random() * 140,
    maxAge: 110 + Math.random() * 110,
  };
}

/**
 * Calm, neutral-blue directional flow field on a deep navy ground.
 * Renders a single static frame under prefers-reduced-motion instead of animating.
 */
export default function FluidFlowBackground({
  className,
}: {
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    let width = 0;
    let height = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let particles: Particle[] = [];
    let animationFrame = 0;
    let resizeObserver: ResizeObserver | null = null;

    function resize() {
      const el = canvas!.parentElement;
      if (!el) return;
      width = el.clientWidth;
      height = el.clientHeight;
      canvas!.width = width * dpr;
      canvas!.height = height * dpr;
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.min(
        MAX_PARTICLES,
        Math.round(width * height * PARTICLE_DENSITY)
      );
      particles = Array.from({ length: count }, () =>
        makeParticle(width, height)
      );

      drawStaticGrid();
    }

    function drawStaticGrid() {
      // Faint dashed grid, drawn once into a background gradient — cheap depth cue.
      ctx!.save();
      ctx!.clearRect(0, 0, width, height);
      const gradient = ctx!.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, "#050b1a");
      gradient.addColorStop(1, "#0a1530");
      ctx!.fillStyle = gradient;
      ctx!.fillRect(0, 0, width, height);

      ctx!.strokeStyle = "rgba(107, 130, 255, 0.08)";
      ctx!.setLineDash([2, 6]);
      ctx!.lineWidth = 1;
      const gap = 48;
      for (let x = 0; x < width; x += gap) {
        ctx!.beginPath();
        ctx!.moveTo(x, 0);
        ctx!.lineTo(x, height);
        ctx!.stroke();
      }
      for (let y = 0; y < height; y += gap) {
        ctx!.beginPath();
        ctx!.moveTo(0, y);
        ctx!.lineTo(width, y);
        ctx!.stroke();
      }
      ctx!.setLineDash([]);
      ctx!.restore();
    }

    function step(t: number) {
      // Fade previous frame's streaks slightly instead of clearing, for a trailing look.
      ctx!.fillStyle = "rgba(5, 11, 26, 0.045)";
      ctx!.fillRect(0, 0, width, height);

      for (const p of particles) {
        p.prevX = p.x;
        p.prevY = p.y;

        const angle = fieldAngle(p.x, p.y, t);
        p.x += Math.cos(angle) * SPEED;
        p.y += Math.sin(angle) * SPEED;
        p.age += 1;

        const outOfBounds =
          p.x < -20 || p.x > width + 20 || p.y < -20 || p.y > height + 20;

        if (p.age > p.maxAge || outOfBounds) {
          Object.assign(p, makeParticle(width, height), { age: 0 });
          continue;
        }

        const lifeRatio = p.age / p.maxAge;
        const alpha = Math.sin(lifeRatio * Math.PI) * 0.8;

        ctx!.strokeStyle = `rgba(166, 180, 255, ${alpha})`;
        ctx!.lineWidth = 1.2;
        ctx!.beginPath();
        ctx!.moveTo(p.prevX, p.prevY);
        ctx!.lineTo(p.x, p.y);
        ctx!.stroke();
      }

      animationFrame = requestAnimationFrame(step);
    }

    resize();

    if (typeof ResizeObserver !== "undefined" && canvas.parentElement) {
      resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(canvas.parentElement);
    } else {
      window.addEventListener("resize", resize);
    }

    if (prefersReducedMotion) {
      drawStaticGrid();
    } else {
      animationFrame = requestAnimationFrame(step);
    }

    return () => {
      cancelAnimationFrame(animationFrame);
      if (resizeObserver) resizeObserver.disconnect();
      else window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden="true"
    />
  );
}
