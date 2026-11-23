import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { photoOfTheDay } from "../../assets/home/photos";
import { dayOfYear, formatLocalDate, logicalDay } from "../../lib/day";
import { readCachedHomePhoto } from "../../lib/home-photos";
import { resolveTimeZone, systemTimeZone } from "../../lib/time";
import { useAppStore } from "../../stores/app.store";
import styles from "./EndOfDayTransition.module.css";

/**
 * État de navigation passé à `/end-of-day` quand on y arrive via la transition : l'écran fait
 * alors apparaître ses éléments en fondu lent (et pas lors d'une arrivée directe).
 */
export const END_OF_DAY_FADE_STATE = { endOfDayEntry: "fade" } as const;

export function isEndOfDayFadeState(state: unknown): boolean {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as { endOfDayEntry?: unknown }).endOfDayEntry === "fade"
  );
}

/** Durée de la tombée de la nuit (doit rester alignée avec la CSS). */
const DUSK_MS = 750;

export interface EndOfDayTransitionProps {
  /** Appelé quand le décor de nuit couvre entièrement la fenêtre : on peut naviguer. */
  onCovered: () => void;
}

/**
 * Transition « tombée de la nuit » vers l'écran de fin de journée : le décor de nuit (même photo,
 * mêmes voiles que l'écran d'arrivée) apparaît en fondu par-dessus l'écran actuel, puis la
 * navigation a lieu quand il est totalement opaque. L'écran d'arrivée n'a donc qu'à faire
 * apparaître son contenu : aucun saut, aucun flash.
 */
export function EndOfDayTransition({ onCovered }: EndOfDayTransitionProps) {
  const config = useAppStore((state) => state.config);
  const dayState = useAppStore((state) => state.dayState);
  const [ready, setReady] = useState(false);
  const doneRef = useRef(false);
  const onCoveredRef = useRef(onCovered);
  onCoveredRef.current = onCovered;

  const now = new Date();
  const { timeZone } = resolveTimeZone(systemTimeZone());
  const logicalDate =
    config && dayState
      ? logicalDay(now, config.dayStartHour, timeZone)
      : formatLocalDate(now, timeZone);
  const photoSrc =
    readCachedHomePhoto(logicalDate)?.src ?? photoOfTheDay(dayOfYear(now, timeZone)).src;

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCoveredRef.current();
  };

  // Charge et décode la photo avant de lancer le fondu : elle ne doit jamais « popper ».
  // biome-ignore lint/correctness/useExhaustiveDependencies: `finish` ne dépend que de refs.
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }
    let cancelled = false;
    const start = () => {
      if (!cancelled) setReady(true);
    };
    const img = new Image();
    img.src = photoSrc;
    if (typeof img.decode === "function") {
      img.decode().then(start, start);
    } else {
      img.onload = start;
      img.onerror = start;
    }
    const startTimer = window.setTimeout(start, 700);
    // Filet de sécurité : on navigue même si `animationend` n'est jamais émis.
    const safetyTimer = window.setTimeout(finish, 700 + DUSK_MS + 500);
    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      window.clearTimeout(safetyTimer);
    };
  }, [photoSrc]);

  return createPortal(
    <div
      className={[styles.overlay, ready ? styles.running : ""].filter(Boolean).join(" ")}
      aria-hidden="true"
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) finish();
      }}
    >
      <div
        className={styles.photo}
        style={{ backgroundImage: `url(${JSON.stringify(photoSrc)})` }}
      />
      <div className={styles.veil} />
      <div className={styles.nightVeil} />
    </div>,
    document.body,
  );
}
