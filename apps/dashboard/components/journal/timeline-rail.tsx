"use client";

// The journal's timeline rail (spec 077 PR D): where you are in the chronology, at a
// glance. Copper hardware (the rail, the ticks) with exactly one lit element — the
// position marker, the page's single rubric-accent glow (the One Illuminated Element
// Rule). It follows your scroll, and it is a control too: click or drag along it to
// travel through time, or focus it and use the arrow keys (it is an ARIA slider over
// the journal's periods).
//
// Vertical beside the reading column on wide screens; a horizontal strip under the
// readout on narrow ones. Motion is a short glide that honours reduced motion.

import { useRef } from "react";
import { type RailTick, railPosition } from "./timeline";

export interface RailHit {
  id: string;
  daysAgo: number;
  label: string;
}

interface Props {
  orientation: "vertical" | "horizontal";
  span: number;
  ticks: RailTick[];
  /** Where the reader is, in fractional days ago. */
  readerDaysAgo: number;
  /** Search matches to plot as quiet ink marks. */
  hits: RailHit[];
  /** Slider semantics over the periods (newest = 0). */
  index: number;
  count: number;
  valueText: string;
  /** Travel to a rail position (0 = today … 1 = oldest). `dragging` skips smooth scroll. */
  onSeek: (position: number, dragging: boolean) => void;
  /** Step to a neighbouring period: +1 older, −1 newer; or jump to an end. */
  onStep: (delta: number | "newest" | "oldest") => void;
  onHit: (id: string) => void;
}

export function TimelineRail({
  orientation,
  span,
  ticks,
  readerDaysAgo,
  hits,
  index,
  count,
  valueText,
  onSeek,
  onStep,
  onHit,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const vertical = orientation === "vertical";
  const pct = (daysAgo: number) => `${(railPosition(daysAgo, span) * 100).toFixed(3)}%`;
  const at = (daysAgo: number) => (vertical ? { top: pct(daysAgo) } : { left: pct(daysAgo) });

  const positionFor = (event: React.PointerEvent): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return vertical
      ? (event.clientY - rect.top) / rect.height
      : (event.clientX - rect.left) / rect.width;
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const keys: Record<string, number | "newest" | "oldest"> = vertical
      ? { ArrowDown: 1, ArrowUp: -1, PageDown: 3, PageUp: -3, Home: "newest", End: "oldest" }
      : { ArrowRight: 1, ArrowLeft: -1, PageDown: 3, PageUp: -3, Home: "newest", End: "oldest" };
    const step = keys[event.key];
    if (step === undefined) return;
    event.preventDefault();
    onStep(step);
  };

  const marker = railPosition(readerDaysAgo, span) * 100;

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Journal timeline"
      aria-orientation={orientation}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, count - 1)}
      aria-valuenow={index}
      aria-valuetext={valueText}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        onSeek(positionFor(event), false);
      }}
      onPointerMove={(event) => {
        if (dragging.current) onSeek(positionFor(event), true);
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      className={`group relative cursor-pointer touch-none select-none focus:outline-none ${
        vertical ? "h-full w-full" : "h-12 w-full"
      }`}
    >
      <div
        ref={trackRef}
        className={
          vertical ? "absolute bottom-2 left-3 top-2 w-px" : "absolute left-2 right-2 top-3 h-px"
        }
      >
        {/* The rail itself — copper hardware. */}
        <span
          aria-hidden
          className={`absolute bg-ink-copper-soft ${vertical ? "inset-y-0 left-0 w-px" : "inset-x-0 top-0 h-px"}`}
        />
        {/* Time already travelled, from today to where you are: ink, quiet. */}
        <span
          aria-hidden
          className={`journal-glide absolute bg-foreground/45 ${vertical ? "left-0 top-0 w-px" : "left-0 top-0 h-px"}`}
          style={vertical ? { height: `${marker}%` } : { width: `${marker}%` }}
        />

        {ticks.map((tick) => (
          <span
            key={tick.label}
            aria-hidden
            className="absolute"
            style={{
              ...at(tick.daysAgo),
              transform: vertical ? "translateY(-50%)" : "translateX(-50%)",
            }}
          >
            <span
              className={`block ${tick.boundary ? "bg-ink-copper" : "bg-ink-copper-soft"} ${
                vertical
                  ? `h-px ${tick.boundary ? "w-3" : "w-2"}`
                  : `w-px ${tick.boundary ? "h-3" : "h-2"}`
              }`}
            />
            <span
              className={`absolute whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.08em] text-foreground/70 ${
                vertical ? "left-5 top-1/2 -translate-y-1/2" : "left-1/2 top-3 -translate-x-1/2"
              }`}
            >
              {tick.label}
            </span>
          </span>
        ))}

        {hits.map((hit) => (
          <button
            key={hit.id}
            type="button"
            tabIndex={-1}
            title={hit.label}
            aria-label={`Jump to match: ${hit.label}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onHit(hit.id)}
            className="absolute -translate-x-1/2 -translate-y-1/2 p-1"
            style={at(hit.daysAgo)}
          >
            <span className="block h-1.5 w-1.5 rounded-full bg-foreground/60 transition-transform hover:scale-150" />
          </button>
        ))}

        {/* You are here — the one illuminated element on the page. */}
        <span
          aria-hidden
          className="journal-glide pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
          style={vertical ? { top: `${marker}%`, left: 0 } : { left: `${marker}%`, top: 0 }}
        >
          <span className="glow-accent flex h-4 w-4 items-center justify-center rounded-full border-2 border-ink-accent bg-background group-focus-visible:ring-2 group-focus-visible:ring-ink-accent group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-background">
            <span className="h-1.5 w-1.5 rounded-full bg-ink-accent" />
          </span>
        </span>
      </div>
    </div>
  );
}
