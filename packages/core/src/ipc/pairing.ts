import { timingSafeEqual } from "node:crypto";
import { ErrorCode, ProtocolException, type Scope } from "@citspark/protocol";
import type { ClientKind } from "./registry.ts";

/** What the desktop pairing dialog shows while it asks for the code that the client displays. */
export interface PairingPrompt {
  readonly clientKind: ClientKind;
  readonly scopes: readonly Scope[];
  readonly expiresAt: number;
}

export type SubmitResult = "ok" | "wrong" | "locked" | "expired";
export type PairingOutcome = "ok" | "locked" | "expired" | "cancelled" | "aborted";

/** Handed to the desktop UI. `submit` takes the code the user typed; `cancel` is the dialog's Cancel. */
export interface PairingDialog {
  submit(code: string): SubmitResult;
  cancel(): void;
}

/** Shows the pairing dialog and returns a function that dismisses it. */
export type PairingPresenter = (prompt: PairingPrompt, dialog: PairingDialog) => () => void;

/**
 * Pairing policy (ADR 0006 step 4, ADR 0011): one pairing at a time; a code is bound to one handshake, is
 * single-use and valid for 2 minutes; 5 wrong codes lock pairing until the desktop user unlocks it.
 */
export class PairingController {
  readonly ttlMs: number;
  readonly maxWrongAttempts: number;
  readonly #present: PairingPresenter | undefined;
  readonly #now: () => number;
  #wrong = 0;
  #locked = false;
  #active: PendingPairing | undefined;

  constructor(
    opts: {
      present?: PairingPresenter;
      ttlMs?: number;
      maxWrongAttempts?: number;
      now?: () => number;
    } = {},
  ) {
    this.#present = opts.present;
    this.ttlMs = opts.ttlMs ?? 120_000;
    this.maxWrongAttempts = opts.maxWrongAttempts ?? 5;
    this.#now = opts.now ?? Date.now;
  }

  get locked(): boolean {
    return this.#locked;
  }

  get pending(): boolean {
    return this.#active !== undefined;
  }

  /** Desktop UI action after a lock. */
  unlock(): void {
    this.#locked = false;
    this.#wrong = 0;
  }

  /** Reserves the single pairing slot. Throws a ProtocolException the server sends as `pair.error`. */
  begin(req: {
    clientKind: ClientKind;
    scopes: readonly Scope[];
    onEnd: (outcome: PairingOutcome) => void;
  }): PendingPairing {
    if (this.#locked) {
      throw new ProtocolException(
        ErrorCode.PairingLocked,
        "Pairing is locked after too many wrong codes. Unlock it in Citspark.",
      );
    }
    if (!this.#present) {
      throw new ProtocolException(ErrorCode.PairingFailed, "Citspark is not ready to pair.");
    }
    if (this.#active) {
      throw new ProtocolException(ErrorCode.PairingFailed, "Another pairing is in progress.");
    }
    const p = new PendingPairing({
      controller: this,
      present: this.#present,
      req,
      now: this.#now,
      ttlMs: this.ttlMs,
    });
    this.#active = p;
    return p;
  }

  /** @internal Returns true when this wrong attempt locked pairing. */
  _recordWrong(): boolean {
    this.#wrong++;
    if (this.#wrong >= this.maxWrongAttempts) this.#locked = true;
    return this.#locked;
  }

  /** @internal */
  _recordSuccess(): void {
    this.#wrong = 0;
  }

  /** @internal */
  _release(p: PendingPairing): void {
    if (this.#active === p) this.#active = undefined;
  }
}

export class PendingPairing {
  readonly expiresAt: number;
  readonly #controller: PairingController;
  readonly #present: PairingPresenter;
  readonly #prompt: PairingPrompt;
  readonly #onEnd: (outcome: PairingOutcome) => void;
  readonly #now: () => number;
  readonly #timer: ReturnType<typeof setTimeout>;
  #code: Buffer | undefined;
  #dismiss: (() => void) | undefined;
  #done = false;

  constructor(o: {
    controller: PairingController;
    present: PairingPresenter;
    req: { clientKind: ClientKind; scopes: readonly Scope[]; onEnd: (o: PairingOutcome) => void };
    now: () => number;
    ttlMs: number;
  }) {
    this.#controller = o.controller;
    this.#present = o.present;
    this.#now = o.now;
    this.#onEnd = o.req.onEnd;
    this.expiresAt = o.now() + o.ttlMs;
    this.#prompt = Object.freeze({
      clientKind: o.req.clientKind,
      scopes: Object.freeze([...o.req.scopes]),
      expiresAt: this.expiresAt,
    });
    this.#timer = setTimeout(() => this.#finish("expired"), o.ttlMs);
    this.#timer.unref?.();
  }

  get done(): boolean {
    return this.#done;
  }

  /** Arms the dialog with the code this side derived from its own handshake. */
  open(code: string): void {
    if (this.#done || this.#code) throw new Error("pairing dialog already opened or finished");
    this.#code = Buffer.from(code, "utf8");
    const dialog: PairingDialog = {
      submit: (typed) => this.#submit(typed),
      cancel: () => this.#finish("cancelled"),
    };
    this.#dismiss = this.#present(this.#prompt, dialog);
  }

  /** The client went away or sent `pair.abort`. */
  abort(): void {
    this.#finish("aborted");
  }

  #submit(typed: string): SubmitResult {
    if (this.#done || !this.#code) return "expired";
    if (this.#now() >= this.expiresAt) {
      this.#finish("expired");
      return "expired";
    }
    const t = Buffer.from(typed.trim(), "utf8");
    if (t.length === this.#code.length && timingSafeEqual(t, this.#code)) {
      this.#controller._recordSuccess();
      this.#finish("ok");
      return "ok";
    }
    if (this.#controller._recordWrong()) {
      this.#finish("locked");
      return "locked";
    }
    return "wrong";
  }

  #finish(outcome: PairingOutcome): void {
    if (this.#done) return;
    this.#done = true;
    clearTimeout(this.#timer);
    this.#code?.fill(0);
    this.#controller._release(this);
    try {
      this.#dismiss?.();
    } finally {
      this.#onEnd(outcome);
    }
  }
}
