"use client";
// The last input decides how the page moves: while the visitor uses the
// keyboard, html[data-input="keyboard"] switches every transition and
// animation off (globals.css), so nothing animates on a keyboard action. A
// modifier key alone (for a shortcut) changes nothing.
import { useEffect } from "react";

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta"]);

export function InputWatcher() {
  useEffect(() => {
    const root = document.documentElement;
    const set = (mode: "keyboard" | "pointer") => {
      if (root.dataset["input"] !== mode) root.dataset["input"] = mode;
    };
    const pointer = () => set("pointer");
    const key = (event: KeyboardEvent) => {
      if (!MODIFIERS.has(event.key)) set("keyboard");
    };
    set("pointer");
    window.addEventListener("pointerdown", pointer, { capture: true, passive: true });
    window.addEventListener("keydown", key, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", pointer, { capture: true });
      window.removeEventListener("keydown", key, { capture: true });
    };
  }, []);
  return null;
}

/** Whether the visitor's last input was a key: an entrance animation is then skipped. */
export function usingKeyboard(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset["input"] === "keyboard";
}
