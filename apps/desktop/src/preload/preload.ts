import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS } from "../shared/channels.ts";

// Sandboxed preload (contextIsolation, sandbox, no Node). It exposes a frozen, narrow API: no ipcRenderer,
// no event objects, no Node values. Arguments are passed as plain data; main validates everything again.

type Listener = (status: unknown) => void;

const api = Object.freeze({
  /** Current core state as main reports it. */
  status: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.status),
  /** One protocol request to the core. */
  request: (
    method: unknown,
    payload: unknown = null,
    mutation: unknown = false,
  ): Promise<unknown> => ipcRenderer.invoke(CHANNELS.request, { method, mutation, payload }),
  /** Asks main to start the core again after it failed. */
  restartCore: (): Promise<unknown> => ipcRenderer.invoke(CHANNELS.restart),
  /** Subscribes to state changes; returns an unsubscribe function. */
  onStatus: (listener: Listener): (() => void) => {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const wrapped = (_event: unknown, status: unknown) => listener(status);
    ipcRenderer.on(CHANNELS.statusChanged, wrapped);
    return () => void ipcRenderer.removeListener(CHANNELS.statusChanged, wrapped);
  },
});

contextBridge.exposeInMainWorld("citspark", api);
